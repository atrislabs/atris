'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');

test('fast scout preserves an error JSON response that has no output field', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-error-json-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  process.env.HOME = home;
  process.chdir(home);
  t.after(() => {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  const response = JSON.stringify({ ok: false, error: 'insufficient credits' });
  t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(response));
      child.emit('close', 0, null);
    });
    return child;
  });
  t.mock.method(require('../lib/engine-resource'), 'startEngineRun', () => () => ({}));
  const { scoutCommand } = require('../commands/scout');
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));

  const code = await scoutCommand(['--yes', '--engine', 'fast', 'where is the credit check?']);
  assert.equal(code, 0);
  const output = lines.join('\n');
  assert.match(output, /"ok":false/, 'the response metadata must survive the raw JSON fallback');
  assert.match(output, /insufficient credits/);
  assert.doesNotMatch(output, /fast lane error:/, 'only responses with string output use the formatted error branch');
});
