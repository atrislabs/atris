'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ranAgent } = require('../lib/agent-today');

function withRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-agent-today-ran-agent-'));
  const previousHome = process.env.HOME;
  const savedAtrisEnvs = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      savedAtrisEnvs[key] = process.env[key];
      delete process.env[key];
    }
  }
  process.env.HOME = root;
  try {
    fn(root);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    for (const [key, val] of Object.entries(savedAtrisEnvs)) {
      process.env[key] = val;
    }
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

test('ranAgent returns true when Claude, Codex, or autonomous runs are present', () => {
  withRoot(() => {
    assert.strictEqual(ranAgent({ sessions: { claude: 1, codex: 0 }, autoRuns: 0 }), true);
    assert.strictEqual(ranAgent({ sessions: { claude: 0, codex: 2 }, autoRuns: 0 }), true);
    assert.strictEqual(ranAgent({ sessions: { claude: 0, codex: 0 }, autoRuns: 3 }), true);
    assert.strictEqual(ranAgent({ sessions: { claude: 2, codex: 1 }, autoRuns: 4 }), true);
  });
});

test('ranAgent returns false when all sessions and autoRuns are zero', () => {
  withRoot(() => {
    assert.strictEqual(ranAgent({ sessions: { claude: 0, codex: 0 }, autoRuns: 0 }), false);
    assert.strictEqual(
      ranAgent({
        sessions: { claude: 0, codex: 0 },
        autoRuns: 0,
        prompts: 0,
        files: ['lib/agent-today.js'],
        commits: ['fix: prompt formatting'],
      }),
      false
    );
  });
});

test('ranAgent handles edge cases with missing or falsy autoRuns', () => {
  withRoot(() => {
    assert.strictEqual(ranAgent({ sessions: { claude: 1, codex: 0 } }), true);
    assert.strictEqual(ranAgent({ sessions: { claude: 0, codex: 0 } }), false);
    assert.strictEqual(ranAgent({ sessions: { claude: 0, codex: 0 }, autoRuns: undefined }), false);
    assert.strictEqual(ranAgent({ sessions: { claude: 0, codex: 0 }, autoRuns: null }), false);
  });
});

test('ranAgent throws TypeError on invalid or missing summary payload', () => {
  withRoot(() => {
    assert.throws(() => ranAgent(null), TypeError);
    assert.throws(() => ranAgent(undefined), TypeError);
    assert.throws(() => ranAgent({}), TypeError);
    assert.throws(() => ranAgent({ sessions: null }), TypeError);
  });
});
