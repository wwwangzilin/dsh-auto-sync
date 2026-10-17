/**
 * First-run setup: turn a DSH home into a git-backed, versioned backup.
 *
 * Three states are handled, in this order:
 *
 * 1. **Home is already a repository with a remote** — the person already keeps
 *    their home in git (this is how DSH users commonly work). Nothing is
 *    initialised or reconfigured; only the plugin's own worktrees and ignore
 *    rules are added, so an existing setup is adopted rather than replaced.
 * 2. **Home is a repository without a remote** — the configured `remote` is
 *    attached as a new remote instead of `origin`.
 * 3. **Home is not a repository** — it is initialised, the ignore file is
 *    written, and `remote` is added. A remote is required here: without a URL
 *    a local-only repository makes backups look healthy while protecting
 *    nothing off the machine.
 *
 * @module dsh-auto-sync/lib/setup
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Git } from './git.mjs';
import { STATE_DIR } from './config.mjs';
import { isInside } from './copy.mjs';

/**
 * Lines the default ignore file must always keep out of a home backup.
 * `.credentials.yaml` holds API keys; the rest are build artifacts, runtime
 * temporaries and this plugin's own state.
 */
export const REQUIRED_IGNORES = [
  '.credentials.yaml',
  '**/node_modules/',
  '*.log',
  '.DS_Store',
  'Thumbs.db',
  `${STATE_DIR}/.sync-status.json`,
  'memory/memory.db-shm',
  'memory/memory.db-wal',
];

/**
 * @typedef {object} SetupResult
 * @property {'already-configured'|'adopted-existing-repo'|'initialised'} mode
 * @property {boolean} ok
 * @property {string} remoteName
 * @property {string} [branch]
 * @property {string[]} actions
 * @property {string[]} warnings
 * @property {string} [error]
 */

/**
 * Whether an existing remote URL points at the same repository as `remote`.
 * Compared loosely (scheme, userinfo, `.git` suffix and trailing slashes
 * stripped) because SSH and HTTPS spellings of one repository differ.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameRemote(a, b) {
  const norm = (url) => {
    let out = url.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
    out = out.replace(/^[a-z+]+:\/\//i, '');
    out = out.replace(/^[^@/]+@/, '');
    out = out.replace(/^([^/:]+):(?!\d+\/)/, '$1/');
    return out.toLowerCase();
  };
  return norm(a) === norm(b);
}

/**
 * Read the ignore file, if any.
 * @param {string} path
 * @returns {string}
 */
function readIgnore(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/**
 * Append the required ignore rules that are not yet present.
 *
 * @param {string} home
 * @param {string} ignoreFile - absolute path of the ignore file to maintain.
 * @param {string[]} extra - user-configured patterns.
 * @returns {string[]} the patterns that were added.
 */
export function ensureIgnores(home, ignoreFile, extra = []) {
  const current = readIgnore(ignoreFile);
  const lines = new Set(
    current
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#')),
  );
  // Dedupe while keeping the required rules first: a user pattern already
  // listed in the required set must not be written twice.
  const wanted = [...new Set([...REQUIRED_IGNORES, ...extra])];
  const missing = wanted.filter((pattern) => !lines.has(pattern));
  if (missing.length === 0) return [];

  const block = [
    '',
    '# ---- dsh-auto-sync: never back these up ----',
    ...missing,
    '',
  ].join('\n');
  writeFileSync(ignoreFile, `${current.replace(/\s*$/, '')}\n${block}`, 'utf8');
  return missing;
}

/**
 * Re-allow published dependencies inside the snapshot branch.
 *
 * The home ignore file excludes every `node_modules` directory, which is right
 * for a working tree and wrong for a snapshot of installed dependencies. The
 * snapshot branch therefore keeps its own ignore file: the home's rules plus a
 * narrow re-inclusion of the configured profile's dependency tree. It is
 * rewritten on every run because a merge with `main` can bring back the
 * excluding version.
 *
 * @param {string} worktree - the snapshot worktree root.
 * @param {import('./config.mjs').SyncConfig} config
 * @returns {string[]} the re-inclusion rules written.
 */
export function ensureSnapshotIgnores(worktree, config) {
  const homeIgnore = join(config.home, '.gitignore');
  const base = readIgnore(homeIgnore).replace(/\s*$/, '');
  const { profile, includeNodeModules, nodeModulesPath } = config.lines.snapshot;
  const rules = includeNodeModules
    ? [
        '',
        '# ---- dsh-auto-sync: the snapshot keeps installed dependencies ----',
        `!profiles/${profile}/${nodeModulesPath}/`,
        `!profiles/${profile}/${nodeModulesPath}/**`,
        '',
      ]
    : ['', '# ---- dsh-auto-sync: dependencies are not part of this snapshot ----', ''];
  writeFileSync(join(worktree, '.gitignore'), `${base}\n${rules.join('\n')}`, 'utf8');
  return rules;
}

/**
 * Configure a repository for unattended commits.
 * A person's global git identity is respected when present; the fallback keeps
 * commits from failing on a machine that never set one.
 *
 * @param {string} dir
 * @param {{userName: string, userEmail: string}} config
 * @returns {Promise<void>}
 */
async function ensureCommitIdentity(dir, config) {
  const git = new Git(dir);
  const name = await git.text(['config', '--get', 'user.name']);
  const email = await git.text(['config', '--get', 'user.email']);
  if (name === '') await git.exec(['config', 'user.name', config.userName]);
  if (email === '') await git.exec(['config', 'user.email', config.userEmail]);
}

/**
 * Create the branch `branch` in `dir` if it does not exist yet.
 *
 * @param {Git} git
 * @param {string} branch
 * @param {string} from - the ref to start from.
 * @returns {Promise<boolean>} whether the branch was created.
 */
async function ensureBranch(git, branch, from) {
  if (await git.hasBranch(branch)) return false;
  const created = await git.exec(['branch', branch, from]);
  return created.code === 0;
}

/**
 * Ensure a worktree at `path` checks out `branch`.
 *
 * A path that already holds a worktree of `branch` is left alone; a path that
 * holds some other branch's worktree is refused rather than adopted, because
 * committing one branch's content into another is how snapshots get destroyed.
 *
 * @param {Git} git
 * @param {string} branch
 * @param {string} path
 * @returns {Promise<{ok: boolean, created: boolean, error?: string}>}
 */
async function ensureWorktree(git, branch, path) {
  if (existsSync(join(path, '.git'))) {
    const existing = new Git(path);
    const current = await existing.currentBranch();
    if (current === branch) return { ok: true, created: false };
    return {
      ok: false,
      created: false,
      error: `${path} already checks out '${current || '(detached)'}', not '${branch}'; move or remove it, or set a different worktree in the config`,
    };
  }
  const added = await git.exec(['worktree', 'add', path, branch]);
  if (added.code === 0) return { ok: true, created: true };
  return { ok: false, created: false, error: (added.err || added.out).trim() };
}

/**
 * Run setup. Safe to call on every start: every step is idempotent and an
 * already-configured home is reported and left alone.
 *
 * @param {import('./config.mjs').SyncConfig} config
 * @param {(message: string) => void} [warn]
 * @returns {Promise<SetupResult>}
 */
export async function setup(config, warn = () => {}) {
  const { home, remote, remoteName, worktree } = config;
  const actions = [];
  const warnings = [];

  const git = new Git(home);

  // State before touching anything: whether this home already carried its own
  // history is what tells "adopted" apart from "initialised".
  const wasRepo = await git.isRepo();
  const hadCommits = wasRepo && (await git.exec(['rev-parse', '--verify', '--quiet', 'HEAD'])).code === 0;
  const existingOriginBefore = wasRepo ? await git.remoteUrl('origin') : '';

  if (!wasRepo && remote === '') {
    return {
      mode: 'initialised',
      ok: false,
      remoteName,
      actions,
      warnings,
      error: `no git repository at ${home} and no 'remote' configured; set "remote" in ${config.configPath} to your private repository URL`,
    };
  }

  if (isInside(home, worktree)) {
    return {
      mode: 'initialised',
      ok: false,
      remoteName,
      actions,
      warnings,
      error: `the worktree ${worktree} is inside the home ${home}; it would be committed into its own snapshot`,
    };
  }

  // A home that already had history and a remote keeps both: this plugin is a
  // guest in that repository, not its owner.
  let mode = hadCommits && existingOriginBefore !== '' ? 'adopted-existing-repo' : 'already-configured';

  if (!wasRepo) {
    const init = await git.exec(['init']);
    if (init.code !== 0) {
      return {
        mode: 'initialised',
        ok: false,
        remoteName,
        actions,
        warnings,
        error: `git init failed in ${home}: ${(init.err || init.out).trim()}`,
      };
    }
    actions.push(`initialised a git repository in ${home}`);
    mode = 'initialised';
  }

  // Remote handling: attach only what is missing. An adopted repository keeps
  // the remote it already had, even when the config names something else; the
  // mismatch is reported rather than silently rewritten.
  const existingOrigin = await git.remoteUrl('origin');
  if (remote !== '') {
    if (existingOrigin !== '' && sameRemote(existingOrigin, remote)) {
      // Already the intended remote; nothing to do.
    } else {
      const targetName = existingOrigin === '' ? 'origin' : remoteName;
      const current = await git.remoteUrl(targetName);
      if (current === '') {
        const added = await git.exec(['remote', 'add', targetName, remote]);
        if (added.code !== 0) {
          warnings.push(`could not add remote ${targetName}: ${(added.err || added.out).trim()}`);
        } else {
          actions.push(`added remote ${targetName} -> ${remote}`);
        }
      } else if (!sameRemote(current, remote)) {
        warnings.push(
          `remote ${targetName} points at ${current}, but the config names ${remote}; keeping ${targetName} unchanged`,
        );
      }
    }
  }

  const configuredName = (await git.remoteUrl(remoteName)) !== '' ? remoteName : 'origin';

  await ensureCommitIdentity(home, config);

  // The ignore file belongs to the repository's toplevel, so a home nested
  // inside a larger repository writes to the right place.
  const topLevel = (await git.text(['rev-parse', '--show-toplevel'])) || home;
  const ignoreFile = join(topLevel, '.gitignore');
  try {
    const added = ensureIgnores(home, ignoreFile, config.exclude);
    if (added.length > 0) actions.push(`ignored ${added.length} pattern(s) in ${ignoreFile}`);
  } catch (error) {
    warnings.push(`could not update ${ignoreFile}: ${error.message}`);
  }

  // Base commit: a repository with no commits has no ref for worktrees to
  // start from. Empty commits are recorded so the ignore rules travel with
  // the backup.
  const hasHead = (await git.exec(['rev-parse', '--verify', '--quiet', 'HEAD'])).code === 0;
  if (!hasHead) {
    await git.exec(['add', '--', '.gitignore']);
    await git.exec(['commit', '--no-verify', '--allow-empty', '-m', 'dsh-auto-sync: initialise backup']);
    actions.push('created the initial commit');
  }

  const head = (await git.text(['rev-parse', 'HEAD'])) || 'HEAD';

  // One branch per enabled line.
  for (const [line, branch] of Object.entries({
    hot: config.lines.hot.enabled ? config.lines.hot.branch : '',
    snapshot: config.lines.snapshot.enabled ? config.lines.snapshot.branch : '',
    workspace: config.lines.workspace.enabled ? config.lines.workspace.branch : '',
  })) {
    if (branch === '') continue;
    const created = await ensureBranch(git, branch, head);
    if (created) actions.push(`created branch ${branch} for the ${line} line`);
  }

  // hot and snapshot share one worktree only when one of them is off;
  // otherwise each line gets its own directory so a snapshot commit never
  // races a hot commit over one index.
  /** @type {Record<string, string>} */
  const worktrees = {};
  const lineDirs = new Map();
  if (config.lines.hot.enabled && config.lines.snapshot.enabled) {
    lineDirs.set('hot', `${worktree}-hot`);
    lineDirs.set('snapshot', worktree);
  } else if (config.lines.hot.enabled) {
    lineDirs.set('hot', worktree);
  } else if (config.lines.snapshot.enabled) {
    lineDirs.set('snapshot', worktree);
  }

  for (const [line, dir] of lineDirs) {
    const branch = line === 'hot' ? config.lines.hot.branch : config.lines.snapshot.branch;
    const result = await ensureWorktree(git, branch, dir);
    if (!result.ok) {
      warnings.push(result.error ?? `could not create the ${line} worktree`);
      continue;
    }
    if (result.created) actions.push(`created the ${line} worktree ${dir} (branch ${branch})`);
    worktrees[line] = dir;
  }

  // The workspace line gets its own directory whenever it is enabled with a
  // source, so a project mirror never shares an index with a home commit.
  if (config.lines.workspace.enabled && config.lines.workspace.source !== '') {
    const dir = `${worktree}-workspace`;
    const result = await ensureWorktree(git, config.lines.workspace.branch, dir);
    if (!result.ok) {
      warnings.push(result.error ?? 'could not create the workspace worktree');
    } else {
      if (result.created) {
        actions.push(`created the workspace worktree ${dir} (branch ${config.lines.workspace.branch})`);
      }
      worktrees.workspace = dir;
    }
  } else if (config.lines.workspace.enabled) {
    warnings.push('the workspace line is enabled but has no "source"; it stays idle until one is set');
  }

  // Point each branch at its remote so a detached run can push without
  // spelling out the refspec, and allow long snapshot paths on Windows.
  for (const branch of [
    config.lines.hot.enabled ? config.lines.hot.branch : '',
    config.lines.snapshot.enabled ? config.lines.snapshot.branch : '',
  ]) {
    if (branch === '') continue;
    await git.exec(['config', `branch.${branch}.remote`, configuredName]);
    await git.exec(['config', `branch.${branch}.merge`, `refs/heads/${branch}`]);
  }
  await git.exec(['config', 'core.longpaths', 'true']);

  for (const warning of warnings) warn(warning);

  return {
    mode,
    ok: true,
    remoteName: configuredName,
    actions,
    warnings,
    worktrees,
  };
}
