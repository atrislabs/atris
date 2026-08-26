const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { workspaceRoot } = require('../lib/task-db');
const { resolveWorkspaceRoot } = require('../lib/mission-root');
const { isGenericScratchRoot } = require('../lib/scratch-root');

function makeTree() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ws-root-')));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'master'], { cwd: repo });
  return { base, repo };
}

// Proven footgun (2026-07-16): task/usage state split into a nested .atris when
// a command ran from a subdirectory that merely contained an atris/ folder (the
// arena's backend/atris/). The bare atris/ marker short-circuited the walk
// before it reached the real git root.
test('a subdirectory with a bare atris/ folder resolves to the git root, not itself', () => {
  const { base, repo } = makeTree();
  try {
    const sub = path.join(repo, 'backend');
    fs.mkdirSync(path.join(sub, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(sub, 'atris', 'TODO.md'), '# TODO\n'); // regenerated render, not a spine
    fs.mkdirSync(path.join(sub, '.atris', 'state'), { recursive: true }); // stray residue
    assert.equal(workspaceRoot(sub), repo);
    // Even a deeper feature dir (the food-ordering incident) anchors to the root.
    const feature = path.join(repo, 'atris', 'features', 'food-ordering');
    fs.mkdirSync(feature, { recursive: true });
    assert.equal(workspaceRoot(feature), repo);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// A bound customer sub-workspace (marked by .atris/business.json) lives inside
// the repo and MUST keep its own root — task state stays isolated per customer.
test('a .atris/business.json sub-workspace keeps its own root', () => {
  const { base, repo } = makeTree();
  try {
    const customer = path.join(repo, 'atris', 'pallet');
    fs.mkdirSync(path.join(customer, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(customer, '.atris', 'business.json'), '{"name":"pallet"}');
    assert.equal(workspaceRoot(customer), customer);
    // A subdir of the customer workspace still resolves to the customer root.
    const inner = path.join(customer, 'notes');
    fs.mkdirSync(inner, { recursive: true });
    assert.equal(workspaceRoot(inner), customer);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// The framework protocol file atris/atris.md also marks a real workspace root.
test('an atris/atris.md spine marks a workspace root', () => {
  const { base, repo } = makeTree();
  try {
    const nested = path.join(repo, 'packages', 'app');
    fs.mkdirSync(path.join(nested, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(nested, 'atris', 'atris.md'), '# protocol\n');
    assert.equal(workspaceRoot(nested), nested);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// Outside any git repo, a bare atris/ dir is still a valid legacy marker.
test('non-git tree falls back to the nearest bare atris/ marker', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ws-nogit-')));
  try {
    const ws = path.join(base, 'plain-workspace');
    fs.mkdirSync(path.join(ws, 'atris'), { recursive: true });
    const sub = path.join(ws, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    // No .git anywhere under os.tmpdir(), so the legacy marker wins.
    assert.equal(workspaceRoot(sub), ws);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// A src/ folder inside a real project still walks up. The /tmp stop must not
// break ordinary repo walk-up just because the checkout happens to live under tmp.
test('src inside a real project still walks up to that project', () => {
  const { base, repo } = makeTree();
  try {
    const src = path.join(repo, 'src');
    fs.mkdirSync(src, { recursive: true });
    assert.equal(workspaceRoot(src), repo);
    assert.equal(resolveWorkspaceRoot(src), repo);
    assert.equal(workspaceRoot(src), workspaceRoot(repo));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('generic scratch roots are /tmp, /private/tmp, /var/tmp, and os.tmpdir', () => {
  assert.equal(isGenericScratchRoot('/tmp'), true);
  assert.equal(isGenericScratchRoot('/private/tmp'), true);
  assert.equal(isGenericScratchRoot('/var/tmp'), true);
  assert.equal(isGenericScratchRoot(os.tmpdir()), true);
  assert.equal(isGenericScratchRoot(path.join(os.tmpdir(), 'atris-next-room')), false);
});
