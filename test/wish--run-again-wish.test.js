'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runAgainWish, readWishes } = require('../commands/wish');
const { RUNNER_PROFILE_DEFS } = require('../lib/runner-command');

const PARENT = {
  id: 'wish-parent-anchor',
  n: 1,
  ts: '2020-01-15T12:00:00.000Z',
  text: 'make parent thing clearer',
  status: 'delegated',
  requested_engine: 'codex',
};

const OTHER = {
  id: 'wish-other-page',
  n: 2,
  ts: '2020-01-15T11:00:00.000Z',
  text: 'keep the other page',
  status: 'delegated',
};

const FOLLOW = 'fix the header spacing; update the footer copy';
const FOLLOW_ID = /^wish-\d{4}-\d{2}-\d{2}-fix-the-header-spacing-update-the-fo-[0-9a-f]{8}$/;

function withTempHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wish-again-'));
  const previousEnv = { ...process.env };
  const previousCwd = process.cwd();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  process.env.HOME = dir;
  process.chdir(dir);
  try {
    return fn(dir);
  } finally {
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) {
      if (!Object.prototype.hasOwnProperty.call(previousEnv, key)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(previousEnv)) process.env[key] = value;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function captureIo(fn) {
  const stdout = [];
  const stderr = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args) => { stdout.push(args.map(String).join(' ')); };
  console.error = (...args) => { stderr.push(args.map(String).join(' ')); };
  try {
    return { code: fn(), stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

function wishFile(dir) {
  return path.join(dir, '.atris', 'state', 'wishes.jsonl');
}

function readWishLines(dir) {
  const file = wishFile(dir);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function parkEngines(dir) {
  const file = path.join(dir, '.atris', 'state', 'engines.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const engines = Object.keys(RUNNER_PROFILE_DEFS).map((id) => ({
    id,
    installed: false,
    health: { status: 'not_installed', checked_at: '2099-01-01T00:00:00.000Z' },
  }));
  fs.writeFileSync(file, JSON.stringify({ engines }));
}

function seedParents(dir) {
  fs.mkdirSync(path.dirname(wishFile(dir)), { recursive: true });
  fs.writeFileSync(wishFile(dir), `${JSON.stringify(PARENT)}\n${JSON.stringify(OTHER)}\n`);
}

function journalText(dir) {
  const logs = path.join(dir, 'atris', 'logs');
  const chunks = [];
  const walk = (folder) => {
    if (!fs.existsSync(folder)) return;
    for (const name of fs.readdirSync(folder)) {
      const child = path.join(folder, name);
      if (fs.statSync(child).isDirectory()) walk(child);
      else if (name.endsWith('.md')) chunks.push(fs.readFileSync(child, 'utf8'));
    }
  };
  walk(logs);
  return chunks.join('\n');
}

test('runAgainWish rejects a follow-up with no parent or no tweak', () => {
  withTempHome((dir) => {
    seedParents(dir);
    const before = fs.readFileSync(wishFile(dir), 'utf8');

    const empty = captureIo(() => runAgainWish([], dir));
    const missingText = captureIo(() => runAgainWish(['again', 'wish-parent-anchor'], dir));
    const blankText = captureIo(() => runAgainWish(['again', 'wish-parent-anchor', '   '], dir));
    const blankParent = captureIo(() => runAgainWish(['again', '   ', 'make it shorter'], dir));
    const unknown = captureIo(() => runAgainWish(['again', 'wish-missing', 'make the footer shorter'], dir));

    assert.equal(empty.code, 2);
    assert.equal(empty.stderr, 'wish again needs a parent id and tweak text.');
    assert.equal(empty.stdout, '');
    assert.equal(missingText.code, 2);
    assert.equal(missingText.stderr, 'wish again needs a parent id and tweak text.');
    assert.equal(blankText.code, 2);
    assert.equal(blankText.stderr, 'wish again needs a parent id and tweak text.');
    assert.equal(blankParent.code, 2);
    assert.equal(blankParent.stderr, 'wish again needs a parent id and tweak text.');
    assert.equal(unknown.code, 2);
    assert.equal(unknown.stderr, 'No wish found with id wish-missing.');
    assert.equal(unknown.stdout, '');
    assert.equal(fs.readFileSync(wishFile(dir), 'utf8'), before);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
  });
});

test('runAgainWish refuses an unknown engine and does not save that follow-up', () => {
  withTempHome((dir) => {
    parkEngines(dir);
    seedParents(dir);
    const before = fs.readFileSync(wishFile(dir), 'utf8');
    const knownEngines = Object.keys(RUNNER_PROFILE_DEFS).join(', ');

    const refused = captureIo(() => runAgainWish(
      ['again', '#1', FOLLOW],
      dir,
      { noMission: true, engineOverride: 'nope' },
    ));

    assert.equal(refused.code, 2);
    assert.equal(refused.stdout, '');
    assert.equal(
      refused.stderr,
      `Unknown engine "nope". Registered engine ids: ${knownEngines}`,
    );
    assert.equal(fs.readFileSync(wishFile(dir), 'utf8'), before);
    assert.equal(readWishes(dir).some((wish) => wish.parent_id === PARENT.id), false);
  });
});

test('runAgainWish saves a follow-up on the numbered parent and keeps its engine', () => {
  withTempHome((dir) => {
    parkEngines(dir);
    seedParents(dir);

    const saved = captureIo(() => runAgainWish(
      ['again', '  #1  ', `  ${FOLLOW}  `],
      dir,
      { noMission: true },
    ));

    assert.equal(saved.code, 0);
    assert.equal(saved.stdout, [
      'Following up on wish #1: make parent thing.',
      'Got it, wish #3: fix header spacing.',
      'Saved it. I will not start work until you say so.',
    ].join('\n'));

    const child = readWishes(dir).find((wish) => wish.parent_id === PARENT.id);
    assert.ok(child);
    assert.match(child.id, FOLLOW_ID);
    assert.equal(child.n, 3);
    assert.equal(child.text, FOLLOW);
    assert.equal(child.status, 'captured_no_mission');
    assert.equal(child.no_mission, true);
    assert.equal(child.requested_engine, 'codex');
    assert.equal(child.budget, 'long');
    assert.deepEqual(child.questions, []);
    assert.equal(readWishes(dir).find((wish) => wish.id === PARENT.id).status, 'delegated');
    assert.equal(readWishes(dir).some((wish) => wish.parent_id === OTHER.id), false);
    assert.match(journalText(dir), new RegExp(`\\*\\*I1:\\*\\* ${FOLLOW.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

    const lines = readWishLines(dir).filter((row) => row.parent_id === PARENT.id);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].status, 'captured');
    assert.equal(lines[0].requested_engine, 'codex');
    assert.equal(lines[1].status, 'captured_no_mission');
  });
});

test('runAgainWish prints json for a suffix match and uses the named engine', () => {
  withTempHome((dir) => {
    parkEngines(dir);
    seedParents(dir);

    const printed = captureIo(() => runAgainWish(
      ['again', 'parent-anchor', ...FOLLOW.split(' ')],
      dir,
      { noMission: true, asJson: true, engineOverride: 'claude' },
    ));

    assert.equal(printed.code, 0);
    assert.equal(printed.stdout.includes('Following up'), false);
    assert.equal(printed.stdout.includes('Saved it'), false);
    const payload = JSON.parse(printed.stdout);
    assert.match(payload.wish_id, FOLLOW_ID);
    assert.equal(payload.status, 'captured');
    assert.equal(payload.task_id, null);
    assert.equal(payload.mission_id, null);
    assert.equal(payload.engine, null);
    assert.equal(payload.budget, 'long');
    assert.deepEqual(payload.questions, []);

    const child = readWishes(dir).find((wish) => wish.parent_id === PARENT.id);
    assert.ok(child);
    assert.equal(child.id, payload.wish_id);
    assert.equal(child.text, FOLLOW);
    assert.equal(child.status, 'captured_no_mission');
    assert.equal(child.no_mission, true);
    assert.equal(child.requested_engine, 'claude');
    assert.equal(child.n, 3);
  });
});
