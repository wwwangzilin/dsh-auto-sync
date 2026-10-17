/**
 * Cross-platform directory mirroring.
 *
 * Replaces the Windows-only `robocopy` call the original script relied on.
 * Node's own `fs.cp` covers the same ground, but two of robocopy's switches
 * had no direct equivalent and are reproduced here because the snapshot is
 * unusable without them:
 *
 * - `/XJ` (do not follow junctions): a pnpm store links packages into each
 *   other, and following the cycle (cordis <-> cordis-plugin-include) recurses
 *   until the OS path limit, which then makes `git add` fail with
 *   "Filename too long" while the snapshot silently stays stale. Symlinks and
 *   junctions are therefore copied as links, never followed.
 * - `/XD` (skip directories by name): build output, caches and nested `.git`
 *   directories are excluded, the last because a copied `.git` turns the
 *   directory into a submodule and git refuses to track its contents.
 *
 * @module dsh-auto-sync/lib/copy
 */

import { copyFile, lstat, mkdir, readdir, readlink, symlink } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

/**
 * @typedef {object} MirrorOptions
 * @property {string[]} [excludeNames] - directory or file names to skip anywhere in the tree.
 * @property {(relativePath: string) => boolean} [filter] - extra per-entry predicate.
 * @property {(message: string) => void} [onWarn] - sink for skipped entries.
 */

/**
 * @param {string} name
 * @returns {boolean} whether the name is a link-like entry we must not follow.
 */
function isLinkLike(stats) {
  return stats.isSymbolicLink();
}

/**
 * Recursively mirror `source` into `destination`.
 *
 * Existing files are overwritten; entries missing from `source` are left in
 * place, because the destination is a git worktree whose extra files belong to
 * another branch and are the caller's to manage.
 *
 * @param {string} source - absolute source directory.
 * @param {string} destination - absolute destination directory.
 * @param {MirrorOptions} [options]
 * @returns {Promise<{copied: number, skipped: number}>}
 */
export async function mirrorDirectory(source, destination, options = {}) {
  const excludeNames = new Set(options.excludeNames ?? []);
  const counts = { copied: 0, skipped: 0 };
  const warn = options.onWarn ?? (() => {});

  /**
   * @param {string} from
   * @param {string} to
   */
  async function walk(from, to) {
    let entries;
    try {
      entries = await readdir(from, { withFileTypes: true });
    } catch (error) {
      warn(`cannot read ${from}: ${error.code ?? error.message}`);
      return;
    }
    await mkdir(to, { recursive: true });

    for (const entry of entries) {
      const fromPath = join(from, entry.name);
      const toPath = join(to, entry.name);
      const rel = relative(source, fromPath).split('\\').join('/');

      if (excludeNames.has(entry.name)) {
        counts.skipped += 1;
        continue;
      }
      if (options.filter && !options.filter(rel)) {
        counts.skipped += 1;
        continue;
      }

      if (isLinkLike(entry) || entry.isSymbolicLink()) {
        // Preserve the link without resolving it (robocopy's /XJ).
        try {
          const target = await readlink(fromPath);
          await mkdir(join(toPath, '..'), { recursive: true });
          const type = process.platform === 'win32' ? 'junction' : undefined;
          await symlink(target, toPath, type);
          counts.copied += 1;
        } catch (error) {
          warn(`cannot link ${rel}: ${error.code ?? error.message}`);
          counts.skipped += 1;
        }
        continue;
      }

      if (entry.isDirectory()) {
        await walk(fromPath, toPath);
        continue;
      }

      if (entry.isFile()) {
        try {
          await copyFile(fromPath, toPath);
          counts.copied += 1;
        } catch (error) {
          warn(`cannot copy ${rel}: ${error.code ?? error.message}`);
          counts.skipped += 1;
        }
        continue;
      }

      // Sockets, FIFOs and devices have no place in a backup.
      counts.skipped += 1;
    }
  }

  await walk(source, destination);
  return counts;
}

/**
 * Mirror a single package tree, refusing to follow links and skipping nested
 * repositories and build output.
 *
 * @param {string} source
 * @param {string} destination
 * @param {{onWarn?: (message: string) => void}} [options]
 * @returns {Promise<{copied: number, skipped: number}>}
 */
export function mirrorPackageTree(source, destination, options = {}) {
  return mirrorDirectory(source, destination, {
    excludeNames: ['.git'],
    onWarn: options.onWarn,
  });
}

/**
 * Whether `child` is inside `parent` (used to keep a worktree out of its own
 * mirror, which would otherwise copy the previous snapshot into itself).
 *
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
export function isInside(parent, child) {
  const from = resolve(parent);
  const to = resolve(child);
  const rel = relative(from, to);
  return rel !== '' && !rel.startsWith('..') && !rel.includes(':');
}

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
export async function existsAsync(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
