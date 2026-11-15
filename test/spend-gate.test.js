'use strict';

// A named model runs as named (owner's call, 2026-11-15). Opus, Fable and
// Sonnet used to drop to Haiku unless ATRIS_CLAUDE_SPEND_OK named them, while
// the run record still said the model that was asked for. Nothing is swapped
// now: the model a roster, task, mission, env setting or person names is the
// --model the claude command gets, and the record says the same model. Haiku
// is only the default when nothing names a model. A run that could bill is
// stopped by the Claude spend guard (test/claude-spend-guard.test.js), never
// moved to another model.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const runner = require('../lib/runner-command');
const {
  DEFAULT_CLAUDE_RUNNER_MODEL,
  resolveClaudeRunnerModel,
  resolvePinnedRunnerModel,
  buildRunnerCommand,
  launchFor,
} = runner;

const ENV_KEYS = [
  'ATRIS_RUNNER_PROFILE',
  'ATRIS_RUNNER_MODEL',
  'ATRIS_RUNNER_BIN',
  'ATRIS_RUNNER_COMMAND_TEMPLATE',
  'ATRIS_CLAUDE_MODEL',
  'ATRIS_CLAUDE_BIN',
  'ATRIS_CLAUDE_COMMAND_TEMPLATE',
  'ATRIS_CLAUDE_SPEND_OK',
];

// Runs fn with a clean runner env plus `values`, and returns what it wrote to stderr.
function launched(values, fn) {
  const prev = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values || {})) process.env[key] = value;
  const realWrite = process.stderr.write;
  let stderr = '';
  process.stderr.write = (chunk) => { stderr += String(chunk); return true; };
  try {
    fn();
  } finally {
    process.stderr.write = realWrite;
    for (const key of ENV_KEYS) {
      const value = prev.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return stderr;
}

test('the swap is gone from the module', () => {
  assert.equal(runner.applySpendGate, undefined);
  assert.equal(runner.resetSpendGateWarnings, undefined);
});

test('the default is haiku when nothing names a model, and prints nothing', () => {
  const stderr = launched({}, () => {
    assert.equal(DEFAULT_CLAUDE_RUNNER_MODEL, 'claude-haiku-5-5');
    assert.equal(resolveClaudeRunnerModel({}), 'claude-haiku-5-5');
    assert.match(buildRunnerCommand({ promptFile: '/tmp/p.tmp' }), /--model claude-haiku-5-5$/);
  });
  assert.equal(stderr, '');
});

test('opus named by env runs opus with no yes and says nothing', () => {
  const stderr = launched({ ATRIS_RUNNER_MODEL: 'claude-opus-5-5' }, () => {
    assert.equal(resolveClaudeRunnerModel({}), 'claude-opus-5-5');
    assert.match(buildRunnerCommand({ promptFile: '/tmp/p.tmp' }), /--model claude-opus-5-5$/);
  });
  assert.equal(stderr, '');
  assert.doesNotMatch(stderr, /needs the owner's yes/);
});

test('opus with ATRIS_CLAUDE_SPEND_OK naming it still runs opus', () => {
  const stderr = launched({ ATRIS_RUNNER_MODEL: 'claude-opus-5-5', ATRIS_CLAUDE_SPEND_OK: 'claude-opus-5-5' }, () => {
    assert.equal(resolveClaudeRunnerModel({}), 'claude-opus-5-5');
    assert.match(buildRunnerCommand({ promptFile: '/tmp/p.tmp' }), /--model claude-opus-5-5$/);
  });
  assert.equal(stderr, '');
});

test('a yes for another model changes nothing: each named model runs as named', () => {
  launched({ ATRIS_CLAUDE_SPEND_OK: 'claude-sonnet-5-5' }, () => {
    assert.equal(resolveClaudeRunnerModel({ model: 'claude-opus-5-5' }), 'claude-opus-5-5');
    assert.equal(resolveClaudeRunnerModel({ model: 'claude-sonnet-5-5' }), 'claude-sonnet-5-5');
  });
});

test('whatever ATRIS_CLAUDE_SPEND_OK says, the named model is the one launched', () => {
  for (const yes of ['', '1', 'true', 'opus', 'claude-opus']) {
    launched({ ATRIS_CLAUDE_SPEND_OK: yes }, () => {
      assert.equal(resolveClaudeRunnerModel({ model: 'claude-opus-5-5' }), 'claude-opus-5-5', yes);
    });
  }
});

test('fable and sonnet run as named too, whatever the case', () => {
  const stderr = launched({}, () => {
    assert.equal(resolveClaudeRunnerModel({ model: 'claude-fable-5-2' }), 'claude-fable-5-2');
    assert.equal(resolveClaudeRunnerModel({ model: 'claude-fable-5-1' }), 'claude-fable-5-1');
    assert.equal(resolveClaudeRunnerModel({ model: 'claude-sonnet-5-5' }), 'claude-sonnet-5-5');
    assert.equal(resolveClaudeRunnerModel({ model: 'CLAUDE-OPUS-5-5' }), 'claude-opus-5-5');
    assert.match(buildRunnerCommand({ promptFile: '/tmp/p.tmp', model: 'claude-fable-5-2' }), /--model claude-fable-5-2$/);
    assert.match(buildRunnerCommand({ promptFile: '/tmp/p.tmp', model: 'claude-sonnet-5-5' }), /--model claude-sonnet-5-5$/);
  });
  assert.equal(stderr, '');
});

test('short names run as that model, never as haiku', () => {
  launched({}, () => {
    // A version typed as words becomes its full id.
    assert.match(buildRunnerCommand({ promptFile: '/tmp/p.tmp', model: 'opus 5.5' }), /--model claude-opus-5-5$/);
    assert.match(buildRunnerCommand({ promptFile: '/tmp/p.tmp', model: 'fable 5.2' }), /--model claude-fable-5-2$/);
    assert.match(buildRunnerCommand({ promptFile: '/tmp/p.tmp', model: 'sonnet 5.5' }), /--model claude-sonnet-5-5$/);
    // A bare family name is the claude cli's own alias for that family, passed as typed.
    for (const alias of ['opus', 'sonnet', 'fable']) {
      const cmd = buildRunnerCommand({ promptFile: '/tmp/p.tmp', model: alias });
      assert.match(cmd, new RegExp(`--model ${alias}$`), alias);
      assert.doesNotMatch(cmd, /haiku/, alias);
    }
  });
});

test('the fable profile and the legacy env run their named model', () => {
  launched({ ATRIS_RUNNER_PROFILE: 'fable' }, () => {
    assert.equal(resolveClaudeRunnerModel({}), 'claude-fable-5-1');
    assert.match(buildRunnerCommand({ promptFile: '/tmp/p.tmp' }), /--model claude-fable-5-1$/);
  });
  launched({ ATRIS_CLAUDE_MODEL: 'claude-opus-5-5' }, () => {
    assert.equal(resolveClaudeRunnerModel({}), 'claude-opus-5-5');
  });
});

test('a pinned model in a command template runs as named', () => {
  launched({
    ATRIS_RUNNER_COMMAND_TEMPLATE: '{bin} -p {prompt} {pinnedModelFlag}',
  }, () => {
    const cmd = buildRunnerCommand({ promptFile: '/tmp/p.tmp', model: 'claude-opus-5-5' });
    assert.match(cmd, /--model claude-opus-5-5/);
    assert.doesNotMatch(cmd, /haiku/);
  });
});

test('haiku runs as named, with or without a yes', () => {
  launched({ ATRIS_RUNNER_MODEL: 'claude-haiku-5-5' }, () => {
    assert.equal(resolveClaudeRunnerModel({}), 'claude-haiku-5-5');
  });
  const stderr = launched({ ATRIS_CLAUDE_SPEND_OK: 'claude-opus-5-5' }, () => {
    assert.equal(resolveClaudeRunnerModel({ model: 'claude-haiku-5-5' }), 'claude-haiku-5-5');
  });
  assert.equal(stderr, '');
});

test('an engine that runs only its own models is still never handed a claude model', () => {
  for (const profile of ['codex', 'grok', 'muse']) {
    const stderr = launched({ ATRIS_RUNNER_PROFILE: profile }, () => {
      const cmd = buildRunnerCommand({ promptFile: '/tmp/p.tmp', model: 'claude-opus-5-5' });
      assert.doesNotMatch(cmd, /claude-opus|haiku/, profile);
    });
    assert.equal(stderr, '', profile);
  }
});

test('an engine with no model slot never carries a model', () => {
  for (const profile of ['atris-fast', 'mercury', 'composer', 'commandcode']) {
    launched({ ATRIS_RUNNER_PROFILE: profile }, () => {
      assert.equal(runner.engineTakesModel(profile), false, profile);
      assert.doesNotMatch(buildRunnerCommand({ promptFile: '/tmp/p.tmp', model: 'claude-opus-5-5' }), /--model/, profile);
    });
  }
});

test('the pin and launchFor name the same model the command carries', () => {
  launched({}, () => {
    assert.equal(resolvePinnedRunnerModel({ model: 'claude-opus-5-5' }), 'claude-opus-5-5');
  });
  for (const engine of ['claude', 'fable', 'haiku']) {
    const said = launchFor(engine, { env: {}, model: 'claude-opus-5-5' }).model;
    let cmd = '';
    launched({ ATRIS_RUNNER_PROFILE: engine }, () => {
      cmd = buildRunnerCommand({ promptFile: '/tmp/p.tmp', model: 'claude-opus-5-5' });
    });
    assert.equal(said, 'claude-opus-5-5', engine);
    assert.equal(/--model (\S+)/.exec(cmd)[1], said, engine);
  }
});

test('the run record names the model the claude command was given, for an opus pin', async (t) => {
  const fleet = require('../lib/fleet');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-named-model-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const commands = [];
  let result;
  const prev = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  try {
    result = await fleet.dispatchEntryWithRestaff({
      entry: {
        task: { display_id: 'X-1', title: 'Fix it' },
        worktreePath: root,
        prompt: 'Fix it.',
        roster_pin: { model: 'claude-opus-5-5' },
      },
      engine: 'claude',
      root,
      // The default dispatch hands the pin's model to buildEngineCommand; this does the same and keeps the command.
      dispatch: (e) => {
        commands.push(fleet.buildEngineCommand(e.engine, path.join(root, 'prompt.md'), { model: e.roster_pin && e.roster_pin.model }));
        return Promise.resolve({ exitCode: 0, report: 'built' });
      },
      installedEngines: [],
      restaffState: { used: false },
      scoutAsk: false,
    });
  } finally {
    for (const key of ENV_KEYS) {
      const value = prev.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.equal(commands.length, 1);
  const passed = /--model (\S+)/.exec(commands[0])[1];
  assert.equal(passed, 'claude-opus-5-5');
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].model, passed, 'the record says the model the command was given');
});
