// Onboarding and slash-command checks: the first-run guidance must appear only
// while setup is incomplete, and `/dsh-sync` must configure a home end to end
// without a restart.
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
}

const onboard = await import(`file:///${REPO.replace(/\\/g, '/')}/lib/onboard.mjs`);
const configMod = await import(`file:///${REPO.replace(/\\/g, '/')}/lib/config.mjs`);

// --- remote validation -----------------------------------------------------
check('https remote accepted', onboard.remoteProblem('https://github.com/you/backup.git') === null);
check('ssh remote accepted', onboard.remoteProblem('git@github.com:you/backup.git') === null);
check('ssh url accepted', onboard.remoteProblem('ssh://git@host:22/you/backup.git') === null);
check('local path accepted', onboard.remoteProblem('D:/backups/dsh.git') === null);
check('empty remote rejected', onboard.remoteProblem('') !== null, String(onboard.remoteProblem('')));
check('whitespace rejected', onboard.remoteProblem('git@host:a b.git') !== null);
check('garbage rejected', onboard.remoteProblem('not-a-remote') !== null, String(onboard.remoteProblem('not-a-remote')));

// --- onboarding message appears only while incomplete ----------------------
const HOME = 'D:/tmp/sync-oobe/home';
const REMOTE = 'D:/tmp/sync-oobe/remote.git';
if (existsSync('D:/tmp/sync-oobe')) rmSync('D:/tmp/sync-oobe', { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });
execFileSync('git', ['init', '--bare', '-b', 'main', REMOTE], { stdio: 'ignore' });
process.env.DSH_HOME = HOME;

const unconfigured = configMod.loadConfig({});
const message = await onboard.onboardingMessage(unconfigured);
check('onboarding message shows while unconfigured', message !== null && /not finished setting up/i.test(message));
check('onboarding message names the command', message !== null && message.includes('/dsh-sync setup'));

// A configured + initialised home must go quiet.
mkdirSync(join(HOME, 'sync-plugin'), { recursive: true });
writeFileSync(join(HOME, 'sync-plugin', 'config.json'), JSON.stringify({
  remote: REMOTE,
  worktree: 'D:/tmp/sync-oobe/worktree',
  lines: { hot: { enabled: true }, snapshot: { enabled: true, profile: 'desktop' }, workspace: { enabled: false } },
}, null, 2));
writeFileSync(join(HOME, 'state.txt'), 'x\n');
execFileSync('git', ['init', '-b', 'main'], { cwd: HOME });
execFileSync('git', ['-C', HOME, 'add', '-A']);
execFileSync('git', ['-C', HOME, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init']);
execFileSync('git', ['-C', HOME, 'remote', 'add', 'origin', REMOTE]);

const configured = configMod.loadConfig({});
const quiet = await onboard.onboardingMessage(configured);
check('onboarding message is silent once configured', quiet === null, String(quiet).slice(0, 120));

// --- the command handler ---------------------------------------------------
let setupCalls = 0;
let snapshotCalls = 0;
const handler = onboard.createCommandHandler({
  home: HOME,
  onSetup: async () => { setupCalls += 1; },
  onSnapshot: () => { snapshotCalls += 1; },
});

const status = await handler({ rawInput: '' });
check('bare command reports status', status.kind === 'success' && /dsh-auto-sync status/i.test(status.text));
check('status lists all three lines', ['hot', 'snapshot', 'workspace'].every((n) => status.text.includes(n)));

const lines = await handler({ rawInput: 'lines' });
check('lines subcommand lists branches', lines.kind === 'success' && lines.text.includes('dsh-hot'));

const badVerb = await handler({ rawInput: 'nonsense' });
check('unknown subcommand errors helpfully', badVerb.kind === 'error' && badVerb.text.includes('setup <remote-url>'));

const badRemote = await handler({ rawInput: 'setup not-a-remote' });
check('setup rejects an invalid remote', badRemote.kind === 'error' && setupCalls === 0, badRemote.text.slice(0, 100));

const setupOk = await handler({ rawInput: 'setup' });
check('setup with existing config runs the setup', setupOk.kind === 'success' && setupCalls === 1, setupOk.text.slice(0, 100));

const run = await handler({ rawInput: 'run' });
check('run schedules a snapshot', run.kind === 'success' && snapshotCalls === 1);

const doctor = await handler({ rawInput: 'doctor' });
check('doctor reports the chain', doctor.kind === 'success' && doctor.text.includes('home repository: yes'), doctor.text.slice(0, 160));

const wsOff = await handler({ rawInput: 'workspace off' });
check('workspace off persists', wsOff.kind === 'success');
const persisted = JSON.parse(readFileSync(join(HOME, 'sync-plugin', 'config.json'), 'utf8'));
check('config file records the workspace line as disabled', persisted.lines?.workspace?.enabled === false, JSON.stringify(persisted.lines?.workspace));

const wsMissing = await handler({ rawInput: 'workspace D:/tmp/sync-oobe/nope' });
check('workspace rejects a missing path', wsMissing.kind === 'error');

// --- setup from scratch through the command --------------------------------
const FRESH = 'D:/tmp/sync-oobe/fresh';
mkdirSync(FRESH, { recursive: true });
const REMOTE2 = 'D:/tmp/sync-oobe/remote2.git';
execFileSync('git', ['init', '--bare', '-b', 'main', REMOTE2], { stdio: 'ignore' });
const freshHandler = onboard.createCommandHandler({
  home: FRESH,
  onSetup: async (config) => {
    const { setup } = await import(`file:///${REPO.replace(/\\/g, '/')}/lib/setup.mjs`);
    process.env.DSH_HOME = FRESH;
    const result = await setup(config, () => {});
    if (!result.ok) throw new Error(result.error);
  },
  onSnapshot: () => {},
});
const freshSetup = await freshHandler({ rawInput: `setup ${REMOTE2}` });
check('setup from scratch succeeds', freshSetup.kind === 'success', freshSetup.text.split('\n')[0]);
check('setup created the repository', existsSync(join(FRESH, '.git')));
const freshConfig = JSON.parse(readFileSync(join(FRESH, 'sync-plugin', 'config.json'), 'utf8'));
check('setup persisted the remote', freshConfig.remote === REMOTE2, freshConfig.remote);

// --- command registration is optional --------------------------------------
check('no commands service means no registration', onboard.registerCommand({}, { home: HOME, onSetup: async () => {}, onSnapshot: () => {} }) === undefined);

let registered = null;
let disposed = false;
const disposer = onboard.registerCommand({
  commands: {
    register: (definition) => {
      registered = definition;
      return () => { disposed = true; };
    },
  },
}, { home: HOME, onSetup: async () => {}, onSnapshot: () => {} });
check('command registers with the right name', registered?.name === 'dsh-sync', registered?.name);
check('command registration returns a disposer', typeof disposer === 'function');
disposer?.();
check('disposer unregisters', disposed === true);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
