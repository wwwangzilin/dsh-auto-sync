/**
 * Process helpers shared by the plugin and the detached scripts.
 *
 * Everything here is deliberately dependency-free and cross-platform: the
 * package runs inside someone else's DSH installation, so it may not be able
 * to resolve anything outside Node's own modules.
 *
 * @module dsh-auto-sync/lib/exec
 */

import { execFile, spawnSync } from 'node:child_process';

/**
 * Run a command asynchronously, resolving with its result.
 * Never rejects: a missing binary, a spawn error and a non-zero exit all come
 * back as data so callers can decide what a failure means.
 *
 * @param {string} command - executable name or absolute path.
 * @param {string[]} args - arguments, passed without shell interpretation.
 * @param {{cwd?: string, env?: Record<string, string>, maxBuffer?: number}} [options]
 * @returns {Promise<{code: number, out: string, err: string}>}
 */
export function runAsync(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: options.env ?? process.env,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            code: typeof error.code === 'number' ? error.code : -1,
            out: stdout ?? '',
            err: stderr || String(error.message ?? error),
          });
          return;
        }
        resolve({ code: 0, out: stdout ?? '', err: stderr ?? '' });
      },
    );
  });
}

/**
 * Run a command synchronously; never throws.
 *
 * The buffer default is generous because `git status` over a vendored
 * `node_modules` snapshot and recursive copies both emit far more than the
 * 1 MiB default, and an overflow kills the child (status becomes null) which
 * would otherwise look like a quiet no-op.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, maxBuffer?: number}} [options]
 * @returns {{code: number, out: string, err: string}}
 */
export function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
  });
  if (result.error) {
    const code = result.error.code ?? result.error.name;
    return { code: -1, out: result.stdout ?? '', err: `${code}: ${result.error.message}` };
  }
  return { code: result.status ?? -1, out: result.stdout ?? '', err: result.stderr ?? '' };
}

/**
 * Environment for git children: never prompt on a terminal.
 * A background sync that blocks on an invisible username prompt would stall
 * every later run behind it, and in a packaged desktop app there is no
 * terminal to answer anyway.
 */
export function gitEnv(extra = {}) {
  const base = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

  // Windows schannel cert-store lookups fail on some machines (SEC_E_NO_CREDENTIALS),
  // and a self-signed or company proxy makes libcurl reject every remote. Pointing
  // git at the openssl backend plus an exported PEM keeps the backup working without
  // touching the user's global gitconfig (which may be unwritable).
  //
  // DSH_AUTO_SYNC_SSL_CA_FILE is the preferred override; GIT_SSL_CAINFO and
  // GIT_SSL_BACKEND are honoured too, so an existing shell setup keeps working.
  const caFile = process.env.DSH_AUTO_SYNC_SSL_CA_FILE;
  if (caFile && !base.GIT_SSL_CAINFO) base.GIT_SSL_CAINFO = caFile;
  if (base.GIT_SSL_CAINFO && !base.GIT_SSL_BACKEND) base.GIT_SSL_BACKEND = 'openssl';

  // A direct route to github.com can be slow enough on some networks that a fetch
  // outlives the caller's patience and the run gets killed mid-transfer, which then
  // looks like a flaky backup. When the user nominates a proxy, hand it to libcurl
  // so both hot and snapshot lines take the fast route.
  //
  // DSH_AUTO_SYNC_PROXY is the plugin's own knob; the conventional HTTP(S)_PROXY
  // variables are left untouched so an existing shell setup keeps working.
  const proxy = process.env.DSH_AUTO_SYNC_PROXY;
  if (proxy) {
    if (!base.HTTPS_PROXY) base.HTTPS_PROXY = proxy;
    if (!base.HTTP_PROXY) base.HTTP_PROXY = proxy;
  }

  return { ...base, ...extra };
}
