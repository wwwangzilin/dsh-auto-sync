/**
 * Workspace line: mirror one project directory into its own branch.
 *
 * This line exists because a home backup protects DSH's own state, not the
 * code a person was working on when DSH wrote it. Point `source` at a project
 * root and every snapshot run also versions that project.
 *
 *   node workspace-sync.mjs --source D:/projects/app
 *
 * Exclusions default to `.git`, build output and dependency caches; the
 * configured `exclude` list replaces them entirely.
 *
 * @module dsh-auto-sync/workspace-sync
 */

import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig, STATE_DIR } from './lib/config.mjs';
import { Git } from './lib/git.mjs';
import { isInside, mirrorDirectory } from './lib/copy.mjs';
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

const config = loadConfig({ home: readFlag('--home', undefined) });
const source = readFlag('--source', config.lines.workspace.source);
const home = config.home;

/** @param {string} message */
const log = (message) => {
  console.log(`[dsh-auto-sync/workspace] ${message}`);
};

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/**
 * @param {string} branch
 * @returns {string} the worktree directory for that branch.
 */
const worktreeFor = (branch) => `${config.worktree}-workspace`;
async function main() {
  if (source === '') {
    log('workspace line is enabled but "lines.workspace.source" is empty; skipping');
    return;
  }
  if (!existsSync(resolve(source))) {
    throw new Error(`workspace source ${source} does not exist`);
  }

  const branch = config.lines.workspace.branch;
  const dir = worktreeFor(branch);
  if (!existsSync(join(dir, '.git'))) {
    // First use of an enabled line: create the branch and its worktree now
    // rather than waiting for a restart, so enabling the line just works.
    const homeGit = new Git(home);
    if (!(await homeGit.hasBranch(branch))) {
      const created = await homeGit.exec(['branch', branch, 'HEAD']);
      if (created.code !== 0) {
        throw new Error(`could not create branch ${branch}: ${(created.err || created.out).trim()}`);
      }
      log(`created branch ${branch}`);
    }
    const added = await homeGit.exec(['worktree', 'add', dir, branch]);
    if (added.code !== 0) {
      throw new Error(`could not create worktree ${dir}: ${(added.err || added.out).trim()}`);
    }
    log(`created the workspace worktree ${dir}`);
  }

  const work = new Git(dir);
  const current = await work.currentBranch();
  if (current !== branch) {
    throw new Error(`worktree ${dir} checks out '${current || '(detached)'}' instead of '${branch}'`);
  }

  const resolvedSource = resolve(source);
  if (isInside(resolvedSource, resolve(dir))) {
    throw new Error(`the worktree ${dir} is inside the workspace source ${resolvedSource}`);
  }

  const mirror = await mirrorDirectory(resolvedSource, dir, {
    excludeNames: config.lines.workspace.exclude,
    filter: (rel) => !rel.startsWith(`${STATE_DIR}/`),
    onWarn: (message) => log(`mirror: ${message}`),
  });
  log(`mirrored ${resolvedSource} (${mirror.copied} copied, ${mirror.skipped} skipped)`);

  // A worktree can hold files this line never mirrored: the branch was created
  // from the home's history, and `git add -A` would carry those along into the
  // workspace backup. Remove the plugin's own state from both the index and the
  // worktree, and keep the rule in place for later runs.
  try {
    writeFileSync(
      join(dir, '.gitignore'),
      `\n# ---- dsh-auto-sync: this plugin's own state never belongs in the backup ----\n/${STATE_DIR}/\n`,
      { encoding: 'utf8', flag: 'a' },
    );
    await work.exec(['rm', '-r', '-f', '--ignore-unmatch', '--quiet', '--', STATE_DIR]);
  } catch (error) {
    log(`could not exclude ${STATE_DIR} from the branch: ${error.message}`);
  }

  await work.exec(['add', '-A']);
  const commit = await work.commitStaged(`dsh workspace ${stamp()}`);
  if (commit.error) throw new Error(`commit failed: ${commit.error}`);
  log(commit.committed ? 'committed the workspace' : 'nothing changed to commit');

  let message = '';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const push = await work.exec(['push', config.remoteName, branch]);
    if (push.code === 0) {
      log(`pushed ${branch}`);
      noteSuccess(home, 'workspace');
      return;
    }
    message = (push.err || push.out || 'push failed').trim();
    if (attempt === 2) break;
    log(`push rejected (attempt ${attempt}); integrating ${config.remoteName}/${branch} and retrying`);
    await work.exec(['fetch', config.remoteName, branch]);
    const merge = await work.exec(['merge', `${config.remoteName}/${branch}`, '--no-edit', '-X', 'ours']);
    if (merge.code !== 0) {
      await work.exec(['merge', '--abort']);
      message = `${message} | retry merge failed: ${(merge.err || merge.out).trim()}`;
      break;
    }
  }
  throw new Error(`push failed (the commit stays local): ${message}`);
}

try {
  await main();
} catch (error) {
  log(`workspace sync failed: ${error?.message ?? error}`);
  noteFailure(home, 'workspace', error?.message ?? String(error));
  process.exitCode = 1;
}
