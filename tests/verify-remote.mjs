// Phase 2 of the e2e check: assert what actually landed on the remote, and that
// the ignore rules kept secrets out of every branch.
import { execFileSync } from 'node:child_process';

const ROOT = 'D:/tmp/sync-e2e';
const REMOTE = `${ROOT}/remote.git`;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
}

/** Files tracked on `ref` in the bare remote. */
function tracked(ref) {
  return execFileSync('git', ['-C', REMOTE, 'ls-tree', '-r', '--name-only', ref], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
}

// The hot branch must have the runtime state file and nothing secret.
const hot = tracked('refs/heads/dsh-hot');
check('hot branch carries .sync-status.json', hot.includes('.sync-status.json'), `${hot.length} files`);
check('hot branch has no credentials', !hot.some((f) => f.includes('.credentials')), hot.slice(0, 8).join(','));

// The snapshot branch must carry the home tree, the profile manifest, and the
// installed dependency, while keeping secrets and logs out.
const snap = tracked('refs/heads/dsh-snapshot');
check('snapshot carries settings.yaml', snap.includes('settings.yaml'));
check('snapshot carries the session log', snap.some((f) => f.startsWith('sessions/')));
check('snapshot carries the profile manifest', snap.includes('profiles/desktop/package.json'));
check('snapshot carries installed dependencies', snap.some((f) => f.startsWith('profiles/desktop/node_modules/fake-pkg/')));
check('snapshot excludes credentials', !snap.some((f) => f.includes('.credentials')));
check('snapshot excludes *.log', !snap.some((f) => f.endsWith('.log') && !f.startsWith('profiles/')));
check('snapshot does not nest the worktree into itself', !snap.some((f) => f.includes('worktree/') || f.includes('remote.git')));

const total = results.length;
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${total - failed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
