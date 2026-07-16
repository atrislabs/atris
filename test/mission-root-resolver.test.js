const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const { resolveWorkspaceRoot } = require('../lib/mission-root');
const { workspaceRoot } = require('../lib/task-db');

// Footgun (a), residual: the mission store used only the git toplevel while the
// task/usage/goal store honored a bound sub-workspace spine (.atris/business.json
// | atris/atris.md). A mission started inside a bound customer sub-workspace
// therefore split its state into the PARENT git root, away from that
// workspace's task state. Both resolvers must now agree.

function tempGitRepo() {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'atris-mroot-'));
  cp.execSync('git init -q', { cwd: tmp });
  return tmp;
}

test('bound sub-workspace: mission root matches task root (no split)', () => {
  const repo = tempGitRepo();
  try {
    const sub = path.join(repo, 'customers', 'acme');
    fs.mkdirSync(path.join(sub, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(sub, '.atris', 'business.json'), '{}');
    assert.equal(resolveWorkspaceRoot(sub), workspaceRoot(sub));
    // and it resolves to the sub-workspace, not the git root
    assert.equal(fs.realpathSync(resolveWorkspaceRoot(sub)), fs.realpathSync(sub));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('plain subdir in a git repo resolves to the git toplevel (unchanged)', () => {
  const repo = tempGitRepo();
  try {
    const sub = path.join(repo, 'backend', 'services');
    fs.mkdirSync(sub, { recursive: true });
    assert.equal(fs.realpathSync(resolveWorkspaceRoot(sub)), fs.realpathSync(repo));
    assert.equal(resolveWorkspaceRoot(sub), workspaceRoot(sub));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('framework spine (atris/atris.md) in a subdir wins over parent git root', () => {
  const repo = tempGitRepo();
  try {
    const sub = path.join(repo, 'nested', 'project');
    fs.mkdirSync(path.join(sub, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(sub, 'atris', 'atris.md'), '# spine');
    assert.equal(resolveWorkspaceRoot(sub), workspaceRoot(sub));
    assert.equal(fs.realpathSync(resolveWorkspaceRoot(sub)), fs.realpathSync(sub));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('outside any git repo, returns the caller cwd (never throws)', () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'atris-nogit-'));
  try {
    const out = resolveWorkspaceRoot(tmp);
    assert.equal(typeof out, 'string');
    assert.ok(out.length > 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
