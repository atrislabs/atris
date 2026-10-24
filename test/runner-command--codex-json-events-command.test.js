'use strict';
require('./helpers/clean-temp');

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { codexJsonEventsCommand } = require('../lib/runner-command');

const RUNNER_ENV_KEYS = [
  'ATRIS_RUNNER_PROFILE',
  'ATRIS_RUNNER_MODEL',
  'ATRIS_RUNNER_BIN',
  'ATRIS_RUNNER_COMMAND_TEMPLATE',
  'ATRIS_CLAUDE_MODEL',
  'ATRIS_CLAUDE_BIN',
  'ATRIS_CLAUDE_COMMAND_TEMPLATE',
];

function withRunnerEnv(values, fn) {
  const prev = new Map(RUNNER_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of RUNNER_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values || {})) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const key of RUNNER_ENV_KEYS) {
      const value = prev.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// A stand-in codex: the probe runs `bin exec --help`, so the script only
// needs a /bin/sh shebang and echo builtins to survive an empty environment.
// The file must be named `codex`: the basename is what marks the runner.
function fakeCodex({ jsonEvents }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-codex-test-'));
  const bin = path.join(dir, 'codex');
  const lines = jsonEvents
    ? ['echo "Usage: codex exec"', 'echo "  --json"', 'echo "  --output-last-message FILE"']
    : ['echo "Usage: codex exec"', 'echo "  --sandbox MODE"'];
  fs.writeFileSync(bin, `#!/bin/sh\n${lines.join('\n')}\nexit 0\n`, { mode: 0o755 });
  return bin;
}

test('codexJsonEventsCommand inserts the json flags right after "codex exec"', () => {
  const bin = fakeCodex({ jsonEvents: true });
  const lastFile = path.join(path.dirname(bin), 'out.last.txt');
  withRunnerEnv({ ATRIS_RUNNER_BIN: bin }, () => {
    const cmd = `${bin} exec -p "do the thing"`;
    const out = codexJsonEventsCommand(cmd, lastFile);
    assert.equal(out, `${bin} exec --json --output-last-message ${lastFile} -p "do the thing"`);
  });
});

test('codexJsonEventsCommand quotes a last-message path with spaces and keeps the rest verbatim', () => {
  const bin = fakeCodex({ jsonEvents: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris codex spaced-'));
  const lastFile = path.join(dir, 'last message.txt');
  withRunnerEnv({ ATRIS_RUNNER_BIN: bin }, () => {
    const tail = ' -c model_reasoning_effort=high -p "fix it"';
    const out = codexJsonEventsCommand(`${bin} exec${tail}`, lastFile);
    assert.equal(out, `${bin} exec --json --output-last-message '${lastFile}'${tail}`);
  });
});

test('codexJsonEventsCommand returns null when the runner bin is not codex', () => {
  withRunnerEnv({}, () => {
    // Empty env resolves to the default claude bin, so no probe even runs.
    assert.equal(codexJsonEventsCommand('claude -p "hi" --model x', '/tmp/last.txt'), null);
  });
});

test('codexJsonEventsCommand returns null when the command is not a "codex exec" line', () => {
  const bin = fakeCodex({ jsonEvents: true });
  withRunnerEnv({ ATRIS_RUNNER_BIN: bin }, () => {
    assert.equal(codexJsonEventsCommand(`${bin} run -p "hi"`, '/tmp/last.txt'), null);
    assert.equal(codexJsonEventsCommand(`${bin} exec`, '/tmp/last.txt'), null);
    assert.equal(codexJsonEventsCommand('', '/tmp/last.txt'), null);
  });
});

test('codexJsonEventsCommand returns null when the installed codex lacks the json flags', () => {
  const bin = fakeCodex({ jsonEvents: false });
  withRunnerEnv({ ATRIS_RUNNER_BIN: bin }, () => {
    assert.equal(codexJsonEventsCommand(`${bin} exec -p "hi"`, '/tmp/last.txt'), null);
  });
});
