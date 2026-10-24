'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a scout with a successful nonempty answer returns success', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-answer-'));
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH };
  const cwd = process.cwd();
  const log = console.log;
  const error = console.error;
  const resources = require('../lib/engine-resource');
  const start = resources.startEngineRun;
  try {
    process.env.HOME = root;
    process.env.PATH = root;
    process.chdir(root);
    // This fixture only prints a canned answer; it cannot contact an engine.
    fs.writeFileSync(path.join(root, 'cursor-agent'), '#!/bin/sh\nprintf \'answer-marker: lib/widget.js:1\\n\'\n', { mode: 0o755 });
    // Resource monitoring is unrelated to interpreting the completed answer.
    resources.startEngineRun = () => () => ({});
    const { scoutCommand } = require('../commands/scout');
    console.log = () => {};
    console.error = () => {};
    const code = await scoutCommand(['--yes', '--engine', 'cursor', '--dir', root, 'Where is the widget?']);
    assert.strictEqual(code, 0);
  } finally {
    resources.startEngineRun = start;
    console.log = log;
    console.error = error;
    process.chdir(cwd);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
