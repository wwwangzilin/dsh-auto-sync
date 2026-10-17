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

// --- locale handling ------------------------------------------------------
const i18n = await import(`file:///${REPO.replace(/\\/g, '/')}/lib/i18n.mjs`);

check('explicit locale zh wins', i18n.resolveLocale({ locale: 'zh' }) === 'zh');
check('zh-CN normalizes to zh', i18n.resolveLocale({ locale: 'zh-CN' }) === 'zh');
check('en-US normalizes to en', i18n.resolveLocale({ locale: 'en-US' }) === 'en');
check('host locale is used when config is silent', i18n.resolveLocale({}, 'zh') === 'zh');
check('unknown host locale falls back to en', i18n.resolveLocale({}, 'fr') === 'en');
check('no signal at all defaults to en', i18n.resolveLocale({}) === 'en');

process.env.DSH_AUTO_SYNC_LOCALE = 'zh';
check('environment locale is honored', i18n.resolveLocale({}) === 'zh');
check('explicit locale beats environment', i18n.resolveLocale({ locale: 'en' }) === 'en');
delete process.env.DSH_AUTO_SYNC_LOCALE;

const zhHandler = onboard.createCommandHandler({
  home: HOME,
  locale: 'zh',
  onSetup: async () => {},
  onSnapshot: () => {},
});
const zhStatus = await zhHandler({ rawInput: '' });
check('zh status renders in Chinese', zhStatus.text.includes('状态') && zhStatus.text.includes('远端仓库'), zhStatus.text.split('\n')[0]);
const zhHelp = await zhHandler({ rawInput: 'nonsense' });
check('zh help renders in Chinese', zhHelp.text.includes('未知子命令'), zhHelp.text.split('\n')[0]);
const zhDoctor = await zhHandler({ rawInput: 'doctor' });
check('zh doctor renders in Chinese', zhDoctor.text.includes('诊断'), zhDoctor.text.split('\n')[0]);
const zhLines = await zhHandler({ rawInput: 'lines' });
check('zh lines renders in Chinese', zhLines.text.includes('备份线'), zhLines.text.split('\n')[0]);
// Onboarding guidance is checked against an unconfigured home so the message
// is actually produced; the configured `HOME` above correctly returns null.
const FRESH_MSG = 'D:/tmp/sync-oobe/message';
if (existsSync(FRESH_MSG)) rmSync(FRESH_MSG, { recursive: true, force: true });
mkdirSync(join(FRESH_MSG, 'sync-plugin'), { recursive: true });
writeFileSync(join(FRESH_MSG, 'sync-plugin', 'config.json'), JSON.stringify({ remote: '', locale: 'zh' }, null, 2));

// Slash commands appear in messages that reference them, and the verb itself
// stays ASCII in every language.
const unconfiguredZh = onboard.createCommandHandler({
  home: FRESH_MSG,
  locale: 'zh',
  onSetup: async () => {},
  onSnapshot: () => {},
});
const zhRun = await unconfiguredZh({ rawInput: 'run' });
check(
  'zh error keeps command syntax ASCII',
  zhRun.text.includes('/dsh-sync setup') && zhRun.text.includes('请先配置'),
  zhRun.text,
);

// Onboarding guidance is checked against an unconfigured home so the message
// is actually produced; the configured `HOME` above correctly returns null.
const zhMessage = await onboard.onboardingMessage(configMod.loadConfig({ home: FRESH_MSG }));
check('zh onboarding message is Chinese', zhMessage !== null && zhMessage.includes('已安装'), String(zhMessage).slice(0, 80));

writeFileSync(join(FRESH_MSG, 'sync-plugin', 'config.json'), JSON.stringify({ remote: '', locale: 'en' }, null, 2));
const enMessage = await onboard.onboardingMessage(configMod.loadConfig({ home: FRESH_MSG }));
check('en onboarding message is English', enMessage !== null && enMessage.includes('installed'), String(enMessage).slice(0, 80));

// Both dictionaries must expose the same keys and callable arities, or one
// locale silently breaks. Array lengths legitimately differ: wrapping differs
// per language, so an array is compared by type only.
function shape(value, path = '') {
  if (typeof value === 'function') return [`${path}:fn/${value.length}`];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.keys(value).sort().flatMap((k) => shape(value[k], `${path}.${k}`));
  }
  if (Array.isArray(value)) return [`${path}:array`];
  return [`${path}:string`];
}
const enShape = shape(i18n.DICTIONARIES.en).join('|');
const zhShape = shape(i18n.DICTIONARIES.zh).join('|');
check('zh and en dictionaries have identical shape', enShape === zhShape, enShape === zhShape ? '' : `${enShape}\nvs\n${zhShape}`);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
