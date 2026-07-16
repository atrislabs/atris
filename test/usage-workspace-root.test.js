const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const { recordUsage, readUsage, usagePath } = require('../lib/usage');
const { knownCommands } = require('../lib/known-commands');

// Footgun (a), usage store: telemetry wrote to <cwd>/.atris, so a command run
// from a subdirectory with its own nested .atris split usage away from the
// workspace root. Usage must now land at the shared workspace root.

const CMD = knownCommands[0]; // any real command name

function tempGitRepoWithAtris() {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'atris-usage-'));
  cp.execSync('git init -q', { cwd: tmp });
  fs.mkdirSync(path.join(tmp, '.atris'), { recursive: true });
  return tmp;
}

test('usage from a subdirectory lands at the workspace root, not the subdir', () => {
  const repo = tempGitRepoWithAtris();
  try {
    const sub = path.join(repo, 'backend');
    fs.mkdirSync(sub, { recursive: true });
    recordUsage(CMD, sub);
    const rootFile = path.join(repo, '.atris', 'state', 'usage.jsonl');
    const subFile = path.join(sub, '.atris', 'state', 'usage.jsonl');
    assert.ok(fs.existsSync(rootFile), 'usage recorded at the workspace root');
    assert.ok(!fs.existsSync(subFile), 'no split-brain usage file under the subdir');
    // read is consistent whether the caller stands at root or in the subdir
    assert.equal(readUsage(sub).length, 1);
    assert.equal(readUsage(repo).length, 1);
    assert.equal(usagePath(sub), usagePath(repo));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('pristine tree with no .atris anywhere records nothing (no litter)', () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'atris-usage-bare-'));
  cp.execSync('git init -q', { cwd: tmp });
  try {
    const sub = path.join(tmp, 'src');
    fs.mkdirSync(sub, { recursive: true });
    recordUsage(CMD, sub);
    assert.ok(!fs.existsSync(path.join(tmp, '.atris')), 'no .atris created at root');
    assert.ok(!fs.existsSync(path.join(sub, '.atris')), 'no .atris created in subdir');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('unknown command name is never recorded', () => {
  const repo = tempGitRepoWithAtris();
  try {
    recordUsage('definitely-not-a-real-command', repo);
    assert.ok(!fs.existsSync(path.join(repo, '.atris', 'state', 'usage.jsonl')));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
