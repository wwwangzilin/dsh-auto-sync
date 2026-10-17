/**
 * First-run onboarding and the `/dsh-sync` command surface.
 *
 * The plugin can work invisibly, but an unconfigured install that only logs a
 * warning is a poor first experience: the person is told a file exists
 * somewhere and left to find it. This module turns that into a conversation:
 *
 * 1. **Onboarding message.** While the plugin is unfinished, its entry point
 *    tells the session what is missing and what to do about it.
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
 * All user-facing text comes from `./i18n.mjs`; see that module for locale
 * resolution.
 *
 * @module dsh-auto-sync/lib/onboard
 */

import { existsSync } from 'node:fs';
import { loadConfig, readConfigFile, writeConfigFile } from './config.mjs';
import { Git, probeGit } from './git.mjs';
import { readStatus } from './status.mjs';
import { dictionary, resolveLocale } from './i18n.mjs';

/** Command name, without the leading slash. */
export const COMMAND_NAME = 'dsh-sync';

/**
 * @typedef {object} OnboardingState
 * @property {boolean} configured - a remote URL is set.
 * @property {boolean} repository - the home is a git repository.
 * @property {boolean} gitAvailable - the git executable can run.
 * @property {'git' | 'remote' | 'repository'} [missing] - which step is outstanding.
 * @property {string} [gitReason] - why git is unusable, when it is.
 */

/**
 * Inspect the current state to decide what onboarding has left to do.
 *
 * The reason is returned as a code rather than a sentence so the caller can
 * render it in the person's language.
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
      missing: 'git',
      gitReason: git.reason ?? 'unknown',
    };
  }
  const repo = new Git(config.home);
  const repository = await repo.isRepo();
  if (config.remote === '') {
    return { configured: false, repository, gitAvailable: true, missing: 'remote' };
  }
  if (!repository) {
    return { configured: true, repository: false, gitAvailable: true, missing: 'repository' };
  }
  return { configured: true, repository: true, gitAvailable: true };
}

/**
 * @param {OnboardingState} state
 * @param {import('./i18n.mjs').Dict} t
 * @returns {string | undefined}
 */
function describeNextStep(state, t) {
  switch (state.missing) {
    case 'git':
      return t.onboarding.missingGit(state.gitReason ?? 'unknown');
    case 'remote':
      return t.onboarding.missingRemote(COMMAND_NAME);
    case 'repository':
      return t.onboarding.missingRepo();
    default:
      return undefined;
  }
}

/**
 * The onboarding message shown to a session while setup is incomplete.
 * Returns null once the plugin is ready, so a configured install never
 * repeats it.
 *
 * @param {import('./config.mjs').SyncConfig & {locale?: unknown}} config
 * @param {string} [hostLocale] - the DSH UI locale, when the host exposes one.
 * @returns {Promise<string | null>}
 */
export async function onboardingMessage(config, hostLocale = undefined) {
  const state = await onboardingState(config);
  if (state.configured && state.repository && state.gitAvailable) return null;

  const t = dictionary(resolveLocale(config, hostLocale));
  const lines = [t.onboarding.title, '', ...t.onboarding.body, ''];
  const nextStep = describeNextStep(state, t);
  if (nextStep !== undefined) lines.push(t.onboarding.nextStep(nextStep), '');
  lines.push(t.onboarding.configFile(config.configPath));
  lines.push(t.onboarding.runAnyTime(COMMAND_NAME));
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
 * @param {import('./i18n.mjs').Dict} [t] - dictionary for the reason text.
 * @returns {string | null} a reason when unacceptable, otherwise null.
 */
export function remoteProblem(value, t = dictionary('en')) {
  const url = value.trim();
  if (url === '') return t.remote.required;
  if (/\s/.test(url)) return t.remote.whitespace;
  if (/^(https?|ssh|git|file):\/\//i.test(url)) return null;
  if (/^[^@/\\]+@[^:/\\]+:/i.test(url)) return null;
  // A local path used as a remote (a bare repository on disk).
  if (/^[a-z]:[\\/]/i.test(url) || url.startsWith('/') || url.startsWith('\\\\')) return null;
  return t.remote.shape;
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
 * @param {import('./i18n.mjs').Dict} t
 * @returns {string}
 */
function describeStatus(config, t) {
  const status = readStatus(config.home);
  /** @param {string | undefined} at */
  const age = (at) => {
    if (!at) return t.status.never;
    const ms = Date.now() - Date.parse(at);
    if (Number.isNaN(ms)) return t.status.unknown;
    if (ms < 60_000) return t.status.justNow;
    if (ms < 3_600_000) return t.status.minutesAgo(Math.round(ms / 60_000));
    return t.status.hoursAgo(Math.round(ms / 3_600_000));
  };

  const lines = [
    t.status.title,
    '',
    `- ${t.status.remote}: ${config.remote === '' ? t.status.notConfigured : `\`${config.remote}\``}`,
    `- ${t.status.home}: \`${config.home}\``,
    `- ${t.status.worktree}: \`${config.worktree}\``,
    `- ${t.status.config}: \`${config.configPath}\``,
    '',
    `| ${t.status.line} | ${t.status.enabled} | ${t.status.branch} | ${t.status.lastSuccess} |`,
    '| --- | --- | --- | --- |',
  ];
  for (const key of /** @type {const} */ (['hot', 'snapshot', 'workspace'])) {
    const line = config.lines[key];
    const entry = status[key] ?? {};
    lines.push(
      `| ${t.lines.names[key]} | ${line.enabled ? t.status.yes : t.status.no} | ${line.branch} | ${age(entry.lastSuccessAt)} |`,
    );
  }
  const errors = Object.entries(status).filter(([, entry]) => entry.lastError);
  if (errors.length > 0) {
    lines.push('', t.status.lastErrors);
    for (const [name, entry] of errors) {
      lines.push(`- ${name}: ${String(entry.lastError).split('\n')[0].slice(0, 160)}`);
    }
  }
  if (config.remote !== '') lines.push('', t.status.hint(COMMAND_NAME));
  return lines.join('\n');
}

/**
 * Build the command handler.
 *
 * @param {{
 *   home: string,
 *   onSetup: (config: import('./config.mjs').SyncConfig) => Promise<void>,
 *   onSnapshot: () => void,
 *   locale?: unknown,
 *   hostLocale?: () => string | undefined,
 * }} deps
 * @returns {(context: {rawInput: string}) => Promise<{kind: 'success'|'error', text: string}>}
 */
export function createCommandHandler(deps) {
  return async ({ rawInput }) => {
    const input = rawInput.trim();
    // An empty input must mean "status": splitting '' yields [''], and the
    // destructuring default only applies to `undefined`, not to an empty word.
    const tokens = input === '' ? [] : input.split(/\s+/);
    const verb = tokens[0] ?? 'status';
    const argument = tokens.slice(1).join(' ').trim();
    let config = loadConfig({ home: deps.home, locale: deps.locale });
    const t = dictionary(resolveLocale(config, deps.hostLocale?.()));

    switch (verb.toLowerCase()) {
      case 'status':
        return ok(describeStatus(config, t));

      case 'setup': {
        if (argument !== '') {
          const problem = remoteProblem(argument, t);
          if (problem !== null) return fail(problem);
          updateConfigFile(deps.home, (current) => {
            current.remote = argument;
          });
        }
        config = loadConfig({ home: deps.home, locale: deps.locale });
        if (config.remote === '') return fail(t.setup.noRemote(COMMAND_NAME));
        try {
          await deps.onSetup(config);
        } catch (error) {
          return fail(t.setup.failed(error?.message ?? error));
        }
        return ok(
          [
            t.setup.title,
            '',
            t.setup.backingUp(config.home, config.remote),
            '',
            `- ${t.setup.hotLine(config.lines.hot.branch)}`,
            `- ${t.setup.snapshotLine(config.lines.snapshot.branch)}`,
            `- ${
              config.lines.workspace.enabled
                ? t.setup.workspaceLine(config.lines.workspace.branch)
                : t.setup.workspaceDisabled
            }`,
            '',
            t.setup.workspaceHint(COMMAND_NAME),
          ].join('\n'),
        );
      }

      case 'remote': {
        if (argument === '') {
          return fail(
            config.remote === '' ? t.remoteUpdate.none : t.remoteUpdate.current(config.remote),
          );
        }
        const problem = remoteProblem(argument, t);
        if (problem !== null) return fail(problem);
        updateConfigFile(deps.home, (current) => {
          current.remote = argument;
        });
        return ok(t.remoteUpdate.updated(argument));
      }

      case 'lines': {
        const rows = /** @type {const} */ (['hot', 'snapshot', 'workspace']).map((key) =>
          t.lines.row(t.lines.names[key], config.lines[key].branch, config.lines[key].enabled),
        );
        return ok([t.lines.title, '', ...rows, '', t.lines.hint].join('\n'));
      }

      case 'workspace': {
        if (argument === '') {
          return ok(
            config.lines.workspace.enabled
              ? t.workspace.enabled(config.lines.workspace.source)
              : t.workspace.disabled(COMMAND_NAME),
          );
        }
        const lowered = argument.toLowerCase();
        if (lowered === 'off' || lowered === 'disable') {
          updateConfigFile(deps.home, (current) => {
            current.lines = current.lines ?? {};
            current.lines.workspace = { ...(current.lines.workspace ?? {}), enabled: false };
          });
          return ok(t.workspace.nowDisabled);
        }
        if (!existsSync(argument)) return fail(t.workspace.missing(argument));
        updateConfigFile(deps.home, (current) => {
          current.lines = current.lines ?? {};
          current.lines.workspace = {
            ...(current.lines.workspace ?? {}),
            enabled: true,
            source: argument,
          };
        });
        return ok(t.workspace.nowEnabled(argument, config.lines.workspace.branch));
      }

      case 'run': {
        if (config.remote === '') return fail(t.run.needRemote(COMMAND_NAME));
        deps.onSnapshot();
        return ok(t.run.scheduled);
      }

      case 'doctor': {
        const git = await probeGit();
        const state = await onboardingState(config);
        const repo = new Git(config.home);
        const rows = [
          git.available ? t.doctor.gitOk(git.version ?? '') : t.doctor.gitMissing(git.reason ?? ''),
          t.doctor.repository(state.repository),
          t.doctor.configured(state.configured),
        ];
        if (state.repository) {
          const top = await repo.text(['rev-parse', '--show-toplevel']);
          rows.push(t.doctor.topLevel(top || config.home));
          for (const line of /** @type {const} */ (['hot', 'snapshot'])) {
            const branch = config.lines[line].branch;
            const exists = await repo.hasBranch(branch);
            rows.push(exists ? t.doctor.branchPresent(branch) : t.doctor.branchMissing(branch));
          }
          const listed = await repo.text(['worktree', 'list']);
          const count = listed === '' ? 0 : listed.split('\n').length;
          rows.push(t.doctor.worktrees(count));
        }
        const nextStep = describeNextStep(state, t);
        if (nextStep !== undefined) rows.push('', t.doctor.nextStep(nextStep));
        return ok([t.doctor.title, '', ...rows].join('\n'));
      }

      default:
        return fail(
          [t.help.unknown(verb), '', ...t.help.usage.map((line) => line(COMMAND_NAME))].join('\n'),
        );
    }
  };
}

/**
 * Register the command on a context that provides the `commands` service.
 * Returns a disposer, or undefined when the service is unavailable.
 *
 * @param {any} ctx - the Cordis context.
 * @param {{
 *   home: string,
 *   onSetup: (config: import('./config.mjs').SyncConfig) => Promise<void>,
 *   onSnapshot: () => void,
 *   locale?: unknown,
 *   hostLocale?: () => string | undefined,
 * }} deps
 * @returns {(() => void) | undefined}
 */
export function registerCommand(ctx, deps) {
  const commands = ctx?.commands;
  if (!commands || typeof commands.register !== 'function') return undefined;
  const locale = resolveLocale({ locale: deps.locale }, deps.hostLocale?.());
  const t = dictionary(locale);
  const handler = createCommandHandler(deps);
  const disposer = commands.register({
    name: COMMAND_NAME,
    description:
      locale === 'zh'
        ? '配置并查看 DSH home 的自动备份'
        : 'Configure and inspect DSH home automatic backups',
    input: { hint: '[status|setup <url>|remote <url>|lines|workspace <path>|run|doctor]' },
    handler,
  });
  return typeof disposer === 'function' ? disposer : undefined;
}
