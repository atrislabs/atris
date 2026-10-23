'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runLocalFallback } = require('../commands/improve');

test('local fallback preserves the workspace redirection diagnostic', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-fallback-diagnostic-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  process.env.HOME = root;
  execFileSync('git', ['init', '-q'], { cwd: root });
  const nested = path.join(root, 'nested');
  fs.mkdirSync(nested);
  process.chdir(nested);
  try {
    const result = await runLocalFallback({ workspace: nested });
    assert.match(result.stderr, /anchoring mission state/i);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
