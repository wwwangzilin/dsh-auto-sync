// Release publishing checks against a mocked fetch: tag naming, repo parsing,
// idempotent release creation, token resolution and pruning order.
import { writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
}

const release = await import(`file:///${REPO.replace(/\\/g, '/')}/lib/release.mjs`);

// --- repo and tag ----------------------------------------------------------
check('parses owner/name', JSON.stringify(release.parseRepo('acme/backup')) === '{"owner":"acme","name":"backup"}');
check('rejects a bare name', release.parseRepo('backup') === null);
check('rejects an empty value', release.parseRepo('') === null);
check('rejects a path-like value', release.parseRepo('https://github.com/a/b') === null);

const tagged = release.tagFor('dsh-backup-', new Date('2026-03-04T05:06:07.000Z'));
check('tag encodes the timestamp', tagged === 'dsh-backup-2026-03-04-05-06-07', tagged);
check(
  'tags sort lexicographically in time order',
  ['2026-01-01', '2026-02-01', '2026-03-01']
    .map((d) => release.tagFor('p-', new Date(`${d}T00:00:00.000Z`)))
    .sort()
    .join() === ['2026-01-01', '2026-02-01', '2026-03-01'].map((d) => `p-${d}-00-00-00`).join(),
);

// --- token resolution ------------------------------------------------------
delete process.env.DSH_AUTO_SYNC_GITHUB_TOKEN;
delete process.env.GITHUB_TOKEN;
const noEnvToken = await release.resolveToken('DSH_AUTO_SYNC_GITHUB_TOKEN');
// With no environment variable the module falls back to `gh auth token`, which
// succeeds on a machine with the GitHub CLI logged in. Both outcomes are valid;
// what matters is that a usable token or an actionable reason comes back.
check(
  'no env var yields a token or an actionable reason',
  (noEnvToken.token !== undefined && /gh auth token/.test(noEnvToken.source ?? '')) ||
    (noEnvToken.token === undefined && /DSH_AUTO_SYNC_GITHUB_TOKEN|GITHUB_TOKEN|gh auth login/.test(noEnvToken.reason ?? '')),
  noEnvToken.source ? `token via ${noEnvToken.source}` : noEnvToken.reason,
);

process.env.GITHUB_TOKEN = 'gh-token';
const fromGithub = await release.resolveToken('DSH_AUTO_SYNC_GITHUB_TOKEN');
check('GITHUB_TOKEN is honored', fromGithub.token === 'gh-token' && /GITHUB_TOKEN/.test(fromGithub.source ?? ''), fromGithub.source);
process.env.DSH_AUTO_SYNC_GITHUB_TOKEN = 'specific-token';
const fromSpecific = await release.resolveToken('DSH_AUTO_SYNC_GITHUB_TOKEN');
check('the configured env var wins over GITHUB_TOKEN', fromSpecific.token === 'specific-token', fromSpecific.source);
delete process.env.GITHUB_TOKEN;
delete process.env.DSH_AUTO_SYNC_GITHUB_TOKEN;

// --- mocked transport ------------------------------------------------------
/** Records every request the module makes. */
const calls = [];
let nextReleaseStatus = 201;
let existingReleaseId = 900;

globalThis.fetch = async (url, init = {}) => {
  const record = { url: String(url), method: init.method ?? 'GET', body: init.body };
  calls.push(record);
  const respond = (status, payload) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  });

  if (url.includes('/releases') && record.method === 'POST' && !url.includes('/assets')) {
    if (nextReleaseStatus === 422) return respond(422, { message: 'Validation Failed', errors: [{ code: 'already_exists' }] });
    return respond(201, { id: 42, upload_url: 'https://uploads.github.com/...' });
  }
  if (url.includes('/releases/tags/')) {
    return respond(200, { id: existingReleaseId, upload_url: 'https://uploads.github.com/...' });
  }
  if (url.includes('/releases') && record.method === 'GET') {
    return respond(200, [
      { id: 1, tag_name: 'dsh-backup-2026-03-01-00-00-00' },
      { id: 2, tag_name: 'dsh-backup-2026-02-01-00-00-00' },
      { id: 3, tag_name: 'dsh-backup-2026-01-01-00-00-00' },
      { id: 4, tag_name: 'unrelated-v1.0.0' },
    ]);
  }
  if (url.includes('/releases/') && record.method === 'DELETE') return respond(204, '');
  if (url.includes('/assets')) {
    return respond(201, { id: 7, name: 'asset.tar.gz' });
  }
  return respond(404, { message: 'not found' });
};

const apiBase = 'https://api.github.com';

const created = await release.ensureRelease({
  apiBase,
  token: 't',
  repo: 'acme/backup',
  tag: 'dsh-backup-2026-03-04-05-06-07',
  title: 'backup',
});
check('release created', created.ok === true && created.id === 42, String(created.id));
check(
  'create posts to the right path',
  calls.some((c) => c.method === 'POST' && c.url === `${apiBase}/repos/acme/backup/releases`),
  calls.map((c) => `${c.method} ${c.url}`).join(' | '),
);

calls.length = 0;
nextReleaseStatus = 422;
const existing = await release.ensureRelease({
  apiBase,
  token: 't',
  repo: 'acme/backup',
  tag: 'dsh-backup-2026-03-04-05-06-07',
  title: 'backup',
});
check('an existing tag is reused rather than failing', existing.ok === true && existing.id === existingReleaseId, String(existing.id));

calls.length = 0;
const uploadDir = 'D:/tmp/release-upload';
if (existsSync(uploadDir)) rmSync(uploadDir, { recursive: true, force: true });
mkdirSync(uploadDir, { recursive: true });
const uploadFile = join(uploadDir, 'dsh-backup-x.tar.gz');
writeFileSync(uploadFile, Buffer.alloc(1024, 7));
const uploaded = await release.uploadAsset({
  apiBase,
  token: 't',
  repo: 'acme/backup',
  releaseId: 42,
  file: uploadFile,
  contentType: 'application/gzip',
});
check('asset uploaded', uploaded.ok === true, uploaded.error ?? '');
check(
  'upload targets uploads host, not the api host',
  calls.some((c) => c.url.startsWith('https://uploads.github.com/repos/acme/backup/releases/42/assets')),
  calls.map((c) => c.url).join(' | '),
);
check(
  'upload names the asset after the file',
  calls.some((c) => c.url.includes('name=dsh-backup-x.tar.gz')),
  calls.map((c) => c.url).join(' | '),
);

calls.length = 0;
const pruned = await release.pruneReleases({ apiBase, token: 't', repo: 'acme/backup', tagPrefix: 'dsh-backup-', keep: 2 });
check('prune keeps the requested number', pruned.ok === true, pruned.error ?? '');
check('prune only touches its own tag prefix', !calls.some((c) => c.url.endsWith('/releases/4')), calls.map((c) => c.url).join(' | '));
check('prune deletes the oldest first', JSON.stringify(pruned.deleted) === JSON.stringify(['dsh-backup-2026-01-01-00-00-00']), JSON.stringify(pruned.deleted));

calls.length = 0;
const keepAll = await release.pruneReleases({ apiBase, token: 't', repo: 'acme/backup', tagPrefix: 'dsh-backup-', keep: 5 });
check('prune with a larger keep deletes nothing', keepAll.ok === true && keepAll.deleted.length === 0);
check('a no-op prune makes no delete call', !calls.some((c) => c.method === 'DELETE'));

const badRepo = await release.ensureRelease({ apiBase, token: 't', repo: 'nope', tag: 'x', title: 'x' });
check('an invalid repo fails before any request', badRepo.ok === false && /owner\/name/.test(badRepo.error ?? ''), badRepo.error);

rmSync(uploadDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
