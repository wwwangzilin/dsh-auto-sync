/**
 * dsh-auto-sync — automatic, versioned backup of a DeepSeek Harness home to
 * the person's own private git repository.
 *
 * Three lines, each on its own branch:
 *   hot       — small, frequently changing state; committed after every turn.
 *   snapshot  — the full home tree, including installed dependencies.
 *   workspace — one project directory, mirrored to its own branch.
 *
 * Nothing here names a repository: the URL comes from the person's own config
 * (`<home>/sync-plugin/config.json` or the profile patch). The plugin is a
 * thin scheduler; the detached script does the git work so a shutdown snapshot
 * survives the process that scheduled it.
 *
 * Failure policy: every error is logged and recorded in the status file, never
 * thrown into the session event chain. A broken backup must not break the
 * conversation, but it must always be visible.
 *
 * @module dsh-auto-sync
 */

import { existsSync, mkdirSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, writeConfigFile, configTemplate, hostLocale, STATE_DIR } from './lib/config.mjs';
import { Git, probeGit } from './lib/git.mjs';
import { setup } from './lib/setup.mjs';
import { noteFailure, noteSuccess, readStatus, staleLines } from './lib/status.mjs';
import { COMMAND_NAME, onboardingMessage, registerCommand } from './lib/onboard.mjs';
import { API_PREFIX, registerRoutes } from './lib/api.mjs';

/** Absolute directory of this plugin. */
const THIS_DIR = fileURLToPath(new URL('.', import.meta.url));

/** Delay before a startup catch-up, so the first paint is never blocked. */
const CATCH_UP_DELAY_MS = 60_000;

/** Cordis plugin name, used in loader diagnostics. */
export const name = 'dsh-auto-sync';

/** No services are required; listeners mount immediately. */
export const inject = [];

/**
 * Whether `child` is `parent` or inside it.
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
function isInsideOrEqual(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !rel.includes(':'));
}

/** @returns {string} an ISO timestamp safe for a commit message. */
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Plugin entry.
 *
 * @param {any} ctx - the Cordis context.
 * @param {Record<string, any>} [entryConfig] - the profile patch's `config`.
 */
export function apply(ctx, entryConfig = {}) {
  const config = loadConfig(entryConfig);
  const { home, lines, remoteName } = config;
  const configured = config.remote !== '';

  /** @param {string} message */
  const warn = (message) => {
    try {
      // Warn level: visible under the default logger filter.
      ctx.logger?.warn?.(`dsh-auto-sync: ${message}`);
    } catch {
      // A missing logger must not break the hook.
    }
  };

  /** @param {string} message */
  const info = (message) => {
    try {
      ctx.logger?.info?.(`dsh-auto-sync: ${message}`);
    } catch {
      // ignore
    }
  };

  const timers = { debounce: null, flush: null, snapshot: null, catchUp: null };
  let disposed = false;

  /**
   * @returns {string} the directory the hot line commits into.
   */
  const hotWorktree = () => (lines.snapshot.enabled ? `${config.worktree}-hot` : config.worktree);

  /** Run the snapshot script detached, so it outlives a shutdown. */
  const runSnapshotScript = () => {
    if (!lines.snapshot.enabled || !configured) return;
    try {
      const child = spawn(
        process.execPath,
        [join(THIS_DIR, 'cold-sync.mjs'), '--home', home, '--worktree', config.worktree],
        { detached: true, stdio: 'ignore', windowsHide: true },
      );
      child.unref();
      info('snapshot scheduled');
    } catch (error) {
      warn(`could not start the snapshot: ${error.message}`);
    }
  };

  /**
   * Hot line: commit the configured paths in the hot worktree and push.
   * The paths come from the config and are relative to the home, so a bad
   * config cannot make this line copy arbitrary machine files.
   */
  const syncHot = async () => {
    if (!lines.hot.enabled || !configured || disposed) return;
    const worktree = hotWorktree();
    const git = new Git(worktree);
    /** @param {string} message */
    const fail = (message) => {
      noteFailure(home, 'hot', message);
      warn(message);
    };

    if (!existsSync(join(worktree, '.git'))) {
      fail(`no worktree at ${worktree}; rerun the first-run setup`);
      return;
    }

    try {
      // Copy the live files into the worktree first: the worktree only ever
      // sees what this line put there, so "dirty" alone cannot mean "the home
      // has new state". A path that is missing in the home is skipped, and a
      // path that escapes the home is refused — the config must not be able to
      // turn this line into a copier for arbitrary machine files.
      for (const rel of lines.hot.paths) {
        if (typeof rel !== 'string' || rel.trim() === '') continue;
        const from = resolve(home, rel);
        if (!isInsideOrEqual(home, from)) {
          fail(`refusing hot path "${rel}": it resolves outside ${home}`);
          continue;
        }
        if (!existsSync(from)) continue;
        try {
          const to = join(worktree, rel);
          mkdirSync(dirname(to), { recursive: true });
          await copyFile(from, to);
        } catch (error) {
          fail(`cannot copy ${rel}: ${error.code ?? error.message}`);
        }
      }

      const status = await git.exec(['status', '--porcelain', '--', ...lines.hot.paths]);
      if (status.code !== 0) {
        fail(`git status exited ${status.code}`);
        return;
      }
      if (status.out.trim() !== '') {
        // `-f`: the snapshot line's ignore rules exclude runtime state, and
        // these paths are the hot line's own content.
        await git.exec(['add', '-f', '--', ...lines.hot.paths]);
        const commit = await git.commitStaged(`dsh hot ${stamp()}`);
        if (commit.error) {
          fail(`commit failed: ${commit.error}`);
          return;
        }
      }
      const push = await git.exec(['push', remoteName, lines.hot.branch]);
      if (push.code !== 0) {
        fail(`push failed (the commit stays local): ${(push.err || push.out).trim()}`);
        return;
      }
      noteSuccess(home, 'hot');
    } catch (error) {
      fail(String(error?.message ?? error));
    }
  };

  /** Debounced hot sync, reset by each completed turn. */
  const scheduleHot = () => {
    if (timers.debounce !== null) clearTimeout(timers.debounce);
    timers.debounce = setTimeout(() => {
      timers.debounce = null;
      void syncHot();
    }, lines.hot.debounceMs);
  };

  /** One-time startup work: seed config, validate, set up git, catch up. */
  const startup = async () => {
    // Give the person a file to fill in rather than a README step to follow.
    if (!existsSync(config.configPath)) {
      try {
        writeConfigFile(home, JSON.parse(configTemplate()));
        info(`wrote a config template to ${config.configPath}`);
      } catch (error) {
        warn(`could not write the config template: ${error.message}`);
      }
    }

    if (!configured) {
      warn(
        `"remote" is empty in ${config.configPath}; backups are paused. Run /${COMMAND_NAME} setup <your-private-repo-url>, or edit that file and restart DSH.`,
      );
      // The log line above is for whoever reads the log; this is for whoever is
      // looking at the conversation. It appears once per unfinished start and
      // disappears for good once the remote is set.
      try {
        const guidance = await onboardingMessage(loadConfig({ ...entryConfig, home }), hostLocale(ctx));
        if (guidance !== null) info(guidance);
      } catch (error) {
        warn(`could not render the onboarding guidance: ${error?.message ?? error}`);
      }
      return;
    }

    const git = await probeGit();
    if (!git.available) {
      warn(`git is unavailable (${git.reason}); backups are paused`);
      return;
    }

    await runSetup(loadConfig({ ...entryConfig, home }), info);
  };

  /**
   * Run the repository setup and the post-setup catch-up.
   * Shared by startup and the `/dsh-sync setup` command so a person never has
   * to restart DSH to finish configuring.
   *
   * @param {import('./lib/config.mjs').SyncConfig} target - the config to apply.
   * @param {(message: string) => void} [notify] - sink for progress messages.
   */
  const runSetup = async (target, notify = info) => {
    const result = await setup(target, warn);
    if (!result.ok) {
      throw new Error(result.error ?? 'setup failed; backups are paused');
    }
    if (result.actions.length > 0) notify(`setup: ${result.actions.join('; ')}`);

    // Catch up a stale snapshot shortly after startup instead of waiting a full
    // interval that every restart would reset.
    const status = readStatus(target.home);
    const last = status.snapshot?.lastSuccessAt ? Date.parse(status.snapshot.lastSuccessAt) : Number.NaN;
    const ageMs = Number.isNaN(last) ? Number.POSITIVE_INFINITY : Date.now() - last;
    if (target.lines.snapshot.enabled && ageMs >= target.lines.snapshot.intervalMs) {
      const ageText = Number.isFinite(ageMs) ? `${Math.round(ageMs / 3_600_000)}h old` : 'never recorded';
      notify(`the last snapshot is stale (${ageText}); catching up shortly`);
      if (timers.catchUp === null) {
        timers.catchUp = setTimeout(() => {
          timers.catchUp = null;
          void syncHot().finally(runSnapshotScript);
        }, CATCH_UP_DELAY_MS);
      }
    }

    const enabled = [
      ...(target.lines.hot.enabled ? ['hot'] : []),
      ...(target.lines.snapshot.enabled ? ['snapshot'] : []),
      ...(target.lines.workspace.enabled ? ['workspace'] : []),
    ];
    const stale = staleLines(target.home, enabled);
    if (stale.length > 0) {
      warn(`stale backup line(s): ${stale.join(', ')}; see ${join(target.home, STATE_DIR, 'status.json')}`);
    } else {
      notify(`ready: backing up ${target.home} via ${target.remoteName}`);
    }
  };

  // --- command surface ------------------------------------------------------
  // A profile without the `commands` service (headless, ACP) simply has no
  // slash commands; the config file remains the only surface there.
  try {
    const commandDisposer = registerCommand(ctx, {
      home,
      locale: config.locale,
      hostLocale: () => hostLocale(ctx),
      onSetup: async (updated) => {
        await runSetup(updated);
      },
      onSnapshot: () => {
        runSnapshotScript();
      },
    });
    if (commandDisposer !== undefined) {
      info(`registered /${COMMAND_NAME}; run it to configure or inspect backups`);
      ctx.on('dispose', () => {
        commandDisposer();
      });
    }
  } catch (error) {
    warn(`could not register /${COMMAND_NAME}: ${error?.message ?? error}`);
  }

  // --- settings page API ----------------------------------------------------
  // The settings tab is a browser script; it reaches the host only through
  // these routes. A profile without a web server (headless, CLI) has no page to
  // serve, so the routes are simply not registered.
  try {
    const webServer = ctx.webServer;
    const disposers = registerRoutes(webServer, {
      home,
      locale: config.locale,
      hostLocale: () => hostLocale(ctx),
      warn,
      onSetup: async () => {
        await runSetup(loadConfig({ ...entryConfig, home }));
      },
      onSnapshot: () => {
        runSnapshotScript();
      },
    });
    if (disposers.length > 0) {
      info(`serving ${disposers.length} settings page route(s) under ${API_PREFIX}`);
      ctx.on('dispose', () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            // A route already torn down by the host is not an error.
          }
        }
      });
    }
  } catch (error) {
    warn(`could not register the settings page routes: ${error?.message ?? error}`);
  }

  void startup().catch((error) => warn(`startup check failed: ${error?.message ?? error}`));


  // --- event wiring ---------------------------------------------------------
  ctx.on('session/event', (_session, event) => {
    if (event && event.type === 'turn/end') scheduleHot();
  });

  // The flush refreshes the hot line even when no turn ends (a long tool run),
  // and the snapshot interval covers an app that never shuts down cleanly.
  timers.flush = setInterval(() => {
    void syncHot();
  }, lines.hot.intervalMs);

  if (lines.snapshot.enabled) {
    timers.snapshot = setInterval(() => {
      runSnapshotScript();
    }, lines.snapshot.intervalMs);
  }

  ctx.on('dispose', () => {
    if (disposed) return;
    disposed = true;
    for (const handle of Object.values(timers)) {
      if (handle !== null) {
        clearTimeout(handle);
        clearInterval(handle);
      }
    }
    // Final snapshot on shutdown, detached so it outlives this process.
    runSnapshotScript();
  });

  info(`loaded: home=${home} worktree=${config.worktree}${configured ? '' : ' (not configured yet)'}`);
}
