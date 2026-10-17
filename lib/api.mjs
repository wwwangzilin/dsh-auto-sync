/**
 * HTTP surface for the settings tab.
 *
 * The client half cannot call Node APIs: it runs in the browser and reaches the
 * host only over its own origin. This module is the host side of that
 * conversation, registered on the profile's `webServer` service.
 *
 * Every endpoint is a thin, validating wrapper over the same code the
 * `/dsh-sync` command uses, so the two surfaces cannot drift apart.
 *
 * Routes (all JSON, all same-origin):
 *   GET  /api/dsh-auto-sync/status   -> { config, lines, git, worktrees }
 *   POST /api/dsh-auto-sync/config   -> validate and persist the remote / lines
 *   POST /api/dsh-auto-sync/snapshot -> run the snapshot now
 *
 * Security: the settings page is served by the same host as these routes, so
 * requests carry the browser's existing session cookies. A request whose
 * `Origin` header names a different site is refused, which stops a page on
 * another origin from driving backups through the user's browser.
 *
 * @module dsh-auto-sync/lib/api
 */

import { existsSync } from 'node:fs';
import { loadConfig, readConfigFile, writeConfigFile } from './config.mjs';
import { Git, probeGit } from './git.mjs';
import { readStatus } from './status.mjs';
import { remoteProblem } from './onboard.mjs';
import { dictionary, resolveLocale } from './i18n.mjs';

/** Route prefix; keep in sync with the client half. */
export const API_PREFIX = '/api/dsh-auto-sync';

/** Request body cap: the payload is a small JSON object. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * @typedef {object} RouteDeps
 * @property {string} home
 * @property {() => void} onSnapshot
 * @property {() => void} onRelease
 * @property {() => Promise<void>} onSetup
 * @property {unknown} [locale]
 * @property {() => string | undefined} [hostLocale]
 * @property {(message: string) => void} [warn]
 */

/**
 * Send a JSON response.
 *
 * @param {any} res - the Node response object.
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    // The page is same-origin; a mismatch means a cross-site caller.
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

/**
 * Whether a request is allowed to reach a mutating route.
 *
 * Browsers always attach `Origin` to a cross-origin request and to same-origin
 * POSTs from a page, so a present-and-different Origin is refused; an absent
 * Origin (a non-browser client such as curl) is allowed because no credential
 * can be borrowed there. Non-mutating routes skip the check entirely.
 *
 * @param {any} req
 * @returns {boolean}
 */
export function originAllowed(req) {
  const origin = req.headers?.origin;
  if (typeof origin !== 'string' || origin === '') return true;
  const host = req.headers?.host;
  if (typeof host !== 'string' || host === '') return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Read and parse a JSON body with a hard size cap.
 *
 * @param {any} req
 * @returns {Promise<{ok: boolean, data?: any, error?: string}>}
 */
async function readJsonBody(req) {
  const declared = Number(req.headers?.['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, error: 'request body is too large' };
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return { ok: false, error: 'request body is too large' };
    chunks.push(chunk);
  }
  if (size === 0) return { ok: true, data: {} };
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'request body must be a JSON object' };
    }
    return { ok: true, data: parsed };
  } catch {
    return { ok: false, error: 'request body is not valid JSON' };
  }
}

/**
 * Build the status payload the settings page renders.
 *
 * @param {import('./config.mjs').SyncConfig} config
 * @param {RouteDeps} deps
 * @returns {Promise<Record<string, any>>}
 */
async function buildStatus(config, deps) {
  const git = await probeGit();
  const repo = new Git(config.home);
  const repository = git.available ? await repo.isRepo() : false;
  const status = readStatus(config.home);

  /** @type {Record<string, any>} */
  const lines = {};
  for (const key of /** @type {const} */ (['hot', 'snapshot', 'workspace', 'release'])) {
    const line = config.lines[key];
    const entry = status[key] ?? {};
    /** @type {Record<string, any>} */
    const view = {
      enabled: line.enabled,
      branch: line.branch,
      lastSuccessAt: entry.lastSuccessAt ?? null,
      lastError: entry.lastError ?? null,
      lastErrorAt: entry.lastErrorAt ?? null,
    };
    if (key === 'snapshot') view.intervalMs = line.intervalMs;
    if (key === 'hot') {
      view.intervalMs = line.intervalMs;
      view.debounceMs = line.debounceMs;
      view.paths = line.paths;
    }
    if (key === 'workspace') view.source = line.source;
    lines[key] = view;
  }

  const t = dictionary(resolveLocale(config, deps.hostLocale?.()));
  const nextStep = (() => {
    if (!git.available) return t.onboarding.missingGit(git.reason ?? '');
    if (!repository) return t.onboarding.missingRepo();
    if (config.remote === '') return t.onboarding.missingRemote('dsh-sync');
    return null;
  })();

  return {
    version: 1,
    home: config.home,
    worktree: config.worktree,
    configPath: config.configPath,
    remote: config.remote,
    remoteConfigured: config.remote !== '',
    repository,
    git: { available: git.available, version: git.version ?? null, reason: git.reason ?? null },
    lines,
    nextStep,
    locale: resolveLocale(config, deps.hostLocale?.()),
  };
}

/**
 * Validate and persist a partial config update from the settings page.
 *
 * Only the fields the page owns are accepted. Everything else in the file is
 * preserved, so a hand-written comment block or an unrelated key survives a
 * round trip through the UI.
 *
 * @param {Record<string, any>} body
 * @param {import('./i18n.mjs').Dict} t
 * @returns {{ok: true, patch: Record<string, any>} | {ok: false, error: string}}
 */
export function validateConfigPatch(body, t = dictionary('en')) {
  /** @type {Record<string, any>} */
  const patch = {};

  if (body.remote !== undefined) {
    if (typeof body.remote !== 'string') return { ok: false, error: 'remote must be a string' };
    const problem = remoteProblem(body.remote, t);
    if (problem !== null && body.remote.trim() !== '') return { ok: false, error: problem };
    patch.remote = body.remote.trim();
  }

  if (body.locale !== undefined) {
    if (body.locale !== 'zh' && body.locale !== 'en') {
      return { ok: false, error: 'locale must be "zh" or "en"' };
    }
    patch.locale = body.locale;
  }

  if (body.workspace !== undefined) {
    const workspace = body.workspace;
    if (workspace === null || typeof workspace !== 'object' || Array.isArray(workspace)) {
      return { ok: false, error: 'workspace must be an object' };
    }
    /** @type {Record<string, any>} */
    const next = {};
    if (workspace.enabled !== undefined) {
      if (typeof workspace.enabled !== 'boolean') {
        return { ok: false, error: 'workspace.enabled must be a boolean' };
      }
      next.enabled = workspace.enabled;
    }
    if (workspace.source !== undefined) {
      if (typeof workspace.source !== 'string') {
        return { ok: false, error: 'workspace.source must be a string' };
      }
      const source = workspace.source.trim();
      if (source !== '' && !existsSync(source)) {
        return { ok: false, error: t.workspace.missing(source) };
      }
      next.source = source;
      // Enabling with a source in one request is the common case; require one
      // only when the caller asks to turn the line on.
      if (next.enabled === true && source === '') {
        return { ok: false, error: 'workspace.source is required to enable the line' };
      }
    }
    patch.workspace = next;
  }

  if (body.lines !== undefined) {
    if (body.lines === null || typeof body.lines !== 'object' || Array.isArray(body.lines)) {
      return { ok: false, error: 'lines must be an object' };
    }
    /** @type {Record<string, any>} */
    const lines = {};
    for (const key of ['hot', 'snapshot']) {
      const incoming = body.lines[key];
      if (incoming === undefined) continue;
      if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) {
        return { ok: false, error: `lines.${key} must be an object` };
      }
      /** @type {Record<string, any>} */
      const next = {};
      if (incoming.enabled !== undefined) {
        if (typeof incoming.enabled !== 'boolean') {
          return { ok: false, error: `lines.${key}.enabled must be a boolean` };
        }
        next.enabled = incoming.enabled;
      }
      if (incoming.intervalMs !== undefined) {
        const ms = Number(incoming.intervalMs);
        // A minute is the floor: a shorter loop would fight the hot line's own
        // debounce and produce a commit per turn.
        if (!Number.isFinite(ms) || ms < 60_000) {
          return { ok: false, error: `lines.${key}.intervalMs must be at least 60000` };
        }
        next.intervalMs = Math.round(ms);
      }
      lines[key] = next;
    }
    patch.lines = lines;
  }

  return { ok: true, patch };
}

/**
 * Apply a validated patch to the config file.
 *
 * @param {string} home
 * @param {Record<string, any>} patch
 */
function applyPatch(home, patch) {
  const { data } = readConfigFile(home);
  const current = structuredClone(data);
  if (patch.remote !== undefined) current.remote = patch.remote;
  if (patch.locale !== undefined) current.locale = patch.locale;
  if (patch.workspace !== undefined) {
    current.lines = current.lines ?? {};
    current.lines.workspace = { ...(current.lines.workspace ?? {}), ...patch.workspace };
  }
  if (patch.lines !== undefined) {
    current.lines = current.lines ?? {};
    for (const [key, value] of Object.entries(patch.lines)) {
      current.lines[key] = { ...(current.lines[key] ?? {}), ...value };
    }
  }
  writeConfigFile(home, current);
}

/**
 * Register every route on the host's web server.
 *
 * @param {any} webServer - the profile's `webServer` service.
 * @param {RouteDeps} deps
 * @returns {Array<() => void>} disposers for each route.
 */
export function registerRoutes(webServer, deps) {
  if (!webServer || typeof webServer.register !== 'function') return [];

  const disposers = [];

  /** @param {string} path @param {(req: any, res: any) => Promise<void>|void} handler */
  const register = (path, handler) => {
    const wrapped = async (req, res) => {
      try {
        const method = (req.method ?? 'GET').toUpperCase();
        const mutating = method !== 'GET' && method !== 'HEAD';
        if (mutating && !originAllowed(req)) {
          sendJson(res, 403, { error: 'cross-origin request refused' });
          return;
        }
        await handler(req, res);
      } catch (error) {
        deps.warn?.(`${path} failed: ${error?.message ?? error}`);
        if (!res.headersSent) sendJson(res, 500, { error: String(error?.message ?? error) });
      }
    };
    const disposer = webServer.register({ kind: 'exact', path, handler: wrapped });
    if (typeof disposer === 'function') disposers.push(disposer);
  };

  register(`${API_PREFIX}/status`, async (req, res) => {
    if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    const config = loadConfig({ home: deps.home, locale: deps.locale });
    sendJson(res, 200, await buildStatus(config, deps));
  });

  register(`${API_PREFIX}/config`, async (req, res) => {
    if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    const body = await readJsonBody(req);
    if (!body.ok) {
      sendJson(res, 400, { error: body.error });
      return;
    }
    const existing = loadConfig({ home: deps.home, locale: deps.locale });
    const t = dictionary(resolveLocale(existing, deps.hostLocale?.()));
    const validated = validateConfigPatch(body.data ?? {}, t);
    if (!validated.ok) {
      sendJson(res, 400, { error: validated.error });
      return;
    }
    applyPatch(deps.home, validated.patch);

    const updated = loadConfig({ home: deps.home, locale: deps.locale });
    // A first-time remote turns an idle install into a working one, so run the
    // setup immediately rather than making the person restart DSH.
    if (existing.remote === '' && updated.remote !== '') {
      try {
        await deps.onSetup();
      } catch (error) {
        sendJson(res, 500, {
          error: String(error?.message ?? error),
          status: await buildStatus(updated, deps),
        });
        return;
      }
    }
    sendJson(res, 200, await buildStatus(loadConfig({ home: deps.home, locale: deps.locale }), deps));
  });

  register(`${API_PREFIX}/snapshot`, async (req, res) => {
    if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    const config = loadConfig({ home: deps.home, locale: deps.locale });
    if (config.remote === '') {
      sendJson(res, 409, { error: 'no remote configured' });
      return;
    }
    deps.onSnapshot();
    sendJson(res, 202, { scheduled: true });
  });

  register(`${API_PREFIX}/release`, async (req, res) => {
    if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    const config = loadConfig({ home: deps.home, locale: deps.locale });
    if (!config.lines.release.enabled) {
      sendJson(res, 409, { error: 'the release line is disabled' });
      return;
    }
    deps.onRelease();
    sendJson(res, 202, { scheduled: true });
  });

  return disposers;
}
