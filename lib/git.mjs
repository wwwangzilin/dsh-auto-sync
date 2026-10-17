/**
 * A thin git facade over one repository or worktree.
 *
 * @module dsh-auto-sync/lib/git
 */

import { runAsync, runSync, gitEnv } from './exec.mjs';

/**
 * Git commands issued for this repository, rooted at `dir`.
 */
export class Git {
  /**
   * @param {string} dir - repository or worktree root.
   * @param {Record<string, string>} [env] - extra environment for every call.
   */
  constructor(dir, env = {}) {
    this.dir = dir;
    this.env = gitEnv(env);
  }

  /** @returns {string[]} */
  args(args) {
    return ['-C', this.dir, ...args];
  }

  /**
   * @param {string[]} args
   * @returns {Promise<{code: number, out: string, err: string}>}
   */
  async exec(args) {
    return runAsync('git', this.args(args), { env: this.env });
  }

  /**
   * @param {string[]} args
   * @returns {{code: number, out: string, err: string}}
   */
  execSync(args) {
    return runSync('git', this.args(args));
  }

  /** @returns {Promise<string>} the stdout of a successful call, trimmed. */
  async text(args) {
    const result = await this.exec(args);
    return result.code === 0 ? result.out.trim() : '';
  }

  /** @returns {Promise<boolean>} whether the directory is inside a work tree. */
  async isRepo() {
    const result = await this.exec(['rev-parse', '--is-inside-work-tree']);
    return result.code === 0 && result.out.trim() === 'true';
  }

  /** @returns {Promise<string>} the checked-out branch, or '' when detached. */
  async currentBranch() {
    const result = await this.exec(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    return result.code === 0 ? result.out.trim() : '';
  }

  /** @param {string} branch @returns {Promise<boolean>} */
  async hasBranch(branch) {
    const result = await this.exec(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return result.code === 0;
  }

  /** @param {string} remote @returns {Promise<string>} the URL, or '' if absent. */
  async remoteUrl(remote = 'origin') {
    return this.text(['remote', 'get-url', remote]);
  }

  /** @returns {Promise<boolean>} whether the tree has staged or unstaged changes. */
  async isDirty(paths = []) {
    const args = ['status', '--porcelain'];
    if (paths.length > 0) args.push('--', ...paths);
    const result = await this.exec(args);
    return result.code === 0 && result.out.trim() !== '';
  }

  /**
   * Commit everything staged, if anything is staged.
   * @param {string} message
   * @returns {Promise<{committed: boolean, error?: string}>}
   */
  async commitStaged(message) {
    const staged = await this.exec(['diff', '--cached', '--quiet']);
    // Exit 0 means no staged changes; exit 1 means there are some.
    if (staged.code === 0) return { committed: false };
    const commit = await this.exec(['commit', '--no-verify', '-m', message]);
    if (commit.code !== 0) {
      return { committed: false, error: (commit.err || commit.out).trim() };
    }
    return { committed: true };
  }
}

/**
 * Whether `git` can be executed at all, with a message for the user when not.
 *
 * @returns {Promise<{available: boolean, version?: string, reason?: string}>}
 */
export async function probeGit() {
  const result = await runAsync('git', ['--version']);
  if (result.code !== 0) {
    return {
      available: false,
      reason:
        result.err.includes('ENOENT') || result.code === -1
          ? 'git is not installed or not on PATH'
          : (result.err || result.out).trim(),
    };
  }
  return { available: true, version: result.out.trim() };
}
