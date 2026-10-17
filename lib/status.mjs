/**
 * Status reporting shared by the plugin and the detached scripts.
 *
 * `<home>/<STATE_DIR>/.sync-status.json` is the observable record of the last
 * success and last error per line. It is written even when the backup itself
 * fails, because "silently stopped backing up" is the failure mode that costs
 * people data.
 *
 * @module dsh-auto-sync/lib/status
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './config.mjs';

/** Status file name inside {@link STATE_DIR}. */
export const STATUS_FILE = 'status.json';

/** A line that has not succeeded for this long is reported as stale. */
export const STALE_AFTER_MS = 48 * 60 * 60 * 1000;

/**
 * @typedef {object} LineStatus
 * @property {string} [lastSuccessAt]
 * @property {string} [lastError]
 * @property {string} [lastErrorAt]
 */

/**
 * @param {string} home
 * @returns {string} the status file path.
 */
export function statusPath(home) {
  return join(home, STATE_DIR, STATUS_FILE);
}

/**
 * @param {string} home
 * @returns {Record<string, LineStatus>}
 */
export function readStatus(home) {
  const path = statusPath(home);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.lines && typeof parsed.lines === 'object') {
      return parsed.lines;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Merge one line's state into the status file.
 * A read-modify-write over a tiny file; a torn write is possible but the file
 * is diagnostics only and is rewritten on the next run.
 *
 * @param {string} home
 * @param {string} line
 * @param {LineStatus} patch
 */
export function recordStatus(home, line, patch) {
  try {
    const lines = readStatus(home);
    lines[line] = { ...(lines[line] ?? {}), ...patch };
    const payload = { version: 1, updatedAt: new Date().toISOString(), lines };
    writeFileSync(statusPath(home), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  } catch {
    // Diagnostics must never break a backup.
  }
}

/**
 * @param {string} home
 * @param {string} line
 */
export function noteSuccess(home, line) {
  recordStatus(home, line, {
    lastSuccessAt: new Date().toISOString(),
    lastError: undefined,
    lastErrorAt: undefined,
  });
}

/**
 * @param {string} home
 * @param {string} line
 * @param {unknown} message
 */
export function noteFailure(home, line, message) {
  recordStatus(home, line, {
    lastError: String(message ?? 'unknown error').trim().slice(0, 500),
    lastErrorAt: new Date().toISOString(),
  });
}

/**
 * Describe lines that have not succeeded recently.
 *
 * @param {string} home
 * @param {string[]} lines
 * @param {number} [now]
 * @returns {string[]} human-readable stale descriptions.
 */
export function staleLines(home, lines, now = Date.now()) {
  const status = readStatus(home);
  const stale = [];
  for (const line of lines) {
    const entry = status[line] ?? {};
    const at = entry.lastSuccessAt ? Date.parse(entry.lastSuccessAt) : Number.NaN;
    if (Number.isNaN(at)) stale.push(`${line}=never`);
    else if (now - at > STALE_AFTER_MS) stale.push(`${line}=${Math.round((now - at) / 3_600_000)}h`);
  }
  return stale;
}
