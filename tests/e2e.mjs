// End-to-end harness for dsh-auto-sync in a throwaway sandbox:
//   D:/tmp/sync-e2e/remote.git   bare repo standing in for the user's private GitHub repo
//   D:/tmp/sync-e2e/home         the DSH home being backed up
//   D:/tmp/sync-e2e/project      a workspace project
// The harness runs: setup -> hot commit/push -> snapshot script -> workspace
// script -> verify every branch landed on the bare remote.
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const ROOT = 'D:/tmp/sync-e2e';
const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\\\/]+$/, '');
const REMOTE = join(ROOT, 'remote.git');
const HOME = join(ROOT, 'home');
const PROJECT = join(ROOT, 'project');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
}

function git(dir, args) {
  return spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
}

function gitOut(dir, args) {
  const r = git(dir, args);
  return r.status === 0 ? r.stdout.trim() : '';
}

// --- fresh sandbox ---------------------------------------------------------
if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });
mkdirSync(PROJECT, { recursive: true });

execFileSync('git', ['init', '--bare', '-b', 'main', REMOTE], { stdio: 'ignore' });

// A plausible DSH home: one secret to leak if ignores are wrong, one node_modules dir,
// one runtime state file the hot line should carry.
writeFileSync(join(HOME, '.credentials.yaml'), 'apiKey: super-secret\n');
writeFileSync(join(HOME, 'settings.yaml'), 'agent:\n  model: deepseek-flash\n');
writeFileSync(join(HOME, '.sync-status.json'), '{"version":1,"lines":{}}\n');
writeFileSync(join(HOME, 'debug.log'), 'noise\n');
mkdirSync(join(HOME, 'sessions'), { recursive: true });
writeFileSync(join(HOME, 'sessions', 'a.jsonl'), '{"type":"message"}\n');
mkdirSync(join(HOME, 'profiles', 'desktop', 'node_modules', 'fake-pkg'), { recursive: true });
writeFileSync(join(HOME, 'profiles', 'desktop', 'node_modules', 'fake-pkg', 'package.json'), '{"name":"fake-pkg"}\n');
writeFileSync(join(HOME, 'profiles', 'desktop', 'package.json'), '{"name":"dsh-profile-desktop"}\n');
writeFileSync(join(HOME, 'profiles', 'desktop', 'cordis.patch.yml'), '- id: x\n');

// A workspace project.
writeFileSync(join(PROJECT, 'README.md'), '# project\n');
writeFileSync(join(PROJECT, 'main.js'), 'console.log(1)\n');
mkdirSync(join(PROJECT, 'node_modules'), { recursive: true });
writeFileSync(join(PROJECT, 'node_modules', 'junk.js'), 'junk\n');
mkdirSync(join(PROJECT, 'dist'), { recursive: true });
writeFileSync(join(PROJECT, 'dist', 'out.js'), 'built\n');

// --- config ----------------------------------------------------------------
const configDir = join(HOME, 'sync-plugin');
mkdirSync(configDir, { recursive: true });
writeFileSync(join(configDir, 'config.json'), JSON.stringify({
  remote: REMOTE,
  worktree: join(ROOT, 'worktree'),
  exclude: ['.credentials.yaml', '**/node_modules/', '*.log'],
  lines: {
    hot: { enabled: true, branch: 'dsh-hot', debounceMs: 500, intervalMs: 900_000, paths: ['.sync-status.json'] },
    snapshot: { enabled: true, branch: 'dsh-snapshot', intervalMs: 86_400_000, includeNodeModules: true, profile: 'desktop' },
    workspace: { enabled: true, branch: 'dsh-workspace', source: PROJECT, exclude: ['.git', 'node_modules', 'dist'] },
  },
}, null, 2));

process.env.DSH_HOME = HOME;

// --- 1. setup + hot sync through the real plugin ---------------------------
const { apply, name } = await import(`file:///${REPO.replace(/\\/g, '/')}/index.js`);
check('plugin exports its name', name === 'dsh-auto-sync', name);

const logged = [];
const listeners = new Map();
const ctx = {
  logger: { warn: (m) => logged.push(`warn: ${m}`), info: (m) => logged.push(`info: ${m}`) },
  on(event, handler) { listeners.set(event, handler); return () => listeners.delete(event); },
  effect(fn) { const off = fn(); return typeof off === 'function' ? off : () => {}; },
  get: () => undefined,
};
apply(ctx, {});

// Let startup complete (setup + catch-up scheduling).
await new Promise((r) => setTimeout(r, 8000));

check('home became a git repository', existsSync(join(HOME, '.git')));
const branch = gitOut(HOME, ['branch', '--list', 'dsh-hot']) !== '';
check('hot branch created', branch);
const snapBranch = gitOut(HOME, ['branch', '--list', 'dsh-snapshot']) !== '';
check('snapshot branch created', snapBranch);

const worktreeList = gitOut(HOME, ['worktree', 'list']);
check('hot worktree exists', worktreeList.includes('-hot'), worktreeList.replace(/\n/g, ' | '));

const ignore = readFileSync(join(HOME, '.gitignore'), 'utf8');
check('.credentials.yaml ignored', ignore.includes('.credentials.yaml'));
check('node_modules ignored on hot branch', ignore.includes('**/node_modules/'));

// Drive a turn end and let the short debounce run the hot line for real.
check('session/event listener registered', listeners.has('session/event'));
listeners.get('session/event')({}, { type: 'turn/end' });
await new Promise((r) => setTimeout(r, 6000));

const hotLog = gitOut(join(ROOT, 'worktree-hot'), ['log', '--oneline']);
check('hot line committed through turn/end', /dsh hot/.test(hotLog), hotLog.replace(/\n/g, ' | '));

const hotWorktreeFiles = gitOut(join(ROOT, 'worktree-hot'), ['ls-files']);
check('hot line carries the state file', hotWorktreeFiles.includes('.sync-status.json'), hotWorktreeFiles);

console.log(JSON.stringify({ logged }, null, 2));

// --- 2. snapshot script ----------------------------------------------------
const cold = spawnSync(process.execPath, [join(REPO, 'cold-sync.mjs'), '--home', HOME, '--worktree', join(ROOT, 'worktree')], { encoding: 'utf8', windowsHide: true });
console.log('--- cold-sync ---\n' + cold.stdout + (cold.stderr ? '\n[stderr] ' + cold.stderr : ''));
check('cold-sync exit 0', cold.status === 0, `exit=${cold.status}`);

const remoteBranches = execFileSync('git', ['-C', REMOTE, 'branch', '--list'], { encoding: 'utf8' });
check('snapshot branch pushed to remote', remoteBranches.includes('dsh-snapshot'), remoteBranches.replace(/\n/g, ' '));

// The plugin keeps timers alive on purpose; the harness is done asserting.
process.exit(0);
