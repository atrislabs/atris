const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  if (result.error) throw result.error;
  return result;
}

// The natural-language flow saves state (context profile, focus direction),
// so a mistyped command must never silently become saved direction.
test('a near-miss command stops with a suggestion instead of entering the NL flow', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-typo-guard-'));
  try {
    for (const [typo, suggestion] of [
      ['chat-scan', 'atris chat scan'],
      ['stauts', 'atris status'],
      ['misison', 'atris mission'],
      ['task-render', 'atris task render'],
    ]) {
      const res = runCli([typo], dir);
      assert.equal(res.status, 2, `${typo}: ${res.stdout}`);
      assert.match(res.stdout, new RegExp(`Did you mean: ${suggestion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), typo);
    }
    // no NL state may be written by a refused typo
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'context_profile.json')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the guard never hijacks real commands or unrelated words', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-typo-guard-'));
  try {
    // a real command still dispatches (version is cheap and workspace-free)
    const real = runCli(['version'], dir);
    assert.equal(real.status, 0, real.stdout);
    // an unrelated word finds no suggestion; --json unknown-command path still exits 2 with JSON
    const nl = runCli(['refrigerator', '--json'], dir);
    assert.equal(nl.status, 2);
    const payload = JSON.parse(nl.stdout);
    assert.equal(payload.ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
