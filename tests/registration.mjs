// Cordis registration contract checks.
//
// Regression for a defect that made the whole feature invisible: the plugin
// declared `inject = []` while reading `ctx.commands` and `ctx.webServer`. A
// Cordis context throws `cannot get property "X" without inject` on such a
// read, so neither the slash command nor the settings routes were ever
// registered, and the client bundle was never composed into the boot graph.
//
// These checks fail if the declaration or the guarded probes regress.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
}

const mod = await import(`file:///${REPO.replace(/\\/g, '/')}/index.js`);

// --- the declaration itself ------------------------------------------------
check('plugin exports a name', typeof mod.name === 'string' && mod.name.length > 0, mod.name);
check('inject is declared', mod.inject !== undefined && mod.inject !== null);
check(
  'inject declares the commands service as optional',
  mod.inject?.commands !== undefined && mod.inject.commands.required === false,
  JSON.stringify(mod.inject?.commands),
);
check(
  'inject declares the webServer service as optional',
  mod.inject?.webServer !== undefined && mod.inject.webServer.required === false,
  JSON.stringify(mod.inject?.webServer),
);

// --- source-level guarantees ----------------------------------------------
const index = readFileSync(join(REPO, 'index.js'), 'utf8');
const onboard = readFileSync(join(REPO, 'lib', 'onboard.mjs'), 'utf8');

check('settings route probe is guarded against a throw', /try\s*{\s*webServer = ctx\.webServer/.test(index));
check('command probe is guarded against a throw', /try\s*{\s*commands = ctx\?\.commands/.test(onboard));

// A bare, unguarded service read is exactly what broke this before.
const unguardedWebServer = /(?<!try\s*{\s*[\s\S]{0,80})const webServer = ctx\.webServer;/.test(index);
check('index.js has no unguarded ctx.webServer read', unguardedWebServer === false);
const unguardedCommands = /const commands = ctx\?\.commands;/.test(onboard);
check('onboard.mjs has no unguarded ctx.commands read', unguardedCommands === false);

// --- a context that throws, as Cordis does --------------------------------
/** A context whose service properties throw unless declared, like Cordis. */
function strictContext(declared) {
  const services = new Set(declared);
  const target = {
    logger: { warn() {}, info() {} },
    on: () => () => {},
    effect: (fn) => {
      const off = fn();
      return typeof off === 'function' ? off : () => {};
    },
    get: () => undefined,
  };
  return new Proxy(target, {
    get(obj, prop) {
      if (prop in obj) return obj[prop];
      if (typeof prop !== 'string') return undefined;
      if (services.has(prop)) return undefined; // declared but absent
      throw new Error(`cannot get property "${prop}" without inject`);
    },
  });
}

const declared = Object.keys(mod.inject ?? {});
const ctx = strictContext(declared);

let applyError = null;
try {
  mod.apply(ctx, { home: 'D:/tmp/regcheck-home' });
} catch (error) {
  applyError = error;
}
check('apply() mounts on a context that provides neither service', applyError === null, applyError ? String(applyError) : '');

// The same context with the services removed from the declaration must throw,
// which proves the check above is meaningful rather than vacuous.
let controlError = null;
try {
  const bare = strictContext([]);
  // Touch the same property the plugin does; a bare context refuses it.
  void bare.commands;
} catch (error) {
  controlError = error;
}
check('an undeclared service read still throws (control)', controlError !== null, controlError ? String(controlError) : 'no throw');

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
