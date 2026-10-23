'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-check-'));
const savedEnv = {};
for (const key of Object.keys(process.env)) {
  if (key === 'HOME' || key.startsWith('ATRIS_')) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
}
process.env.HOME = home;
test.after(() => {
  delete process.env.HOME;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  fs.rmSync(home, { recursive: true, force: true });
});

const { taskCheck } = require('../lib/member-task-pick');

test('taskCheck trims an allowed verification command without changing the task', () => {
  const task = { metadata: { verify: ' \n node --test test/example.test.js\t ' } };
  assert.deepStrictEqual(taskCheck(task), {
    command: 'node --test test/example.test.js',
    runnable: true,
  });
  assert.strictEqual(task.metadata.verify, ' \n node --test test/example.test.js\t ');
});

test('taskCheck allows a chain only when every command is allowed', () => {
  const allowed = 'node --test test/first.test.js && node --test test/second.test.js';
  assert.deepStrictEqual(taskCheck({ metadata: { verify: allowed } }), {
    command: allowed,
    runnable: true,
  });
  const rejected = 'node --test test/first.test.js && ask a person to review';
  assert.deepStrictEqual(taskCheck({ metadata: { verify: rejected } }), {
    command: rejected,
    runnable: false,
  });
});

test('taskCheck preserves rejected prose and shell syntax as non-runnable checks', () => {
  for (const command of [
    'review the result manually',
    'node --test test/example.test.js | cat',
    'node --test test/example.test.js &&',
  ]) {
    assert.deepStrictEqual(taskCheck({ metadata: { verify: `  ${command}  ` } }), {
      command,
      runnable: false,
    });
  }
});

test('taskCheck treats missing, blank, and non-string checks as optional', () => {
  for (const task of [
    undefined, null, {}, { metadata: null }, { metadata: {} },
    ...['', ' \n\t ', null, false, 42, [], {}].map((verify) => ({ metadata: { verify } })),
    { verify: 'review manually', metadata: { body: 'node --test' } },
  ]) {
    assert.deepStrictEqual(taskCheck(task), { command: '', runnable: true });
  }
});
