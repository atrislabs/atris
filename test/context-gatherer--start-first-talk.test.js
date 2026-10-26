'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startFirstTalk } = require('../lib/context-gatherer');

function fixture(t, exitStatus = 0) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'first-talk-test-'));
  const savedEnv = { ...process.env };
  const savedScript = process.argv[1];
  t.after(() => {
    if (require.cache[require.resolve('../lib/task-db')]) {
      require('../lib/task-db').close();
    }
    process.argv[1] = savedScript;
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  process.env.HOME = temporary;
  process.env.USER = 'alex';
  process.env.LOGNAME = 'alex';
  const root = path.join(temporary, 'garden');
  fs.mkdirSync(root);
  // runSilentMinimalInit uses argv[1]. Keep that subprocess local and finite,
  // rather than recursively launching this test or running the full CLI.
  const initializer = path.join(temporary, 'initialize.cjs');
  fs.writeFileSync(initializer, `
    const assert = require('node:assert');
    const fs = require('node:fs');
    assert.deepStrictEqual(process.argv.slice(2), ['init', '--minimal', '--yes']);
    if (${exitStatus} !== 0) process.exit(${exitStatus});
    fs.mkdirSync('atris', { recursive: true });
  `);
  process.argv[1] = initializer;
  return { root, profile: path.join(root, '.atris', 'state', 'context_profile.json') };
}

test('startFirstTalk saves normalized context and returns the claimed starter in JSON', (t) => {
  const { root, profile } = fixture(t);
  const logs = [];
  assert.strictEqual(startFirstTalk(root, '  build a\n garden website  ', {
    asJson: true, log: (line) => logs.push(line),
  }), 0);
  assert.strictEqual(logs.length, 1);
  const output = JSON.parse(logs[0]);
  assert.deepStrictEqual(output, {
    schema: 'atris.one_lap.v1', ok: true, status: 'started',
    next_action: `atris "add a test for the claimed task"`,
    task: { display_id: output.task.display_id, title: 'build a garden website' },
  });
  assert.match(output.task.display_id, /^[A-Z0-9]{3}-1$/);
  const saved = JSON.parse(fs.readFileSync(profile, 'utf8'));
  assert.strictEqual(saved.schema, 'atris.context_profile.v1');
  assert.strictEqual(saved.source, 'first_talk');
  assert.strictEqual(saved.first_answer, 'build a garden website');
  assert.strictEqual(saved.inferred_domain, 'building');
  const taskDb = require('../lib/task-db');
  const rows = taskDb.listTasks(taskDb.open(), { workspaceRoot: taskDb.workspaceRoot(root) });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].title, 'build a garden website');
  assert.strictEqual(rows[0].status, 'claimed');
  assert.strictEqual(rows[0].claimed_by, 'alex');
  assert.match(fs.readFileSync(path.join(root, 'atris', 'TODO.md'), 'utf8'), /build a garden website/);
});

test('startFirstTalk renders an empty answer without saving context or creating a task', (t) => {
  const { root, profile } = fixture(t);
  const logs = [];
  assert.strictEqual(startFirstTalk(root, ' \n\t ', { log: (line) => logs.push(line) }), 0);
  assert.deepStrictEqual(logs, [
    '',
    'hey alex, garden is started. nothing is built yet.\n\nnext: atris task new "garden"',
  ]);
  assert.strictEqual(fs.existsSync(profile), false);
  assert.strictEqual(fs.existsSync(path.join(root, 'atris', 'TODO.md')), false);
});

test('startFirstTalk returns initializer failure without saving context or logging success', (t) => {
  const { root, profile } = fixture(t, 7);
  const logs = [];
  assert.strictEqual(startFirstTalk(root, 'build a website', {
    asJson: true, log: (line) => logs.push(line),
  }), 7);
  assert.deepStrictEqual(logs, []);
  assert.strictEqual(fs.existsSync(profile), false);
  assert.deepStrictEqual(fs.readdirSync(root), []);
});
