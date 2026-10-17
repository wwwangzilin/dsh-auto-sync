/**
 * Snapshot line: mirror the home (and the profile's dependency tree) into the
 * `snapshot` branch's worktree, commit, and push.
 *
 * Run detached from the plugin's shutdown hook so the snapshot completes even
 * after DSH exits. It can also be run by hand:
 *
 *   node cold-sync.mjs --home ~/.dsh --worktree ~/.dsh-backup
 *
 * Runs are serialized with a lock file: the timer, the startup catch-up and
 * the shutdown hook can all fire at once, and two runs would otherwise fight
 * over one git index (`index.lock: File exists`).
 *
 * @module dsh-auto-sync/cold-sync
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, STATE_DIR } from './lib/config.mjs';
import { ensureSnapshotIgnores } from './lib/setup.mjs';
import { Git } from './lib/git.mjs';
import { mirrorDirectory, mirrorPackageTree } from './lib/copy.mjs';
import { noteFailure, noteSuccess } from './lib/status.mjs';

/** A lock older than this is treated as abandoned by a crashed run. */
const LOCK_STALE_MS = 60 * 60 * 1000;

/** How many push attempts a branch gets before it is reported as failed. */
const PUSH_ATTEMPTS = 2;

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

const config = loadConfig({
  home: readFlag('--home', undefined),
});
const worktree = readFlag('--worktree', config.worktree);
const home = config.home;

/** @param {string} message */
const log = (message) => {
  // stdout is the trace a person reads when the snapshot breaks; the file copy
  // survives a detached child whose console is gone.
  console.log(`[dsh-auto-sync] ${message}`);
};

/**
 * Take the run lock, or report that another run holds it.
 * @returns {boolean}
 */
function acquireLock() {
  const dir = join(home, STATE_DIR);
  const path = join(dir, '.snapshot.lock');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // The lock below reports the real failure.
  }

  if (existsSync(path)) {
    let held = false;
    try {
      const info = JSON.parse(readFileSync(path, 'utf8'));
      const at = Date.parse(info?.at ?? '');
      held = !Number.isNaN(at) && Date.now() - at < LOCK_STALE_MS;
    } catch {
      held = false;
    }
    if (held) {
      log('another snapshot run is already in progress; skipping');
      return false;
    }
    log('replacing a stale snapshot lock');
    try {
      unlinkSync(path);
    } catch {
      // Racing another process is handled by the exclusive create below.
    }
  }

  try {
    writeFileSync(path, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), {
      encoding: 'utf8',
      flag: 'wx',
    });
    return true;
  } catch {
    log('could not take the snapshot lock; skipping to avoid a concurrent run');
    return false;
  }
}

function releaseLock() {
  try {
    unlinkSync(join(home, STATE_DIR, '.snapshot.lock'));
  } catch {
    // A missing lock is the same as a released one.
  }
}

/**
 * Push `branch`, integrating the remote tip once when it moved underneath us.
 * Conflicts resolve in favour of the local snapshot; a backup branch is never
 * force-pushed.
 *
 * @param {Git} git
 * @param {string} branch
 * @param {string} remote
 * @returns {Promise<{ok: boolean, message: string}>}
 */
async function pushWithRetry(git, branch, remote) {
  let message = '';
  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt += 1) {
    const push = await git.exec(['push', remote, branch]);
    if (push.code === 0) return { ok: true, message: '' };
    message = (push.err || push.out || 'push failed').trim();
    if (attempt === PUSH_ATTEMPTS) break;
    log(`push rejected (attempt ${attempt}); integrating ${remote}/${branch} and retrying`);
    await git.exec(['fetch', remote, branch]);
    const merge = await git.exec(['merge', `${remote}/${branch}`, '--no-edit', '-X', 'ours']);
    if (merge.code !== 0) {
      await git.exec(['merge', '--abort']);
      return { ok: false, message: `${message} | retry merge failed: ${(merge.err || merge.out).trim()}` };
    }
  }
  return { ok: false, message };
}

/** @returns {string} an ISO timestamp safe for a commit message. */
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

async function main() {
  const branch = config.lines.snapshot.branch;
  const git = new Git(home);

  if (!(await git.isRepo())) {
    throw new Error(`no git repository at ${home}; run the first-run setup`);
  }
  if (!existsSync(join(worktree, '.git'))) {
    throw new Error(`no worktree at ${worktree}; run the first-run setup`);
  }
  const work = new Git(worktree);
  const current = await work.currentBranch();
  if (current !== branch) {
    throw new Error(`worktree ${worktree} checks out '${current || '(detached)'}' instead of '${branch}'`);
  }

  // 1. Mirror the home tree. The worktree itself and this plugin's state are
  //    excluded: copying a snapshot into the snapshot would grow without bound.
  const mirror = await mirrorDirectory(home, worktree, {
    excludeNames: ['.git'],
    filter: (rel) => rel !== STATE_DIR && !rel.startsWith('.cache/'),
    onWarn: (message) => log(`home mirror: ${message}`),
  });
  log(`mirrored home (${mirror.copied} copied, ${mirror.skipped} skipped)`);

  // 2. Mirror the profile's dependency manifest, so the snapshot records what
  //    it holds and not only the bytes.
  const { profile, files, includeNodeModules } = config.lines.snapshot;
  const profileDir = join(home, 'profiles', profile);
  if (existsSync(profileDir)) {
    for (const name of files) {
      const from = join(profileDir, name);
      const to = join(worktree, 'profiles', profile, name);
      if (!existsSync(from)) continue;
      try {
        mkdirSync(join(to, '..'), { recursive: true });
        writeFileSync(to, readFileSync(from));
      } catch (error) {
        log(`cannot mirror profile file ${name}: ${error.code ?? error.message}`);
      }
    }
    if (includeNodeModules) {
      const modulesDir = join(profileDir, 'node_modules');
      if (existsSync(modulesDir)) {
        const modules = await mirrorPackageTree(modulesDir, join(worktree, 'profiles', profile, 'node_modules'), {
          onWarn: (message) => log(`node_modules mirror: ${message}`),
        });
        log(`mirrored ${profile}/node_modules (${modules.copied} copied, ${modules.skipped} skipped)`);
      }
    }
  }

  // 3. Keep the branch's own ignore file: the home's rules plus the narrow
  //    re-inclusion of installed dependencies, which the home file excludes
  //    for a working tree but which are the point of a snapshot.
  ensureSnapshotIgnores(worktree, config);

  // 4. Commit, then push.
  await work.exec(['add', '-A']);
  const commit = await work.commitStaged(`dsh snapshot ${stamp()}`);
  if (commit.error) throw new Error(`commit failed: ${commit.error}`);
  log(commit.committed ? 'committed the snapshot' : 'nothing changed to commit');

  const push = await pushWithRetry(work, branch, config.remoteName);
  if (!push.ok) {
    noteFailure(home, 'snapshot', push.message);
    throw new Error(`push failed (the commit stays local): ${push.message}`);
  }
  log(`pushed ${branch}`);
  noteSuccess(home, 'snapshot');
}

if (!acquireLock()) {
  process.exit(0);
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  log(`snapshot failed: ${error?.message ?? error}`);
  noteFailure(home, 'snapshot', error?.message ?? String(error));
} finally {
  releaseLock();
}
process.exit(exitCode);
