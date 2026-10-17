/**
 * Release line: pack the home into an archive and publish it as a release asset.
 *
 * Why a second full-backup mechanism exists alongside `snapshot`:
 *
 * - The snapshot line is a git branch, so every version it keeps is paid for
 *   again in repository history. A home with installed dependencies runs to
 *   tens of thousands of files per commit.
 * - A release holds one self-contained archive per backup. Restoring needs no
 *   plugin and no git: download, decompress into place. Keeping five is
 *   affordable; keeping five hundred snapshot commits is not.
 *
 * Usage:
 *   node release-backup.mjs [--home <dir>] [--dry-run]
 *
 * `--dry-run` builds and splits the archive, then reports what it would upload
 * without touching the network — the fastest way to find out whether a home
 * fits and how long a real run would take.
 *
 * @module dsh-auto-sync/release-backup
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { loadConfig } from './lib/config.mjs';
import { buildArchive, buildManifest, cleanupFiles, sha256File, splitFile } from './lib/archive.mjs';
import {
  ensureRelease,
  parseRepo,
  probeGh,
  pruneReleases,
  pruneViaGh,
  publishViaGh,
  resolveToken,
  tagFor,
  uploadAsset,
} from './lib/release.mjs';
import { noteFailure, noteSuccess } from './lib/status.mjs';

const args = process.argv.slice(2);
/**
 * @param {string} flag
 * @param {string} fallback
 * @returns {string}
 */
const readFlag = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index !== -1 && args[index + 1] ? args[index + 1] : fallback;
};
const DRY_RUN = args.includes('--dry-run');

const config = loadConfig({ home: readFlag('--home', undefined) });
const home = config.home;
const line = config.lines.release;

/** @param {string} message */
const log = (message) => {
  console.log(`[dsh-auto-sync/release] ${message}`);
};

/**
 * Resolve the repository that hosts the releases.
 *
 * An explicit `lines.release.repo` wins. Otherwise the git remote of the home
 * is used, which means a person who already backs up to a private repository
 * gets releases on that same repository without naming it twice.
 *
 * @returns {Promise<string>} `owner/name`, or '' when undeterminable.
 */
async function resolveRepo() {
  if (typeof line.repo === 'string' && line.repo.trim() !== '') return line.repo.trim();
  // Derive from the origin URL: https://host/owner/name(.git) or git@host:owner/name(.git).
  const { Git } = await import('./lib/git.mjs');
  const url = await new Git(home).remoteUrl('origin');
  if (url === '') return '';
  const match = /[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  return match === null ? '' : `${match[1]}/${match[2]}`;
}

async function main() {
  // `--dry-run` deliberately ignores `enabled`: checking size, exclusions and
  // part count is exactly how a person decides whether to switch the line on,
  // so requiring it to be enabled first would invert the useful order.
  if (!line.enabled && !DRY_RUN) {
    log('the release line is disabled; nothing to do');
    return;
  }
  if (!line.enabled) log('the release line is disabled; this dry run still builds the archive');

  const repo = await resolveRepo();
  if (parseRepo(repo) === null) {
    throw new Error(
      `cannot determine the release repository: set "lines.release.repo" to "owner/name" (got "${repo}")`,
    );
  }

  // Transport: prefer the GitHub CLI. It already holds the person's credentials
  // and its own TLS trust, which matters on a machine behind a TLS-intercepting
  // proxy where Node's fetch fails with UNABLE_TO_VERIFY_LEAF_SIGNATURE. The
  // REST path remains for CI, where a token is all there is.
  const gh = DRY_RUN ? { available: false } : await probeGh();
  const transport = gh.available ? 'gh' : 'rest';

  let token = '';
  if (!DRY_RUN && transport === 'rest') {
    const resolved = await resolveToken(line.tokenEnv);
    if (resolved.token === undefined) throw new Error(resolved.reason);
    token = resolved.token;
    log(`token from ${resolved.source}`);
  }
  if (!DRY_RUN) log(`transport: ${transport === 'gh' ? gh.version ?? 'gh' : 'GitHub REST API'}`);

  // Scratch space outside the home: an archive written inside the tree it
  // archives would try to include itself.
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-auto-sync-release-'));
  const createdAt = new Date();
  const tag = tagFor(line.tagPrefix, createdAt);
  const archiveName = `${tag}.tar.gz`;
  const archivePath = join(scratch, archiveName);

  try {
    log(`archiving ${home} (node_modules: ${line.includeNodeModules ? 'included' : 'excluded'})`);
    const archive = await buildArchive({
      sourceDir: home,
      outFile: archivePath,
      includeNodeModules: line.includeNodeModules,
      includeSecrets: line.includeSecrets,
      onWarn: log,
    });
    if (!archive.ok) throw new Error(archive.error ?? 'archive failed');
    log(`archive built: ${(archive.bytes / 1024 / 1024).toFixed(1)} MiB`);

    const parts = await splitFile(archivePath, line.partSizeBytes);
    log(`split into ${parts.length} part(s)`);

    // The manifest travels with the parts so a restore can reassemble and verify
    // them without this plugin.
    const manifestPath = join(scratch, `${archiveName}.manifest.json`);
    const manifest = buildManifest({
      home,
      createdAt: createdAt.toISOString(),
      archiveName,
      parts: parts.map((part) => ({
        name: basename(part.path),
        bytes: part.bytes,
        sha256: part.sha256,
      })),
      options: {
        includeNodeModules: line.includeNodeModules,
        includeSecrets: line.includeSecrets,
      },
    });
    await writeFile(manifestPath, manifest, 'utf8');
    const manifestDigest = await sha256File(manifestPath);

    if (DRY_RUN) {
      log('dry run: nothing was uploaded');
      for (const part of parts) {
        log(`  would upload ${basename(part.path)} (${(part.bytes / 1024 / 1024).toFixed(1)} MiB)`);
      }
      log(`  would upload ${basename(manifestPath)} (sha256 ${manifestDigest.slice(0, 16)}…)`);
      log(`  would create release ${tag} on ${repo}, keeping ${line.keep}`);
      return;
    }

    const title = `DSH home backup ${createdAt.toISOString()}`;
    const body = [
      `Full backup of \`${home}\`.`,
      '',
      `- parts: ${parts.length}`,
      `- created: ${createdAt.toISOString()}`,
      `- dependencies: ${line.includeNodeModules ? 'included' : 'excluded'}`,
      `- secrets: ${line.includeSecrets ? '**included**' : 'excluded'}`,
      '',
      'Restore: download every asset named in the manifest, concatenate the parts, then `tar -xzf`.',
    ].join('\n');
    const files = [...parts.map((part) => part.path), manifestPath];

    if (transport === 'gh') {
      const published = await publishViaGh({ repo, tag, title, body, files });
      if (!published.ok) throw new Error(`gh release create failed: ${published.error}`);
      log(`release ${tag} published with ${files.length} asset(s)`);

      if (line.keep > 0) {
        const pruned = await pruneViaGh({ repo, tagPrefix: line.tagPrefix, keep: line.keep });
        if (!pruned.ok) log(`pruning failed (older releases kept): ${pruned.error}`);
        else if (pruned.deleted.length > 0) log(`pruned ${pruned.deleted.length} old release(s)`);
      }
    } else {
      const release = await ensureRelease({ apiBase: line.apiBase, token, repo, tag, title, body });
      if (!release.ok) throw new Error(`could not create the release: ${release.error}`);
      log(`release ${tag} ready (id ${release.id})`);

      for (const part of parts) {
        const uploaded = await uploadAsset({
          apiBase: line.apiBase,
          token,
          repo,
          releaseId: release.id,
          file: part.path,
          contentType: 'application/gzip',
        });
        if (!uploaded.ok) throw new Error(`uploading ${basename(part.path)} failed: ${uploaded.error}`);
        log(`uploaded ${uploaded.name}`);
      }
      const manifestUpload = await uploadAsset({
        apiBase: line.apiBase,
        token,
        repo,
        releaseId: release.id,
        file: manifestPath,
        contentType: 'application/json',
      });
      if (!manifestUpload.ok) throw new Error(`uploading the manifest failed: ${manifestUpload.error}`);
      log(`uploaded ${manifestUpload.name}`);

      if (line.keep > 0) {
        const pruned = await pruneReleases({
          apiBase: line.apiBase,
          token,
          repo,
          tagPrefix: line.tagPrefix,
          keep: line.keep,
        });
        if (!pruned.ok) log(`pruning failed (older releases kept): ${pruned.error}`);
        else if (pruned.deleted.length > 0) log(`pruned ${pruned.deleted.length} old release(s)`);
      }
    }

    noteSuccess(home, 'release');
    log('release backup complete');
  } finally {
    await cleanupFiles([archivePath, ...(await listParts(scratch))]);
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/** @param {string} dir @returns {Promise<string[]>} */
async function listParts(dir) {
  const { readdir } = await import('node:fs/promises');
  try {
    const names = await readdir(dir);
    return names.map((name) => join(dir, name));
  } catch {
    return [];
  }
}

try {
  await main();
} catch (error) {
  log(`release backup failed: ${error?.message ?? error}`);
  noteFailure(home, 'release', error?.message ?? String(error));
  process.exitCode = 1;
}
