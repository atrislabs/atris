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
  const dir = makeTempDir();
  try {
    const fakeBin = makeFakeEngines(dir);
    return withProcessEnv({
      PATH: `${fakeBin}:${systemPath}`,
      NODE_NO_WARNINGS: '1',
    }, () => auditWish(text, repoRoot).questions);
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

test('vague superlative wish gets named interpretations and a recommendation', () => {
  const questions = auditQuestions('best todo list ever');
  assert.equal(questions[0], 'Best could mean fastest capture, smartest resurfacing, or most closure. I would bet on resurfacing, so which should I optimize for?');
  assert.match(questions[1], /^Todo list audience could mean todo list owner, team member, or end user\. I would bet on todo list owner, so who is this for\?$/);
  assert.match(questions[2], /^Todo list first slice could mean todo list capture path, resurfacing rule, or closure loop\. I would bet on resurfacing rule, so what should I change first\?$/);
  assert.ok(questions.every((question) => question.endsWith('?')));
});

test('wish answer fills a named interpretation question without repeating it', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const env = { PATH: `${fakeBin}:${systemPath}` };
    const created = runCli(['wish', 'best todo list ever', '--no-mission'], { cwd: dir, env });
    assert.equal(created.status, 1, created.stderr || created.stdout);
    assert.match(created.stdout, /Best could mean fastest capture, smartest resurfacing, or most closure\./);

    const answer = 'smartest resurfacing for my personal task loop';
    const answered = runCli(['wish', 'answer', answer, '--no-mission'], { cwd: dir, env });
    assert.equal(answered.status, 0, answered.stderr || answered.stdout);
    assert.doesNotMatch(answered.stdout, /Best could mean fastest capture/);
    assert.doesNotMatch(answered.stdout, /Answer with:/);

    const records = readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl'));
    const repeatedRows = records.filter((record) => Array.isArray(record.questions)
      && record.questions.some((question) => String(question).startsWith('Best could mean fastest capture')));
    assert.equal(repeatedRows.length, 1);
    assert.equal(records.some((record) => record.answer === answer), true);
    assert.equal(records.some((record) => record.kind === 'slot'
      && record.filled_slots
      && String(record.filled_slots[0].question || '').startsWith('Best could mean fastest capture')), true);
    assert.equal(records.some((record) => record.status === 'captured_no_mission'), true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('clear wish gets no clarity questions', () => {
  assert.deepEqual(auditQuestions('make the README clearer'), []);
});
