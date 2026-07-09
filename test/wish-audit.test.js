const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { auditWish } = require('../lib/wish-audit');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const systemPath = '/usr/bin:/bin:/usr/sbin:/sbin';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wish-audit-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function prepareWorkspace(dir) {
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
}

function makeFakeEngines(dir) {
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of ['codex', 'claude']) {
    const file = path.join(binDir, name);
    fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', 'utf8');
    fs.chmodSync(file, 0o755);
  }
  return binDir;
}

function withProcessEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) previous[key] = process.env[key];
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function auditQuestions(text) {
  return auditQuestionsInRoot(text, repoRoot);
}

function auditQuestionsInRoot(text, root) {
  const dir = makeTempDir();
  try {
    const fakeBin = makeFakeEngines(dir);
    return withProcessEnv({
      PATH: `${fakeBin}:${systemPath}`,
      NODE_NO_WARNINGS: '1',
    }, () => auditWish(text, root).questions);
  } finally {
    cleanupTempDir(dir);
  }
}

function runCli(args, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      NODE_NO_WARNINGS: '1',
      ...env,
    },
  });
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('subject-bearing vague superlative wish gets one named interpretation question', () => {
  const root = makeTempDir();
  try {
    const questions = auditQuestionsInRoot('make me the best todo list ever', root);
    assert.equal(questions.length, 1);
    assert.match(questions[0], /todo list/);
    assert.match(questions[0], /I would bet/);
    assert.match(questions[0], /\?$/);
  } finally {
    cleanupTempDir(root);
  }
});

test('wish label preserves the noun phrase after a vague superlative', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const env = { PATH: `${fakeBin}:${systemPath}` };
    const created = runCli(['wish', 'make me the best todo list ever', '--no-mission'], { cwd: dir, env });
    assert.equal(created.status, 1, created.stderr || created.stdout);
    assert.match(created.stdout, /^Got it, wish #1: make best todo list\./);
    assert.doesNotMatch(created.stdout, /make me best/);

    const answered = runCli(['wish', 'answer', 'smartest resurfacing', '--no-mission'], { cwd: dir, env });
    assert.equal(answered.status, 0, answered.stderr || answered.stdout);

    const listed = runCli(['wish', 'list', '--all'], { cwd: dir, env });
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    assert.match(listed.stdout, /#1 make best todo list - new/);

    const records = readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl'));
    assert.equal(records.every((record) => String(record.text || '').includes('todo list')), true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('vague interview candidates follow the subject kind with a generic fallback', () => {
  assert.deepEqual(auditQuestions('sweep'), [
    'This could mean faster to use, smarter by default, or more complete. I would bet on smarter by default, so which should I optimize for?',
    'Audience could mean solo operator, team member, or end user. I would bet on solo operator, so who is this for?',
    'First slice could mean first step, default behavior, or completion path. I would bet on default behavior, so what should I change first?',
  ]);
  assert.equal(
    auditQuestions('best landing page ever')[0],
    'Best landing page could mean clearer layout, faster scanning, or stronger action. I would bet on clearer layout, so which should I optimize for?',
  );
  assert.equal(
    auditQuestions('best auth flow ever')[0],
    'Best auth flow could mean fewer steps, smarter defaults, or more reliable completion. I would bet on smarter defaults, so which should I optimize for?',
  );
});

test('wish answer fills a named interpretation question without repeating it', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const env = { PATH: `${fakeBin}:${systemPath}` };
    const created = runCli(['wish', 'make me the best todo list ever', '--no-mission'], { cwd: dir, env });
    assert.equal(created.status, 1, created.stderr || created.stdout);
    assert.match(created.stdout, /Best todo list could mean fastest capture, smartest resurfacing, or most closure\./);

    const answer = 'smartest resurfacing for my personal task loop';
    const answered = runCli(['wish', 'answer', answer, '--no-mission'], { cwd: dir, env });
    assert.equal(answered.status, 0, answered.stderr || answered.stdout);
    assert.doesNotMatch(answered.stdout, /Best todo list could mean fastest capture/);
    assert.doesNotMatch(answered.stdout, /Answer with:/);

    const records = readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl'));
    const repeatedRows = records.filter((record) => Array.isArray(record.questions)
      && record.questions.some((question) => String(question).startsWith('Best todo list could mean fastest capture')));
    assert.equal(repeatedRows.length, 1);
    assert.equal(records.some((record) => record.answer === answer), true);
    assert.equal(records.some((record) => record.kind === 'slot'
      && record.filled_slots
      && String(record.filled_slots[0].question || '').startsWith('Best todo list could mean fastest capture')), true);
    assert.equal(records.some((record) => record.status === 'captured_no_mission'), true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('clear wish gets no clarity questions', () => {
  const root = makeTempDir();
  try {
    assert.deepEqual(auditQuestionsInRoot('add a csv export to the task list', root), []);
  } finally {
    cleanupTempDir(root);
  }
  assert.deepEqual(auditQuestions('make the README clearer'), []);
});
