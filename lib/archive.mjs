/**
 * Archive construction for the release line.
 *
 * A release backup is one archive published as a downloadable asset, not a git
 * branch: it keeps a full home recoverable without growing repository history
 * by tens of thousands of files per commit, which is what the snapshot line
 * does and what makes it expensive.
 *
 * Two constraints shape this module:
 *
 * 1. **Size.** A home with installed dependencies runs to gigabytes, and a
 *    release asset has a hard per-file limit. Archives are therefore split into
 *    parts with a manifest of their sizes and digests, so any home fits and a
 *    restore can verify what it downloaded.
 * 2. **Secrets.** `.credentials.yaml` holds provider API keys. It is excluded
 *    by default and only included when a person explicitly opts in, because an
 *    archive on a release page is far more exposed than a private branch.
 *
 * @module dsh-auto-sync/lib/archive
 */

import { createReadStream, createWriteStream, existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { runAsync } from './exec.mjs';

/** Files and directories that never belong in a release archive. */
export const DEFAULT_ARCHIVE_EXCLUDES = [
  // Secrets. Opt in explicitly with `includeSecrets`.
  '.credentials.yaml',
  // Repository metadata: the git remote already holds it, and it can be large.
  '.git',
  // This plugin's own state: status and locks describe the backup, not the home.
  'sync-plugin/status.json',
  'sync-plugin/.snapshot.lock',
  '*.log',
  '.DS_Store',
  'Thumbs.db',
  // SQLite sidecars are runtime temporaries.
  'memory/memory.db-shm',
  'memory/memory.db-wal',
];

/**
 * Whether the platform `tar` can be executed.
 *
 * bsdtar ships with Windows 10+, macOS and every mainstream Linux, and it
 * handles the long paths a home backup inevitably contains. Using it keeps this
 * package dependency-free; a missing tar is reported as an actionable error
 * rather than a silent empty archive.
 *
 * @returns {Promise<{available: boolean, version?: string, reason?: string}>}
 */
export async function probeTar() {
  const result = await runAsync('tar', ['--version']);
  if (result.code !== 0) {
    return {
      available: false,
      reason:
        result.code === -1 || /ENOENT/.test(result.err)
          ? 'tar is not installed or not on PATH'
          : (result.err || result.out).trim(),
    };
  }
  const first = result.out.split('\n')[0]?.trim() ?? '';
  return { available: true, version: first };
}

/**
 * Build a gzip-compressed tar of `sourceDir`.
 *
 * @param {object} options
 * @param {string} options.sourceDir - directory to archive.
 * @param {string} options.outFile - absolute path of the archive to write.
 * @param {string[]} [options.excludes] - extra tar exclusion patterns.
 * @param {boolean} [options.includeNodeModules] - include `node_modules` trees.
 * @param {boolean} [options.includeSecrets] - include `.credentials.yaml`.
 * @param {(message: string) => void} [options.onWarn]
 * @returns {Promise<{ok: boolean, path?: string, bytes?: number, error?: string}>}
 */
export async function buildArchive(options) {
  const { sourceDir, outFile } = options;
  const onWarn = options.onWarn ?? (() => {});

  if (!existsSync(sourceDir)) {
    return { ok: false, error: `source directory does not exist: ${sourceDir}` };
  }

  const tar = await probeTar();
  if (!tar.available) {
    return { ok: false, error: `cannot create an archive: ${tar.reason}` };
  }

  await mkdir(dirname(outFile), { recursive: true });
  await rm(outFile, { force: true });

  const excludes = [...DEFAULT_ARCHIVE_EXCLUDES, ...(options.excludes ?? [])];
  if (!options.includeSecrets) {
    // Already in the defaults; kept explicit so the intent survives an edit to
    // the default list.
    if (!excludes.includes('.credentials.yaml')) excludes.push('.credentials.yaml');
  } else {
    // The caller opted in, so drop the exclusion instead of contradicting it.
    const index = excludes.indexOf('.credentials.yaml');
    if (index !== -1) excludes.splice(index, 1);
  }
  if (options.includeNodeModules !== true) excludes.push('node_modules', '*/node_modules/*');

  const args = ['-czf', outFile, '-C', sourceDir];
  for (const pattern of excludes) args.push(`--exclude=${pattern}`);
  args.push('.');

  onWarn(`archiving ${sourceDir} (tar: ${tar.version})`);
  const result = await runAsync('tar', args, { maxBuffer: 32 * 1024 * 1024 });
  if (result.code !== 0) {
    return {
      ok: false,
      error: `tar exited ${result.code}: ${(result.err || result.out).trim().slice(0, 400)}`,
    };
  }

  try {
    const info = statSync(outFile);
    return { ok: true, path: outFile, bytes: info.size };
  } catch (error) {
    return { ok: false, error: `archive was not written: ${error.message}` };
  }
}

/**
 * @param {string} path
 * @returns {Promise<string>} hex sha256 of the file.
 */
export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Split a file into fixed-size parts.
 *
 * Written BY HAND rather than shelling out to `split`, which has incompatible
 * flags between GNU coreutils, bsdtar's bundled tools and macOS, and is absent
 * from a default Windows install. A single-part file is returned as-is so the
 * common case keeps its plain name.
 *
 * @param {string} file - absolute path of the file to split.
 * @param {number} partSize - maximum bytes per part.
 * @returns {Promise<Array<{path: string, bytes: number, sha256: string}>>}
 */
export async function splitFile(file, partSize) {
  const info = await stat(file);
  if (!(partSize > 0)) throw new Error('partSize must be a positive number of bytes');
  if (info.size <= partSize) {
    return [{ path: file, bytes: info.size, sha256: await sha256File(file) }];
  }

  const parts = [];
  const total = Math.ceil(info.size / partSize);
  const read = openSync(file, 'r');
  try {
    for (let index = 0; index < total; index += 1) {
      const offset = index * partSize;
      const length = Math.min(partSize, info.size - offset);
      const partPath = `${file}.part${String(index).padStart(3, '0')}`;
      await new Promise((resolve, reject) => {
        const out = createWriteStream(partPath);
        const buffer = Buffer.alloc(Math.min(length, 4 * 1024 * 1024));
        let written = 0;
        const pump = () => {
          if (written >= length) {
            out.end();
            return;
          }
          const want = Math.min(buffer.length, length - written);
          const got = readSync(read, buffer, 0, want, offset + written);
          if (got <= 0) {
            out.end();
            return;
          }
          written += got;
          if (out.write(Buffer.from(buffer.subarray(0, got)))) setImmediate(pump);
          else out.once('drain', pump);
        };
        out.on('error', reject);
        out.on('finish', resolve);
        pump();
      });
      parts.push({ path: partPath, bytes: length, sha256: await sha256File(partPath) });
    }
  } finally {
    closeSync(read);
  }
  return parts;
}

/**
 * Remove intermediate archive files after publishing.
 *
 * @param {string[]} paths
 */
export async function cleanupFiles(paths) {
  for (const path of paths) {
    try {
      await rm(path, { force: true });
    } catch {
      // A locked file is left for the next run; it is scratch space either way.
    }
  }
}

/**
 * Write a manifest describing an archive upload.
 *
 * The manifest is published alongside the parts so a restore can tell which
 * files belong together, how to reassemble them, and whether a download was
 * corrupted.
 *
 * @param {object} input
 * @param {string} input.home - the archived home.
 * @param {string} input.createdAt - ISO timestamp.
 * @param {string} input.archiveName - base name of the archive.
 * @param {Array<{name: string, bytes: number, sha256: string}>} input.parts
 * @param {object} input.options - the flags the archive was built with.
 * @returns {string} the manifest as JSON text.
 */
export function buildManifest(input) {
  return `${JSON.stringify(
    {
      schema: 'dsh-auto-sync/archive@1',
      createdAt: input.createdAt,
      home: input.home,
      archive: input.archiveName,
      compression: 'gzip',
      format: 'tar',
      partCount: input.parts.length,
      totalBytes: input.parts.reduce((sum, part) => sum + part.bytes, 0),
      parts: input.parts,
      options: input.options,
      restore: [
        'cat <archive>.part* > <archive>   # only when partCount > 1',
        'tar -xzf <archive> -C <target-dir>',
      ],
    },
    null,
    2,
  )}\n`;
}

/** @param {string} dir @returns {Promise<string[]>} file names in a directory. */
export async function listDir(dir) {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** @param {string} path */
export function archiveBaseName(path) {
  return basename(path);
}
