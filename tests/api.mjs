// Settings-page API checks: validation, persistence, the cross-origin fence and
// the idempotent registration contract. Runs against a throwaway home.
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
}

const api = await import(`file:///${REPO.replace(/\\/g, '/')}/lib/api.mjs`);

// --- origin fence ----------------------------------------------------------
check('no Origin header is allowed', api.originAllowed({ headers: {} }) === true);
check(
  'same-origin request is allowed',
  api.originAllowed({ headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' } }) === true,
);
check(
  'cross-origin request is refused',
  api.originAllowed({ headers: { origin: 'https://evil.example', host: '127.0.0.1:3080' } }) === false,
);
check(
  'malformed Origin is refused',
  api.originAllowed({ headers: { origin: 'not a url', host: '127.0.0.1:3080' } }) === false,
);

// --- config validation -----------------------------------------------------
const t = (await import(`file:///${REPO.replace(/\\/g, '/')}/lib/i18n.mjs`)).dictionary('en');

check('empty patch is accepted', api.validateConfigPatch({}, t).ok === true);
check('valid remote accepted', api.validateConfigPatch({ remote: 'git@github.com:a/b.git' }, t).ok === true);
check('invalid remote rejected', api.validateConfigPatch({ remote: 'nonsense' }, t).ok === false);
check('empty remote clears the setting', api.validateConfigPatch({ remote: '' }, t).ok === true);
check('locale zh accepted', api.validateConfigPatch({ locale: 'zh' }, t).ok === true);
check('bad locale rejected', api.validateConfigPatch({ locale: 'fr' }, t).ok === false);
check(
  'interval under a minute rejected',
  api.validateConfigPatch({ lines: { hot: { intervalMs: 5000 } } }, t).ok === false,
);
check(
  'interval of a minute accepted',
  api.validateConfigPatch({ lines: { hot: { intervalMs: 60000 } } }, t).ok === true,
);
check(
  'non-boolean enabled rejected',
  api.validateConfigPatch({ lines: { hot: { enabled: 'yes' } } }, t).ok === false,
);
check(
  'workspace enabling without a source rejected',
  api.validateConfigPatch({ workspace: { enabled: true, source: '' } }, t).ok === false,
);
check(
  'workspace with a missing path rejected',
  api.validateConfigPatch({ workspace: { source: 'D:/no/such/dir' } }, t).ok === false,
);
check(
  'unknown keys are ignored, not persisted',
  (() => {
    const result = api.validateConfigPatch({ somethingElse: 1 }, t);
    return result.ok === true && result.patch.somethingElse === undefined;
  })(),
);

// --- routes ----------------------------------------------------------------
const HOME = 'D:/tmp/sync-api/home';
if (existsSync('D:/tmp/sync-api')) rmSync('D:/tmp/sync-api', { recursive: true, force: true });
mkdirSync(join(HOME, 'sync-plugin'), { recursive: true });
writeFileSync(join(HOME, 'sync-plugin', 'config.json'), JSON.stringify({ remote: '', locale: 'en' }, null, 2));
process.env.DSH_HOME = HOME;

/** A minimal webServer double that records registrations. */
const routes = new Map();
let disposals = 0;
const webServer = {
  register(definition) {
    routes.set(definition.path, definition.handler);
    return () => {
      routes.delete(definition.path);
      disposals += 1;
    };
  },
};

let setupCalls = 0;
let snapshotCalls = 0;
const deps = {
  home: HOME,
  locale: 'en',
  onSetup: async () => {
    setupCalls += 1;
  },
  onSnapshot: () => {
    snapshotCalls += 1;
  },
};
const disposers = api.registerRoutes(webServer, deps);

check('every route registered', routes.size === 4, [...routes.keys()].join(', '));
check('status route registered', routes.has(`${api.API_PREFIX}/status`));
check('config route registered', routes.has(`${api.API_PREFIX}/config`));
check('snapshot route registered', routes.has(`${api.API_PREFIX}/snapshot`));

/** Drive one route and collect the JSON response. */
async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const handler = routes.get(path);
  const payload = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(payload === '' ? [] : [Buffer.from(payload)]);
  req.method = method;
  req.headers = { host: '127.0.0.1:3080', 'content-length': String(Buffer.byteLength(payload)), ...headers };
  /** @type {any} */
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(code, more) {
      this.statusCode = code;
      this.headers = more ?? {};
      this.headersSent = true;
    },
    end(chunk) {
      this.body = chunk ? String(chunk) : '';
    },
  };
  await handler(req, res);
  let parsed = null;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    parsed = null;
  }
  return { status: res.statusCode, data: parsed };
}

const status = await call(`${api.API_PREFIX}/status`);
check('status returns 200', status.status === 200);
check('status reports an unconfigured remote', status.data.remoteConfigured === false);
check('status lists all lines', ['hot', 'snapshot', 'workspace'].every((k) => k in status.data.lines));
check('status exposes a next step', typeof status.data.nextStep === 'string' && status.data.nextStep.length > 0, status.data.nextStep);

const badOrigin = await call(`${api.API_PREFIX}/config`, {
  method: 'POST',
  body: { remote: 'git@github.com:a/b.git' },
  headers: { origin: 'https://evil.example' },
});
check('cross-origin config write is refused', badOrigin.status === 403, String(badOrigin.status));
check('refused write did not persist', JSON.parse(readFileSync(join(HOME, 'sync-plugin', 'config.json'), 'utf8')).remote === '');

const sameOrigin = await call(`${api.API_PREFIX}/config`, {
  method: 'POST',
  body: { remote: 'git@github.com:a/b.git' },
  headers: { origin: 'http://127.0.0.1:3080' },
});
check('same-origin config write succeeds', sameOrigin.status === 200, String(sameOrigin.status));
check('config write triggered the first-run setup', setupCalls === 1, String(setupCalls));
check(
  'config write persisted the remote',
  JSON.parse(readFileSync(join(HOME, 'sync-plugin', 'config.json'), 'utf8')).remote === 'git@github.com:a/b.git',
);

const secondWrite = await call(`${api.API_PREFIX}/config`, {
  method: 'POST',
  body: { locale: 'zh' },
  headers: { origin: 'http://127.0.0.1:3080' },
});
check('a later write does not re-run setup', secondWrite.status === 200 && setupCalls === 1, String(setupCalls));
check('locale persisted', JSON.parse(readFileSync(join(HOME, 'sync-plugin', 'config.json'), 'utf8')).locale === 'zh');

const invalid = await call(`${api.API_PREFIX}/config`, {
  method: 'POST',
  body: { remote: 'nonsense' },
  headers: { origin: 'http://127.0.0.1:3080' },
});
check('invalid remote answers 400', invalid.status === 400, String(invalid.status));

const wrongMethod = await call(`${api.API_PREFIX}/config`);
check('GET on a POST route answers 405', wrongMethod.status === 405, String(wrongMethod.status));

const snapshot = await call(`${api.API_PREFIX}/snapshot`, {
  method: 'POST',
  headers: { origin: 'http://127.0.0.1:3080' },
});
check('snapshot answers 202', snapshot.status === 202, String(snapshot.status));
check('snapshot invoked the callback', snapshotCalls === 1);

// Without a remote the snapshot route must refuse rather than silently queue.
writeFileSync(join(HOME, 'sync-plugin', 'config.json'), JSON.stringify({ remote: '' }, null, 2));
const noRemote = await call(`${api.API_PREFIX}/snapshot`, {
  method: 'POST',
  headers: { origin: 'http://127.0.0.1:3080' },
});
check('snapshot without a remote is refused', noRemote.status === 409, String(noRemote.status));

// Registration must be a no-op on a host with no web server.
check('no webServer means no routes', api.registerRoutes(undefined, deps).length === 0);
check('no webServer means no crash', api.registerRoutes({}, deps).length === 0);

for (const dispose of disposers) dispose();
check('disposers unregister every route', disposals === 4 && routes.size === 0, `${disposals}`);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
