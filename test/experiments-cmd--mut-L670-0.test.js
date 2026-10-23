const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a rejected benchmark review exits unsuccessfully', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-review-'));
  const previousHome = process.env.HOME;
  const previousBackend = process.env.ATRIS_BACKEND_ROOT;
  const previousCwd = process.cwd();
  process.env.HOME = root;
  process.env.ATRIS_BACKEND_ROOT = root;
  try {
    const autopilot = require('../commands/autopilot');
    t.mock.method(autopilot, 'runTaskOnce', () => ({
      reviewOutput: 'failed: implementation does not satisfy the task',
      phaseResults: {
        plan: { output: 'plan prepared', elapsedSeconds: 0 },
        do: { output: 'implementation prepared', elapsedSeconds: 0 },
        review: { output: 'failed: implementation does not satisfy the task', elapsedSeconds: 0 },
      },
      verifyPassed: false,
    }));
    const { experimentsCommand } = require('../commands/experiments');
    for (const relative of ['atris/features/endstate', 'atris/experiments/endstate-baseline']) {
      fs.cpSync(path.join(__dirname, '..', relative), path.join(root, relative), { recursive: true });
    }
    const pack = path.join(root, 'atris/experiments/endstate-baseline');
    fs.rmSync(path.join(pack, 'artifacts'), { recursive: true, force: true });
    process.chdir(root);
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});
    let exitCode;
    const exitSignal = new Error('command exit');
    t.mock.method(process, 'exit', (code) => { exitCode = code; throw exitSignal; });
    try {
      experimentsCommand('run', 'endstate-baseline');
    } catch (error) {
      if (error !== exitSignal) throw error;
    }
    assert.equal(exitCode, 1);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousBackend === undefined) delete process.env.ATRIS_BACKEND_ROOT;
    else process.env.ATRIS_BACKEND_ROOT = previousBackend;
  }
});
