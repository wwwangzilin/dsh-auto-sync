// Edge-case checks that must hold for a tool other people run:
//   1. the workspace line mirrors a project to its own branch, excluding build output
//   2. an already-git-backed home is adopted, not re-initialised
//   3. an unconfigured install exits without touching git
//   4. a hot path pointing outside the home is refused
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\\\/]+$/, '');
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
}
function git(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

// --- 1. workspace line -----------------------------------------------------
const WS = 'D:/tmp/sync-edge-ws';
if (existsSync(WS)) rmSync(WS, { recursive: true, force: true });
mkdirSync(join(WS, 'home'), { recursive: true });
mkdirSync(join(WS, 'project', 'src'), { recursive: true });
mkdirSync(join(WS, 'project', 'dist'), { recursive: true });
mkdirSync(join(WS, 'project', 'node_modules'), { recursive: true });
writeFileSync(join(WS, 'project', 'src', 'a.js'), 'export const a = 1;\n');
writeFileSync(join(WS, 'project', 'dist', 'a.js'), 'compiled\n');
writeFileSync(join(WS, 'project', 'node_modules', 'dep.js'), 'dep\n');
execFileSync('git', ['init', '--bare', '-b', 'main', join(WS, 'remote.git')], { stdio: 'ignore' });
mkdirSync(join(WS, 'home', 'sync-plugin'), { recursive: true });
writeFileSync(join(WS, 'home', 'sync-plugin', 'config.json'), JSON.stringify({
  remote: join(WS, 'remote.git'),
  worktree: join(WS, 'worktree'),
  lines: {
    hot: { enabled: false, branch: 'dsh-hot' },
    snapshot: { enabled: false, branch: 'dsh-snapshot' },
    workspace: { enabled: true, branch: 'dsh-workspace', source: join(WS, 'project'), exclude: ['.git', 'node_modules', 'dist'] },
  },
}, null, 2));

// The home needs to be a repository for the workspace worktree to hang off it.
git(join(WS, 'home'), ['init']);
git(join(WS, 'home'), ['add', '-A']);
git(join(WS, 'home'), ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'init']);
git(join(WS, 'home'), ['remote', 'add', 'origin', join(WS, 'remote.git')]);

const ws = spawnSync(process.execPath, [join(REPO, 'workspace-sync.mjs'), '--home', join(WS, 'home')], { encoding: 'utf8', windowsHide: true });
const wsOut = `${ws.stdout}${ws.stderr}`;
check('workspace sync exits 0', ws.status === 0, `exit=${ws.status} :: ${wsOut.trim().replace(/\n/g, ' | ')}`);
const wsFiles = git(join(WS, 'remote.git'), ['ls-tree', '-r', '--name-only', 'refs/heads/dsh-workspace']).out.split('\n').filter(Boolean);
check('workspace branch has the source file', wsFiles.includes('src/a.js'), wsFiles.join(','));
check('workspace branch excludes build output', !wsFiles.some((f) => f.startsWith('dist/')), wsFiles.join(','));
check('workspace branch excludes dependencies', !wsFiles.some((f) => f.startsWith('node_modules/')), wsFiles.join(','));

// --- 2. adopting an existing repo -----------------------------------------
const AD = 'D:/tmp/sync-edge-adopt';
if (existsSync(AD)) rmSync(AD, { recursive: true, force: true });
mkdirSync(join(AD, 'home'), { recursive: true });
mkdirSync(join(AD, 'home', 'sync-plugin'), { recursive: true });
execFileSync('git', ['init', '--bare', '-b', 'main', join(AD, 'remote.git')], { stdio: 'ignore' });
writeFileSync(join(AD, 'home', 'existing.txt'), 'mine\n');
git(join(AD, 'home'), ['init', '-b', 'main']);
git(join(AD, 'home'), ['add', '-A']);
git(join(AD, 'home'), ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'pre-existing history']);
git(join(AD, 'home'), ['remote', 'add', 'origin', join(AD, 'remote.git')]);
writeFileSync(join(AD, 'home', 'sync-plugin', 'config.json'), JSON.stringify({
  remote: join(AD, 'remote.git'),
  worktree: join(AD, 'worktree'),
  lines: { hot: { enabled: true, branch: 'dsh-hot' }, snapshot: { enabled: false, branch: 'dsh-snapshot' }, workspace: { enabled: false } },
}, null, 2));

const { setup } = await import(`file:///${REPO}/lib/setup.mjs`);
const { loadConfig } = await import(`file:///${REPO}/lib/config.mjs`);
process.env.DSH_HOME = join(AD, 'home');
const adoptConfig = loadConfig({});
const adoptResult = await setup(adoptConfig, () => {});
check('existing repo is adopted, not re-initialised', adoptResult.mode === 'adopted-existing-repo', adoptResult.mode);
const history = git(join(AD, 'home'), ['log', '--oneline']).out;
check('pre-existing history is preserved', history.includes('pre-existing history'), history.replace(/\n/g, ' | '));
check('hot branch hangs off the existing history', git(join(AD, 'home'), ['branch', '--list', 'dsh-hot']).out.includes('dsh-hot'));

// --- 3. unconfigured install leaves git alone ------------------------------
const NC = 'D:/tmp/sync-edge-noconf';
if (existsSync(NC)) rmSync(NC, { recursive: true, force: true });
mkdirSync(NC, { recursive: true });
process.env.DSH_HOME = NC;
const mod = await import(`file:///${REPO}/index.js`);
const warned = [];
const ncCtx = {
  logger: { warn: (m) => warned.push(m), info: () => {} },
  on: () => () => {},
  effect: (fn) => { const off = fn(); return typeof off === 'function' ? off : () => {}; },
  get: () => undefined,
};
mod.apply(ncCtx, {});
await new Promise((r) => setTimeout(r, 1500));
check('unconfigured install does not create a repository', !existsSync(join(NC, '.git')));
check('unconfigured install writes a config template', existsSync(join(NC, 'sync-plugin', 'config.json')));
const template = JSON.parse(readFileSync(join(NC, 'sync-plugin', 'config.json'), 'utf8'));
check('template leaves the remote empty for the user to fill', template.remote === '', JSON.stringify(template.remote));
check('unconfigured install warns about the empty remote', warned.some((m) => /remote/i.test(m)), warned.join(' | ').slice(0, 200));

// --- 4. hot path escaping the home is refused -----------------------------
const ESC = 'D:/tmp/sync-edge-escape';
if (existsSync(ESC)) rmSync(ESC, { recursive: true, force: true });
mkdirSync(join(ESC, 'home', 'sync-plugin'), { recursive: true });
mkdirSync(join(ESC, 'outside'), { recursive: true });
writeFileSync(join(ESC, 'outside', 'secret.txt'), 'should never travel\n');
execFileSync('git', ['init', '--bare', '-b', 'main', join(ESC, 'remote.git')], { stdio: 'ignore' });
writeFileSync(join(ESC, 'home', 'sync-plugin', 'config.json'), JSON.stringify({
  remote: join(ESC, 'remote.git'),
  worktree: join(ESC, 'worktree'),
  lines: {
    hot: { enabled: true, branch: 'dsh-hot', debounceMs: 100, paths: ['../outside/secret.txt'] },
    snapshot: { enabled: false },
    workspace: { enabled: false },
  },
}, null, 2));
process.env.DSH_HOME = join(ESC, 'home');
const escMod = await import(`file:///${REPO}/index.js?escape`);
const escWarned = [];
const escCtx = {
  logger: { warn: (m) => escWarned.push(m), info: () => {} },
  on: (event, handler) => { if (event === 'session/event') escCtx._turn = handler; return () => {}; },
  effect: (fn) => { const off = fn(); return typeof off === 'function' ? off : () => {}; },
  get: () => undefined,
};
escMod.apply(escCtx, {});
await new Promise((r) => setTimeout(r, 2500));
escCtx._turn?.({}, { type: 'turn/end' });
await new Promise((r) => setTimeout(r, 2500));
check('hot path outside the home is refused', escWarned.some((m) => /refusing hot path|outside/i.test(m)), escWarned.join(' | ').slice(0, 300));

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
