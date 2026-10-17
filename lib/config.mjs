/**
 * Configuration: defaults, loading, and the first-run template.
 *
 * The plugin works with zero configuration up to the point of pushing: it
 * needs a repository URL, and everything else has a safe default. Config is
 * read from, in order of precedence:
 *
 *   1. the Cordis entry's `config` (the profile's `cordis.patch.yml`),
 *   2. `<home>/sync-plugin/config.json` (portable, survives DSH upgrades),
 *   3. built-in defaults.
 *
 * The file layer exists because a profile patch is rewritten by the plugin
 * manager and is easy to lose; a plain JSON file is inspectable, diffable and
 * travels with the home it backs up.
 *
 * @module dsh-auto-sync/lib/config
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Directory (under the home) holding this plugin's own state. */
export const STATE_DIR = 'sync-plugin';

/** Filename of the config file inside {@link STATE_DIR}. */
export const CONFIG_FILE = 'config.json';

/** Default remote worktree suffix: `~/.dsh` -> `~/.dsh-backup-desktop` here. */
const WORKTREE_SUFFIX = '-backup';

/**
 * The three backup lines this plugin can maintain.
 * - `hot`: small, frequently changing state, committed on every turn end.
 * - `snapshot`: the full home tree including installed dependencies.
 * - `workspace`: one project directory mirrored to its own branch.
 */
const DEFAULT_LINES = {
  hot: {
    enabled: true,
    branch: 'dsh-hot',
    debounceMs: 30_000,
    intervalMs: 15 * 60 * 1000,
    paths: ['.sync-status.json'],
  },
  snapshot: {
    enabled: true,
    branch: 'dsh-snapshot',
    intervalMs: 24 * 60 * 60 * 1000,
    includeNodeModules: true,
    profile: 'desktop',
    // Dependencies inside the snapshot are re-included by writing a branch-local
    // ignore file (see ensureSnapshotIgnores); the line needs the directory name
    // to know which tree to un-ignore.
    nodeModulesPath: 'node_modules',
    files: [
      'package.json',
      'cordis.patch.yml',
      'cordis.yml',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'package.json.lock',
      'compatibility.json',
    ],
  },
  workspace: {
    enabled: true,
    branch: 'dsh-workspace',
    // Empty means "not configured"; the workspace line stays off until a
    // directory is named, rather than mirroring the process working directory
    // (which, inside a desktop app, is the installation directory).
    source: '',
    exclude: ['.git', 'node_modules', 'dist', 'build', 'target', '.cache'],
  },
};

/**
 * @typedef {object} SyncConfig
 * @property {string} home
 * @property {string} remote
 * @property {string} remoteName
 * @property {string} worktree
 * @property {string} userName
 * @property {string} userEmail
 * @property {string[]} exclude
 * @property {boolean} allowUnsafeLocalConfig
 * @property {typeof DEFAULT_LINES} lines
 */

/**
 * Resolve the DSH home directory.
 *
 * An explicit `home` wins over `DSH_HOME`: the detached scripts pass the home
 * they were started with (`--home`), and that value must be what they read,
 * otherwise a stale environment variable in the calling shell would redirect a
 * backup to a different home than the one the plugin was configured for.
 *
 * @param {Record<string, unknown>} [config]
 * @returns {string}
 */
export function resolveHome(config = {}) {
  if (typeof config.home === 'string' && config.home.trim() !== '') return config.home.trim();
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  return join(homedir(), '.dsh');
}

/**
 * Deep-merge the line defaults with user overrides, one line at a time, so a
 * partial override (say only `intervalMs`) keeps every other default.
 *
 * @param {Record<string, any>} [overrides]
 * @returns {typeof DEFAULT_LINES}
 */
export function mergeLines(overrides = {}) {
  /** @type {any} */
  const merged = {};
  for (const [name, base] of Object.entries(DEFAULT_LINES)) {
    const user = overrides?.[name] ?? {};
    merged[name] = { ...base, ...user };
    if (Array.isArray(base.exclude ?? base.paths ?? base.files)) {
      for (const key of ['exclude', 'paths', 'files']) {
        if (Array.isArray(user[key])) merged[name][key] = [...user[key]];
        else if (Array.isArray(base[key])) merged[name][key] = [...base[key]];
      }
    }
  }
  return merged;
}

/**
 * Read `<home>/sync-plugin/config.json` if present.
 * A missing file is normal (defaults apply). A corrupt file is reported so
 * the user can fix it instead of wondering why backups stopped.
 *
 * @param {string} home
 * @returns {{data: Record<string, any>, error?: string}}
 */
export function readConfigFile(home) {
  const path = join(home, STATE_DIR, CONFIG_FILE);
  if (!existsSync(path)) return { data: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { data: {}, error: `${path} must contain a JSON object` };
    }
    return { data: parsed };
  } catch (error) {
    return { data: {}, error: `${path} is not valid JSON (${error.message})` };
  }
}

/**
 * Write the config file, creating the state directory as needed.
 * @param {string} home
 * @param {object} data
 */
export function writeConfigFile(home, data) {
  const path = join(home, STATE_DIR, CONFIG_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return path;
}

/**
 * Build the effective configuration from the patch layer and the config file.
 * @param {Record<string, any>} entryConfig - the Cordis entry's `config`.
 * @returns {SyncConfig & {configPath: string, warnings: string[]}}
 */
export function loadConfig(entryConfig = {}) {
  const home = resolveHome(entryConfig);
  const { data: fileConfig, error } = readConfigFile(home);
  const warnings = error ? [error] : [];

  // The file layer wins over the patch layer for values it states, because it
  // is the copy a person edits by hand; the patch layer is rewritten by the
  // plugin manager. Explicit patch values still win over defaults.
  const merged = { ...entryConfig, ...fileConfig };
  const remote = typeof merged.remote === 'string' ? merged.remote.trim() : '';

  const worktree =
    typeof merged.worktree === 'string' && merged.worktree.trim() !== ''
      ? merged.worktree.trim()
      : `${home}${WORKTREE_SUFFIX}`;

  const exclude = Array.isArray(merged.exclude)
    ? merged.exclude.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
    : ['.credentials.yaml', '**/node_modules/', '*.log'];

  return {
    home,
    remote,
    remoteName:
      typeof merged.remoteName === 'string' && merged.remoteName.trim() !== ''
        ? merged.remoteName.trim()
        : 'origin',
    worktree,
    userName:
      typeof merged.userName === 'string' && merged.userName.trim() !== ''
        ? merged.userName.trim()
        : 'dsh-auto-sync',
    userEmail:
      typeof merged.userEmail === 'string' && merged.userEmail.trim() !== ''
        ? merged.userEmail.trim()
        : 'dsh-auto-sync@localhost',
    exclude,
    allowUnsafeLocalConfig: merged.allowUnsafeLocalConfig === true,
    // Language of the command surface and onboarding text: 'zh' or 'en'.
    // Left undefined here so `resolveLocale` can fall back to the environment
    // and the host UI locale; an explicit value always wins.
    locale: typeof merged.locale === 'string' ? merged.locale : undefined,
    lines: mergeLines(merged.lines),
    configPath: join(home, STATE_DIR, CONFIG_FILE),
    warnings,
  };
}

/**
 * Read the DSH UI locale without depending on any client package.
 *
 * The host may expose the active locale through a `locale` service or a
 * settings file; neither is guaranteed across DSH releases, so this is best
 * effort and simply returns undefined when nothing is discoverable.
 *
 * @param {any} ctx - the Cordis context.
 * @returns {string | undefined}
 */
export function hostLocale(ctx) {
  try {
    const preference = ctx?.locale?.preference;
    if (typeof preference === 'string' && preference !== '') return preference;
  } catch {
    // A service that is not mounted must not break the plugin.
  }
  return undefined;
}

/**
 * The template written on first run. Kept as a literal (not a JSON.stringify
 * of defaults) so the file reads as documentation for the person editing it.
 *
 * @returns {string}
 */
export function configTemplate() {
  const template = {
    $schema: 'https://raw.githubusercontent.com/<you>/dsh-auto-sync/main/config.schema.json',
    remote: '',
    worktree: '',
    locale: 'zh',
    exclude: ['.credentials.yaml', '**/node_modules/', '*.log'],
    lines: {
      hot: {
        enabled: true,
        branch: 'dsh-hot',
        debounceMs: 30_000,
        intervalMs: 900_000,
        paths: ['.sync-status.json'],
      },
      snapshot: {
        enabled: true,
        branch: 'dsh-snapshot',
        intervalMs: 86_400_000,
        includeNodeModules: true,
        profile: 'desktop',
      },
      workspace: {
        enabled: false,
        branch: 'dsh-workspace',
        source: '',
        exclude: ['.git', 'node_modules', 'dist', 'build', 'target', '.cache'],
      },
    },
  };
  return `${JSON.stringify(template, null, 2)}\n`;
}
