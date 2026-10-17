/**
 * First-run onboarding and the `/dsh-sync` command surface.
 *
 * The plugin can work invisibly, but an unconfigured install that only logs a
 * warning is a poor first experience: the person is told a file exists
 * somewhere and left to find it. This module turns that into a conversation:
 *
 * 1. **Onboarding message.** Until the plugin is configured, its entry point
 *    tells the session what is missing and what to do about it, in the same
 *    language the rest of the plugin uses for operator-facing text (English,
 *    matching the repository).
 * 2. **`/dsh-sync` command.** A slash command that walks through the same
 *    setup without editing JSON by hand:
 *
 *      /dsh-sync                     report status
 *      /dsh-sync setup <remote-url>  set the remote and run setup
 *      /dsh-sync remote <remote-url> change the remote only
 *      /dsh-sync lines               list the backup lines and their branches
 *      /dsh-sync workspace <path>    enable the workspace line for a project
 *      /dsh-sync workspace off       disable it
 *      /dsh-sync run                 snapshot now
 *      /dsh-sync doctor              diagnose the chain
 *
 * The command is registered only when the profile provides the `commands`
 * service; a headless or ACP profile simply has no command surface and the
 * plugin keeps working through its config file.
 *
 * @module dsh-auto-sync/lib/onboard
 */

import { existsSync } from 'node:fs';
import { loadConfig, readConfigFile, writeConfigFile } from './config.mjs';
import { Git, probeGit } from './git.mjs';
import { readStatus } from './status.mjs';

/** Command name, without the leading slash. */
export const COMMAND_NAME = 'dsh-sync';

/**
 * The steps a person has to complete, in order.
 * @typedef {object} OnboardingState
 * @property {boolean} configured - a remote URL is set.
 * @property {boolean} repository - the home is a git repository.
 * @property {boolean} gitAvailable - the git executable can run.
 * @property {string} [nextStep] - the one thing to do next.
 */

/**
 * Inspect the current state to decide what onboarding has left to do.
 *
 * @param {import('./config.mjs').SyncConfig} config
 * @returns {Promise<OnboardingState>}
 */
export async function onboardingState(config) {
  const git = await probeGit();
  if (!git.available) {
    return {
      configured: config.remote !== '',
      repository: false,
      gitAvailable: false,
      nextStep: `install git and make sure it is on PATH (${git.reason})`,
    };
  }
  const repo = new Git(config.home);
  const repository = await repo.isRepo();
  if (config.remote === '') {
    return {
      configured: false,
      repository,
      gitAvailable: true,
      nextStep: `run \`/${COMMAND_NAME} setup <your-private-repo-url>\``,
    };
  }
  if (!repository) {
    return {
      configured: true,
      repository: false,
      gitAvailable: true,
      nextStep: 'restart DSH so the first-run setup creates the repository',
    };
  }
  return { configured: true, repository: true, gitAvailable: true };
}

/**
 * The onboarding message shown to a session while setup is incomplete.
 * Returns null once the plugin is ready, so a configured install never
 * repeats it.
 *
 * @param {import('./config.mjs').SyncConfig} config
 * @returns {Promise<string | null>}
 */
export async function onboardingMessage(config) {
  const state = await onboardingState(config);
  if (state.configured && state.repository && state.gitAvailable) return null;

  const lines = [
    '**dsh-auto-sync is installed but not finished setting up.**',
    '',
    'It backs up your DeepSeek Harness home (conversations, memory, settings,',
    'installed plugins) to a git repository you own. Nothing is uploaded until',
    'you name that repository.',
    '',
  ];
  if (state.nextStep) {
    lines.push(`Next step: ${state.nextStep}`, '');
  }
  lines.push(
    `Config file: \`${config.configPath}\``,
    `Run \`/${COMMAND_NAME}\` at any time to see what is configured.`,
  );
  return lines.join('\n');
}

/**
 * @param {string} text
 * @returns {{kind: 'success', text: string}}
 */
const ok = (text) => ({ kind: 'success', text });

/**
 * @param {string} text
 * @returns {{kind: 'error', text: string}}
 */
const fail = (text) => ({ kind: 'error', text });

/**
 * Validate a remote URL enough to give a useful error before git does.
 * Accepts the forms git accepts for a backup destination: ssh, https, a file
 * path, and the scp-like `user@host:path`.
 *
 * @param {string} value
 * @returns {string | null} a reason when unacceptable, otherwise null.
 */
export function remoteProblem(value) {
  const url = value.trim();
  if (url === '') return 'a remote URL is required';
  if (/\s/.test(url)) return 'a remote URL cannot contain whitespace';
  if (/^(https?|ssh|git|file):\/\//i.test(url)) return null;
  if (/^[^@/\\]+@[^:/\\]+:/i.test(url)) return null;
  // A local path used as a remote (a bare repository on disk).
  if (/^[a-z]:[\\/]/i.test(url) || url.startsWith('/') || url.startsWith('\\\\')) return null;
  return 'expected an ssh URL, an https URL, or a local path';
}

/**
 * Merge a partial update into the config file, preserving everything else.
 *
 * @param {string} home
 * @param {(current: Record<string, any>) => void} mutate
 * @returns {string} the written path.
 */
function updateConfigFile(home, mutate) {
  const { data } = readConfigFile(home);
  const current = structuredClone(data);
  mutate(current);
  return writeConfigFile(home, current);
}

/**
 * @param {import('./config.mjs').SyncConfig} config
 * @returns {string}
 */
function describeConfig(config) {
  const status = readStatus(config.home);
  const age = (/** @type {string | undefined} */ at) => {
    if (!at) return 'never';
    const ms = Date.now() - Date.parse(at);
    if (Number.isNaN(ms)) return 'unknown';
    if (ms < 60_000) return 'just now';
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
    return `${Math.round(ms / 3_600_000)} h ago`;
  };

  const lines = [
    '**dsh-auto-sync status**',
    '',
    `- Remote: ${config.remote === '' ? '_(not configured)_' : `\`${config.remote}\``}`,
    `- Home: \`${config.home}\``,
    `- Worktree: \`${config.worktree}\``,
    `- Config: \`${config.configPath}\``,
    '',
    '| Line | Enabled | Branch | Last success |',
    '| --- | --- | --- | --- |',
  ];
  for (const key of /** @type {const} */ (['hot', 'snapshot', 'workspace'])) {
    const line = config.lines[key];
    const entry = status[key] ?? {};
    lines.push(
      `| ${key} | ${line.enabled ? 'yes' : 'no'} | ${line.branch} | ${age(entry.lastSuccessAt)} |`,
    );
  }
  const errors = Object.entries(status).filter(([, entry]) => entry.lastError);
  if (errors.length > 0) {
    lines.push('', '**Last errors**');
    for (const [name, entry] of errors) {
      lines.push(`- ${name}: ${String(entry.lastError).split('\n')[0].slice(0, 160)}`);
    }
  }
  if (config.remote !== '') {
    lines.push('', `Run \`/${COMMAND_NAME} setup\` again to re-run the first-run setup, or \`/${COMMAND_NAME} run\` to snapshot now.`);
  }
  return lines.join('\n');
}

/**
 * Build the command handler.
 *
 * @param {{home: string, onSetup: (config: import('./config.mjs').SyncConfig) => Promise<void>, onSnapshot: () => void}} deps
 * @returns {(context: {rawInput: string}) => Promise<{kind: 'success'|'error', text: string}>}
 */
export function createCommandHandler(deps) {
  return async ({ rawInput }) => {
    const input = rawInput.trim();
    // An empty input must mean "status": splitting '' yields [''], and the
    // destructuring default only applies to `undefined`, not to an empty word.
    const tokens = input === '' ? [] : input.split(/\s+/);
    const verb = tokens[0] ?? 'status';
    const rest = tokens.slice(1);
    const argument = rest.join(' ').trim();
    const config = loadConfig({ home: deps.home });

    switch (verb.toLowerCase()) {
      case 'status':
        return ok(describeConfig(config));

      case 'setup': {
        if (argument !== '') {
          const problem = remoteProblem(argument);
          if (problem !== null) return fail(`That remote is not usable: ${problem}.`);
          updateConfigFile(deps.home, (current) => {
            current.remote = argument;
          });
        }
        const updated = loadConfig({ home: deps.home });
        if (updated.remote === '') {
          return fail(
            `No remote is configured. Run \`/${COMMAND_NAME} setup <your-private-repo-url>\`.`,
          );
        }
        try {
          await deps.onSetup(updated);
        } catch (error) {
          return fail(`Setup failed: ${error?.message ?? error}`);
        }
        return ok(
          [
            '**dsh-auto-sync is set up.**',
            '',
            `Backing up \`${updated.home}\` to \`${updated.remote}\`.`,
            '',
            `- Hot line: ${updated.lines.hot.branch} (after each turn)`,
            `- Snapshot line: ${updated.lines.snapshot.branch} (daily and on shutdown)`,
            `- Workspace line: ${updated.lines.workspace.enabled ? updated.lines.workspace.branch : 'disabled'}`,
            '',
            `Run \`/${COMMAND_NAME} workspace <path>\` to also back up a project directory.`,
          ].join('\n'),
        );
      }

      case 'remote': {
        if (argument === '') {
          return fail(
            config.remote === ''
              ? 'No remote is configured.'
              : `The current remote is \`${config.remote}\`.`,
          );
        }
        const problem = remoteProblem(argument);
        if (problem !== null) return fail(`That remote is not usable: ${problem}.`);
        updateConfigFile(deps.home, (current) => {
          current.remote = argument;
        });
        return ok(`Remote updated to \`${argument}\`. Restart DSH to apply it.`);
      }

      case 'lines': {
        const rows = /** @type {const} */ (['hot', 'snapshot', 'workspace']).map((key) => {
          const line = config.lines[key];
          return `- **${key}** -> branch \`${line.branch}\`, ${line.enabled ? 'enabled' : 'disabled'}`;
        });
        return ok(
          ['**Backup lines**', '', ...rows, '', 'Edit the intervals and paths in the config file.'].join(
            '\n',
          ),
        );
      }

      case 'workspace': {
        if (argument === '') {
          const enabled = config.lines.workspace.enabled;
          return ok(
            enabled
              ? `The workspace line mirrors \`${config.lines.workspace.source}\`.`
              : `The workspace line is disabled. Run \`/${COMMAND_NAME} workspace <absolute-path>\` to enable it.`,
          );
        }
        if (argument.toLowerCase() === 'off' || argument.toLowerCase() === 'disable') {
          updateConfigFile(deps.home, (current) => {
            current.lines = current.lines ?? {};
            current.lines.workspace = { ...(current.lines.workspace ?? {}), enabled: false };
          });
          return ok('The workspace line is now disabled.');
        }
        if (!existsSync(argument)) {
          return fail(`\`${argument}\` does not exist.`);
        }
        updateConfigFile(deps.home, (current) => {
          current.lines = current.lines ?? {};
          current.lines.workspace = {
            ...(current.lines.workspace ?? {}),
            enabled: true,
            source: argument,
          };
        });
        return ok(
          `The workspace line now mirrors \`${argument}\` to branch \`${config.lines.workspace.branch}\` on the next snapshot.`,
        );
      }

      case 'run': {
        if (config.remote === '') {
          return fail(`Configure a remote first: \`/${COMMAND_NAME} setup <url>\`.`);
        }
        deps.onSnapshot();
        return ok('A snapshot has been scheduled; it runs in the background.');
      }

      case 'doctor': {
        const git = await probeGit();
        const state = await onboardingState(config);
        const repo = new Git(config.home);
        const rows = [
          `- git: ${git.available ? `\`${git.version}\`` : `**missing** (${git.reason})`}`,
          `- home repository: ${state.repository ? 'yes' : '**no**'}`,
          `- remote configured: ${state.configured ? 'yes' : '**no**'}`,
        ];
        if (state.repository) {
          const top = await repo.text(['rev-parse', '--show-toplevel']);
          rows.push(`- repository toplevel: \`${top || config.home}\``);
          for (const line of /** @type {const} */ (['hot', 'snapshot'])) {
            const branch = config.lines[line].branch;
            const exists = await repo.hasBranch(branch);
            rows.push(`- branch \`${branch}\`: ${exists ? 'present' : '**missing**'}`);
          }
          const listed = await repo.text(['worktree', 'list']);
          rows.push(`- worktrees: ${listed === '' ? 'none' : String(listed.split('\n').length)}`);
        }
        if (state.nextStep) rows.push('', `Next step: ${state.nextStep}`);
        return ok(['**dsh-auto-sync doctor**', '', ...rows].join('\n'));
      }

      default:
        return fail(
          [
            `Unknown subcommand \`${verb}\`.`,
            '',
            `- \`/${COMMAND_NAME}\` — status`,
            `- \`/${COMMAND_NAME} setup <remote-url>\` — configure and run the first-run setup`,
            `- \`/${COMMAND_NAME} remote <remote-url>\` — change the remote only`,
            `- \`/${COMMAND_NAME} lines\` — list the backup lines`,
            `- \`/${COMMAND_NAME} workspace <path>|off\` — enable or disable the project line`,
            `- \`/${COMMAND_NAME} run\` — snapshot now`,
            `- \`/${COMMAND_NAME} doctor\` — diagnose the chain`,
          ].join('\n'),
        );
    }
  };
}

/**
 * Register the command on a context that provides the `commands` service.
 * Returns a disposer, or undefined when the service is unavailable.
 *
 * @param {any} ctx - the Cordis context.
 * @param {{home: string, onSetup: (config: import('./config.mjs').SyncConfig) => Promise<void>, onSnapshot: () => void}} deps
 * @returns {(() => void) | undefined}
 */
export function registerCommand(ctx, deps) {
  const commands = ctx?.commands;
  if (!commands || typeof commands.register !== 'function') return undefined;
  const handler = createCommandHandler(deps);
  const disposer = commands.register({
    name: COMMAND_NAME,
    description: 'Configure and inspect DSH home automatic backups',
    input: { hint: '[status|setup <url>|remote <url>|lines|workspace <path>|run|doctor]' },
    handler,
  });
  return typeof disposer === 'function' ? disposer : undefined;
}
