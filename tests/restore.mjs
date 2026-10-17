// Restore round trip: archive a fixture, split it, reassemble the parts, and
// extract — then assert the extracted tree matches what was archived.
//
// This is the property that actually matters for a backup: the bytes that come
// back must be the bytes that went in.
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
}

const archive = await import(`file:///${REPO.replace(/\\/g, '/')}/lib/archive.mjs`);

const ROOT = 'D:/tmp/restore-roundtrip';
if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
const HOME = join(ROOT, 'home');
mkdirSync(join(HOME, 'sessions'), { recursive: true });
mkdirSync(join(HOME, 'memory'), { recursive: true });
mkdirSync(join(HOME, 'profiles', 'desktop'), { recursive: true });

const files = {
  'settings.yaml': 'agent:\n  model: deepseek-flash\n  reasoning: high\n',
  'sessions/one.jsonl': '{"type":"message","text":"hello"}\n',
  'sessions/two.jsonl': '{"type":"message","text":"世界"}\n',
  'memory/decisions.md': '# decisions\n\n- keep backups\n',
  'profiles/desktop/package.json': '{"name":"dsh-profile-desktop"}\n',
  'profiles/desktop/cordis.patch.yml': '- id: x\n  name: y\n',
};
for (const [name, content] of Object.entries(files)) {
  writeFileSync(join(HOME, name), content);
}
// A file large enough to force several parts.
const big = join(HOME, 'sessions', 'big.bin');
writeFileSync(big, Buffer.alloc(300_000, 3));

const built = await archive.buildArchive({ sourceDir: HOME, outFile: join(ROOT, 'a.tar.gz') });
check('archive built', built.ok === true, built.error ?? '');

// gzip squeezes the 300 kB of zeroes to almost nothing, so the split size has to
// be derived from the real archive size to force more than one part.
const archiveBytes = (await import('node:fs')).statSync(join(ROOT, 'a.tar.gz')).size;
const parts = await archive.splitFile(join(ROOT, 'a.tar.gz'), Math.max(1, Math.floor(archiveBytes / 3)));
check('archive split into several parts', parts.length >= 2, `${parts.length} of ${archiveBytes} bytes`);

// Reassemble exactly as the manifest instructs.
const rejoined = join(ROOT, 'rejoined.tar.gz');
writeFileSync(rejoined, Buffer.concat(parts.map((p) => readFileSync(p.path))));
check(
  'reassembled file matches the archive',
  (await archive.sha256File(rejoined)) === (await archive.sha256File(join(ROOT, 'a.tar.gz'))),
);

// Extract and compare every file.
const OUT = join(ROOT, 'restored');
mkdirSync(OUT, { recursive: true });
execFileSync('tar', ['-xzf', rejoined, '-C', OUT], { stdio: 'ignore' });

/** Collect relative file paths below a directory. */
function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full).split('\\').join('/'));
  }
  return out;
}

const restored = walk(OUT).sort();
check('restore produced files', restored.length > 0, restored.join(','));

for (const [name, content] of Object.entries(files)) {
  const path = join(OUT, name);
  check(
    `restored ${name} matches byte for byte`,
    existsSync(path) && readFileSync(path, 'utf8') === content,
    existsSync(path) ? '' : 'missing',
  );
}
check(
  'restored the large binary file intact',
  existsSync(join(OUT, 'sessions/big.bin')) && readFileSync(join(OUT, 'sessions/big.bin')).length === 300_000,
);
check(
  'non-ASCII content survives the round trip',
  readFileSync(join(OUT, 'sessions/two.jsonl'), 'utf8').includes('世界'),
);

rmSync(ROOT, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
