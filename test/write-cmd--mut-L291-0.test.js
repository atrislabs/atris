'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start, coach } = require('../commands/write');
const resources = require('../lib/engine-resource');

test('a failed version check keeps coaching offline', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-coach-availability-'));
  const previous = { home: process.env.HOME, path: process.env.PATH, cwd: process.cwd(), log: console.log, resource: resources.startEngineRun };
  
  try {
    process.env.HOME = root;
    process.env.PATH = root;
    process.chdir(root);
    // A broken installation reports failure for both version and coaching.
    fs.writeFileSync(path.join(root, 'claude'), '#!/bin/sh\nif [ "$1" = "-p" ]; then printf "%s\\n" "attempted" > "$HOME/coaching-attempt"; fi\nprintf "%s\\n" "installation unavailable" >&2\nexit 1\n', { mode: 0o755 });
    // Keep machine telemetry out of this isolated command test.
    resources.startEngineRun = () => () => null;
    console.log = () => {};
    start(['Availability', '--beats', 'Opening'], root);
    coach(['availability'], root);
    assert.equal(fs.existsSync(path.join(root, 'coaching-attempt')), false);
  } finally {
    console.log = previous.log;
    resources.startEngineRun = previous.resource;
    process.chdir(previous.cwd);
    for (const [key, value] of [['HOME', previous.home], ['PATH', previous.path]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
