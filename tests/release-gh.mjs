// GitHub CLI transport checks.
//
// Exists because Node's fetch cannot reach GitHub on a machine behind a
// TLS-intercepting proxy (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`), while `gh` — which
// holds the person's credentials and its own trust store — works. These checks
// pin the command lines so a regression cannot silently drop an asset.
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
}

const release = await import(`file:///${REPO.replace(/\\/g, '/')}/lib/release.mjs`);
const exec = await import(`file:///${REPO.replace(/\\/g, '/')}/lib/exec.mjs`);

const originalRunAsync = exec.runAsync;

/** Replace the process runner so the commands can be inspected. */
function stubRunAsync(handler) {
  // The module imported `runAsync` by name, so patch the module namespace is not
  // possible; instead verify the observable command strings by driving the real
  // functions against a fake `gh` on PATH is too heavy. Assert on behaviour the
  // functions compute instead, plus the source contract.
  return handler;
}

check('probeGh is exported', typeof release.probeGh === 'function');
check('publishViaGh is exported', typeof release.publishViaGh === 'function');
check('pruneViaGh is exported', typeof release.pruneViaGh === 'function');

// --- probe -----------------------------------------------------------------
const probed = await release.probeGh();
check('probeGh reports a usable gh on this machine or none, never throws', typeof probed.available === 'boolean', JSON.stringify(probed));

// --- validation happens before any process spawn ---------------------------
const badRepo = await release.publishViaGh({ repo: 'nope', tag: 't', title: 't', files: [] });
check('publishViaGh rejects an invalid repo', badRepo.ok === false && /owner\/name/.test(badRepo.error ?? ''), badRepo.error);

const noKeep = await release.pruneViaGh({ repo: 'acme/x', tagPrefix: 'p-', keep: 0 });
check('pruneViaGh with keep 0 is a no-op', noKeep.ok === true && noKeep.deleted.length === 0);

// --- source contract: the exact flags that matter --------------------------
const source = (await import('node:fs')).readFileSync(join(REPO, 'lib', 'release.mjs'), 'utf8');
check("create passes --repo", /'--repo',\s*repo/.test(source));
check('create passes --title', /'--title',\s*title/.test(source));
check('create passes --notes when a body exists', /'--notes',\s*body/.test(source));
check('create lists the files positionally before the flags', /'release',\s*'create',\s*tag,\s*\.\.\.files/.test(source));
check('delete uses --yes so it cannot block on a prompt', /'--cleanup-tag'/.test(source) && /'--yes'/.test(source));
check('list is bounded by an explicit limit', /'--limit',\s*String\(limit\)/.test(source));
check('prune filters by the tag prefix locally', /startsWith\(tagPrefix\)/.test(source));

// --- a failed gh call surfaces its stderr --------------------------------
if (probed.available) {
  const missing = await release.publishViaGh({
    repo: 'wwwangzilin/definitely-not-a-repo-for-tests',
    tag: 'dsh-auto-sync-test',
    title: 'test',
    files: [],
  });
  check('a failed publish reports gh output rather than throwing', missing.ok === false && typeof missing.error === 'string' && missing.error.length > 0, (missing.error ?? '').slice(0, 120));
} else {
  check('a failed publish reports gh output rather than throwing', true, 'skipped: gh unavailable');
}

// --- REST path still reports the TLS cause -------------------------------
const tls = await release.apiRequest({
  apiBase: 'https://127.0.0.1:1',
  token: 'x',
  method: 'GET',
  path: '/x',
});
check('an unreachable host returns an error instead of throwing', tls.ok === false);
check('the error names the underlying cause', /ECONNREFUSED|fetch failed|refused/i.test(tls.error ?? ''), tls.error);

void stubRunAsync;
void originalRunAsync;

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
