// Archive and split checks against a throwaway fixture tree.
import { mkdirSync, writeFileSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
}

const archive = await import(`file:///${REPO.replace(/\\/g, '/')}/lib/archive.mjs`);

// --- fixture ---------------------------------------------------------------
const ROOT = 'D:/tmp/release-test';
if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
const HOME = join(ROOT, 'home');
mkdirSync(join(HOME, 'sessions'), { recursive: true });
mkdirSync(join(HOME, '.git'), { recursive: true });
mkdirSync(join(HOME, 'profiles', 'desktop', 'node_modules', 'pkg'), { recursive: true });
mkdirSync(join(HOME, 'sync-plugin'), { recursive: true });
writeFileSync(join(HOME, 'settings.yaml'), 'agent: x\n');
writeFileSync(join(HOME, 'sessions', 'a.jsonl'), '{"t":1}\n');
writeFileSync(join(HOME, '.credentials.yaml'), 'key: super-secret\n');
writeFileSync(join(HOME, '.git', 'HEAD'), 'ref: refs/heads/main\n');
writeFileSync(join(HOME, 'debug.log'), 'noise\n');
writeFileSync(join(HOME, 'profiles', 'desktop', 'node_modules', 'pkg', 'index.js'), 'x\n');
writeFileSync(join(HOME, 'sync-plugin', 'status.json'), '{}\n');
writeFileSync(join(HOME, 'sync-plugin', 'config.json'), '{"remote":"x"}\n');

check('tar is available', (await archive.probeTar()).available === true);

// --- default archive -------------------------------------------------------
const out1 = join(ROOT, 'default.tar.gz');
const built = await archive.buildArchive({ sourceDir: HOME, outFile: out1 });
check('archive built', built.ok === true, built.error ?? '');
check('archive has bytes', (built.bytes ?? 0) > 0, String(built.bytes));

/** List archive members without extracting. */
const listTar = (file) =>
  execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);

const members1 = listTar(out1);
check('archive carries settings', members1.some((m) => m.includes('settings.yaml')));
check('archive carries sessions', members1.some((m) => m.includes('sessions/a.jsonl')));
check('archive excludes secrets by default', !members1.some((m) => m.includes('.credentials.yaml')), members1.join(','));
check('archive excludes .git', !members1.some((m) => m.startsWith('./.git/') || m.includes('/.git/')), members1.join(','));
check('archive excludes node_modules by default', !members1.some((m) => m.includes('node_modules')), members1.join(','));
check('archive excludes logs', !members1.some((m) => m.endsWith('.log')), members1.join(','));
check(
  'archive keeps the plugin config but not its status file',
  members1.some((m) => m.includes('sync-plugin/config.json')) &&
    !members1.some((m) => m.includes('status.json')),
  members1.join(','),
);

// --- opt-ins ---------------------------------------------------------------
const out2 = join(ROOT, 'with-deps.tar.gz');
const built2 = await archive.buildArchive({
  sourceDir: HOME,
  outFile: out2,
  includeNodeModules: true,
  includeSecrets: true,
});
check('archive with opt-ins built', built2.ok === true, built2.error ?? '');
const members2 = listTar(out2);
check('includeNodeModules includes dependencies', members2.some((m) => m.includes('node_modules/pkg/index.js')), members2.join(','));
check('includeSecrets includes the credential file', members2.some((m) => m.includes('.credentials.yaml')), members2.join(','));

// --- split -----------------------------------------------------------------
const parts = await archive.splitFile(out1, Math.max(1, Math.floor(statSync(out1).size / 3)));
check('split produced several parts', parts.length >= 2, String(parts.length));
check('every part exists', parts.every((p) => existsSync(p.path)));
check(
  'part sizes sum to the file',
  parts.reduce((s, p) => s + p.bytes, 0) === statSync(out1).size,
  `${parts.reduce((s, p) => s + p.bytes, 0)} vs ${statSync(out1).size}`,
);
check('every part has a sha256', parts.every((p) => /^[0-9a-f]{64}$/.test(p.sha256)));

// A single part keeps the plain name: no pointless rename in the common case.
const small = join(ROOT, 'small.tar.gz');
writeFileSync(small, 'x'.repeat(100));
const single = await archive.splitFile(small, 1_000_000);
check('a small file stays one part under its own name', single.length === 1 && single[0].path === small, single.map((p) => p.path).join(','));

// Reassembly must reproduce the original bytes.
const rejoined = join(ROOT, 'rejoined.tar.gz');
const chunks = parts.map((p) => readFileSync(p.path));
writeFileSync(rejoined, Buffer.concat(chunks));
check(
  'concatenating the parts reproduces the archive',
  (await archive.sha256File(rejoined)) === (await archive.sha256File(out1)),
);

// --- manifest --------------------------------------------------------------
const manifestText = archive.buildManifest({
  home: HOME,
  createdAt: '2026-01-01T00:00:00.000Z',
  archiveName: 'a.tar.gz',
  parts: parts.map((p) => ({ name: p.path.split(/[\\/]/).pop(), bytes: p.bytes, sha256: p.sha256 })),
  options: { includeNodeModules: false, includeSecrets: false },
});
const manifest = JSON.parse(manifestText);
check('manifest declares its schema', manifest.schema === 'dsh-auto-sync/archive@1', manifest.schema);
check('manifest counts the parts', manifest.partCount === parts.length);
check(
  'manifest totals the bytes',
  manifest.totalBytes === parts.reduce((s, p) => s + p.bytes, 0),
);
check('manifest carries restore steps', Array.isArray(manifest.restore) && manifest.restore.length > 0);

rmSync(ROOT, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
