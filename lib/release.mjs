/**
 * Publishing an archive as a release asset.
 *
 * A release is the right home for a full backup: one downloadable file per
 * snapshot, no growth in repository history, and a restore that needs nothing
 * from this plugin — download, decompress, done.
 *
 * Currently speaks the GitHub Releases API, which is what a self-hosted
 * `MyHarness`-style repository offers. The transport is plain `fetch`, so an
 * enterprise instance only needs a different `apiBase`; the token is never
 * written to disk by this module.
 *
 * @module dsh-auto-sync/lib/release
 */

import { openAsBlob } from 'node:fs';
import { stat } from 'node:fs/promises';
import { runAsync } from './exec.mjs';

/** Default GitHub API root. */
export const DEFAULT_API_BASE = 'https://api.github.com';

/**
 * Resolve an API token, in priority order:
 *
 *   1. the environment variable named by the config (default
 *      `DSH_AUTO_SYNC_GITHUB_TOKEN`),
 *   2. `GITHUB_TOKEN`, which CI environments already set,
 *   3. `gh auth token`, so a machine with the GitHub CLI logged in needs no
 *      further setup.
 *
 * Only the third step touches a process, and a missing `gh` is not an error:
 * it simply contributes nothing.
 *
 * @param {string} [envName]
 * @returns {Promise<{token?: string, source?: string, reason?: string}>}
 */
export async function resolveToken(envName = 'DSH_AUTO_SYNC_GITHUB_TOKEN') {
  for (const name of [envName, 'GITHUB_TOKEN']) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim() !== '') {
      return { token: value.trim(), source: `environment ${name}` };
    }
  }
  const gh = await runAsync('gh', ['auth', 'token']);
  if (gh.code === 0 && gh.out.trim() !== '') {
    return { token: gh.out.trim().split('\n')[0].trim(), source: 'gh auth token' };
  }
  return {
    reason: `no token: set ${envName} or GITHUB_TOKEN, or run \`gh auth login\``,
  };
}

/**
 * Parse `owner/name`.
 *
 * @param {string} value
 * @returns {{owner: string, name: string} | null}
 */
export function parseRepo(value) {
  const match = /^\s*([\w.-]+)\/([\w.-]+)\s*$/.exec(value ?? '');
  if (match === null) return null;
  return { owner: match[1], name: match[2] };
}

/**
 * Call the release API.
 *
 * @param {object} options
 * @param {string} options.apiBase
 * @param {string} options.token
 * @param {string} options.method
 * @param {string} options.path
 * @param {unknown} [options.body]
 * @returns {Promise<{ok: boolean, status: number, data: any, error?: string}>}
 */
export async function apiRequest({ apiBase, token, method, path, body }) {
  /** @type {Record<string, string>} */
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'dsh-auto-sync',
  };
  if (body !== undefined) headers['content-type'] = 'application/json';

  let response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    // `fetch failed` alone is useless: the interesting part is the cause
    // (`UNABLE_TO_VERIFY_LEAF_SIGNATURE` behind a TLS-intercepting proxy,
    // `ENOTFOUND` for DNS, `ECONNREFUSED` for a blocked port). Surfacing it is
    // what turns a mystery into a fix.
    const cause = error?.cause;
    const code = cause?.code ?? cause?.errno ?? cause?.message;
    return {
      ok: false,
      status: 0,
      data: null,
      error: [String(error?.message ?? error), code ? `(${code})` : ''].filter(Boolean).join(' '),
    };
  }

  const text = await response.text();
  let data = null;
  if (text !== '') {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!response.ok) {
    const message =
      data && typeof data === 'object' && typeof data.message === 'string'
        ? data.message
        : text.slice(0, 200);
    return { ok: false, status: response.status, data, error: `HTTP ${response.status}: ${message}` };
  }
  return { ok: true, status: response.status, data };
}

/**
 * Create a release, or return the existing one for that tag.
 *
 * Re-running a backup with the same tag must not fail: a retry after a network
 * error is the common case, and the tag encodes the snapshot time, so an
 * existing release means a previous attempt already created it.
 *
 * @param {object} options
 * @param {string} options.apiBase
 * @param {string} options.token
 * @param {string} options.repo - `owner/name`.
 * @param {string} options.tag
 * @param {string} options.title
 * @param {string} [options.body]
 * @returns {Promise<{ok: boolean, id?: number, uploadUrl?: string, error?: string}>}
 */
export async function ensureRelease({ apiBase, token, repo, tag, title, body }) {
  const parsed = parseRepo(repo);
  if (parsed === null) return { ok: false, error: `repo must be "owner/name", got "${repo}"` };

  const created = await apiRequest({
    apiBase,
    token,
    method: 'POST',
    path: `/repos/${parsed.owner}/${parsed.name}/releases`,
    body: { tag_name: tag, name: title, body: body ?? '', draft: false, prerelease: false },
  });
  if (created.ok) {
    return { ok: true, id: created.data.id, uploadUrl: created.data.upload_url };
  }

  // 422 is GitHub's "tag exists": reuse it so a retry is idempotent.
  if (created.status === 422) {
    const existing = await apiRequest({
      apiBase,
      token,
      method: 'GET',
      path: `/repos/${parsed.owner}/${parsed.name}/releases/tags/${encodeURIComponent(tag)}`,
    });
    if (existing.ok) {
      return { ok: true, id: existing.data.id, uploadUrl: existing.data.upload_url };
    }
    return { ok: false, error: `release exists but could not be read: ${existing.error}` };
  }
  return { ok: false, error: created.error };
}

/**
 * Upload one asset to a release.
 *
 * Uses `openAsBlob` so the payload streams from disk instead of being read into
 * memory: a full home archive is measured in gigabytes.
 *
 * @param {object} options
 * @param {string} options.apiBase
 * @param {string} options.token
 * @param {string} options.repo
 * @param {number} options.releaseId
 * @param {string} options.file
 * @param {string} [options.name] - asset name; defaults to the file name.
 * @param {string} [options.contentType]
 * @returns {Promise<{ok: boolean, id?: number, name?: string, error?: string}>}
 */
export async function uploadAsset({
  apiBase,
  token,
  repo,
  releaseId,
  file,
  name,
  contentType = 'application/octet-stream',
}) {
  const parsed = parseRepo(repo);
  if (parsed === null) return { ok: false, error: `repo must be "owner/name", got "${repo}"` };

  let info;
  try {
    info = await stat(file);
  } catch (error) {
    return { ok: false, error: `cannot read ${file}: ${error.message}` };
  }

  const assetName = name ?? file.split(/[\\/]/).pop();
  // uploads.<host> is a different origin from api.<host>: the API redirects
  // asset uploads there, and building it here avoids a redirect that would drop
  // the streamed body.
  const uploadBase = apiBase.replace(/^https?:\/\/api\./, 'https://uploads.');
  const url = `${uploadBase}/repos/${parsed.owner}/${parsed.name}/releases/${releaseId}/assets?name=${encodeURIComponent(assetName)}`;

  let response;
  try {
    const blob = await openAsBlob(file);
    response = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': contentType,
        'content-length': String(info.size),
        'x-github-api-version': '2022-11-28',
        'user-agent': 'dsh-auto-sync',
      },
      body: blob,
      duplex: 'half',
      signal: AbortSignal.timeout(30 * 60 * 1000),
    });
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }

  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!response.ok) {
    const message =
      data && typeof data === 'object' && typeof data.message === 'string'
        ? data.message
        : String(text).slice(0, 200);
    return { ok: false, error: `HTTP ${response.status}: ${message}` };
  }
  return { ok: true, id: data.id, name: data.name };
}

/**
 * Delete releases whose tag starts with `tagPrefix`, keeping the newest `keep`.
 *
 * Pruning is opt-in and bounded: a backup tool that silently accumulates
 * hundreds of gigabyte releases will eventually hit a quota, but deleting the
 * wrong thing is worse, so only tags this line created are ever considered.
 *
 * @param {object} options
 * @param {string} options.apiBase
 * @param {string} options.token
 * @param {string} options.repo
 * @param {string} options.tagPrefix
 * @param {number} options.keep - releases to retain, including the one just made.
 * @param {number} [options.pageSize]
 * @returns {Promise<{ok: boolean, deleted: string[], error?: string}>}
 */
export async function pruneReleases({ apiBase, token, repo, tagPrefix, keep, pageSize = 50 }) {
  const parsed = parseRepo(repo);
  if (parsed === null) return { ok: false, deleted: [], error: `repo must be "owner/name"` };
  if (!(keep > 0)) return { ok: true, deleted: [] };

  const listed = await apiRequest({
    apiBase,
    token,
    method: 'GET',
    path: `/repos/${parsed.owner}/${parsed.name}/releases?per_page=${pageSize}`,
  });
  if (!listed.ok) return { ok: false, deleted: [], error: listed.error };
  if (!Array.isArray(listed.data)) return { ok: true, deleted: [] };

  const ours = listed.data
    .filter((release) => typeof release?.tag_name === 'string' && release.tag_name.startsWith(tagPrefix))
    .sort((a, b) => String(b.tag_name).localeCompare(String(a.tag_name)));

  const deleted = [];
  for (const release of ours.slice(keep)) {
    const removed = await apiRequest({
      apiBase,
      token,
      method: 'DELETE',
      path: `/repos/${parsed.owner}/${parsed.name}/releases/${release.id}`,
    });
    if (removed.ok) deleted.push(release.tag_name);
  }
  return { ok: true, deleted };
}

/**
 * Build the tag for one snapshot.
 *
 * Lexicographically sortable and prefix-filterable, so pruning can order by tag
 * string alone without trusting the API's ordering.
 *
 * @param {string} prefix
 * @param {Date} [at]
 * @returns {string}
 */
export function tagFor(prefix, at = new Date()) {
  const iso = at.toISOString().replace(/[:.]/g, '-').replace('T', '-').slice(0, 19);
  return `${prefix}${iso}`;
}

// ---------------------------------------------------------------------------
// `gh` transport
// ---------------------------------------------------------------------------
//
// Node's `fetch` validates TLS against Node's own bundle, so an interception
// proxy (corporate MITM, a local accelerator that rewrites `hosts`) makes every
// request fail with opaque `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. The GitHub CLI is
// installed and configured on those same machines — it is how the person
// already uses GitHub — and it carries its own TLS and credential setup.
//
// Declaring a transport instead of assuming one keeps CI (token only, no gh)
// working through the REST path while the desktop case uses the CLI.

/**
 * Whether `gh` can be executed.
 * @returns {Promise<{available: boolean, version?: string}>}
 */
export async function probeGh() {
  const result = await runAsync('gh', ['--version']);
  if (result.code !== 0) return { available: false };
  return { available: true, version: result.out.split('\n')[0]?.trim() ?? '' };
}

/**
 * Publish a release and its assets through the GitHub CLI.
 *
 * One `gh release create` both creates the release and uploads every file, so
 * there is no idempotency dance: `--verify-tag` is not used because the tag is
 * created by this call, and an existing tag is reused by `gh` itself.
 *
 * @param {object} options
 * @param {string} options.repo - `owner/name`.
 * @param {string} options.tag
 * @param {string} options.title
 * @param {string} [options.body]
 * @param {string[]} options.files - absolute paths to upload.
 * @param {boolean} [options.draft]
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function publishViaGh({ repo, tag, title, body, files, draft = false }) {
  const parsed = parseRepo(repo);
  if (parsed === null) return { ok: false, error: `repo must be "owner/name", got "${repo}"` };

  const args = ['release', 'create', tag, ...files, '--repo', repo, '--title', title];
  if (typeof body === 'string' && body !== '') args.push('--notes', body);
  if (draft) args.push('--draft');

  const result = await runAsync('gh', args, { maxBuffer: 64 * 1024 * 1024 });
  if (result.code !== 0) {
    return { ok: false, error: (result.err || result.out || `gh exited ${result.code}`).trim().slice(0, 600) };
  }
  return { ok: true };
}

/**
 * Delete old releases through the GitHub CLI, keeping the newest `keep`.
 *
 * Listing is filtered locally by tag prefix for the same reason the REST path
 * filters: only tags this line created are ever considered for deletion.
 *
 * @param {object} options
 * @param {string} options.repo
 * @param {string} options.tagPrefix
 * @param {number} options.keep
 * @param {number} [options.limit] - how many releases to inspect.
 * @returns {Promise<{ok: boolean, deleted: string[], error?: string}>}
 */
export async function pruneViaGh({ repo, tagPrefix, keep, limit = 100 }) {
  if (!(keep > 0)) return { ok: true, deleted: [] };

  const listed = await runAsync('gh', [
    'release', 'list', '--repo', repo, '--limit', String(limit), '--json', 'tagName',
  ]);
  if (listed.code !== 0) {
    return { ok: false, deleted: [], error: (listed.err || listed.out).trim().slice(0, 400) };
  }
  let tags;
  try {
    tags = JSON.parse(listed.out).map((entry) => entry.tagName).filter((tag) => typeof tag === 'string');
  } catch (error) {
    return { ok: false, deleted: [], error: `could not parse gh release list: ${error.message}` };
  }

  const ours = tags.filter((tag) => tag.startsWith(tagPrefix)).sort().reverse();
  const deleted = [];
  for (const tag of ours.slice(keep)) {
    const removed = await runAsync('gh', ['release', 'delete', tag, '--repo', repo, '--yes', '--cleanup-tag']);
    if (removed.code === 0) deleted.push(tag);
  }
  return { ok: true, deleted };
}

