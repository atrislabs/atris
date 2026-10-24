'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  addIdea,
  changeRefusal,
  ideaRefusal,
  nextWaitingIdea,
  readIdeas,
  stateFile,
  updateIdea,
} = require('../lib/idea-inbox');

const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-idea-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  return fs.realpathSync(dir);
}

function atris(args, cwd) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', NO_COLOR: '1' },
    timeout: 30000,
  });
}

test('atris idea saves a sentence and lists it as waiting', () => {
  const repo = tempRepo();
  const saved = atris(['idea', 'make the inbox search faster'], repo);
  assert.equal(saved.status, 0, saved.stderr);
  assert.match(saved.stdout, /saved idea 1: make the inbox search faster/);

  const listed = atris(['idea'], repo);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /1\. waiting\s+make the inbox search faster/);

  const json = JSON.parse(atris(['idea', '--json'], repo).stdout);
  assert.equal(json.ideas.length, 1);
  assert.equal(json.ideas[0].status, 'waiting');
});

test('--repo saves the idea into that repo, not the current folder', () => {
  const here = tempRepo();
  const there = tempRepo();
  const saved = atris(['idea', 'tidy the help text', '--repo', there], here);
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(fs.existsSync(stateFile(here)), false);
  assert.equal(readIdeas(there).length, 1);
  assert.equal(readIdeas(there)[0].text, 'tidy the help text');
});

test('ideas touching money, sending, auth, deleting data, or migrations are refused at intake', () => {
  const cases = [
    ['add a refund button to billing', /money/],
    ['send the weekly digest to every customer', /sending messages or email/],
    ['rotate the oauth tokens', /auth/],
    ['delete old user records', /deleting user data/],
    ['add a migration for the tags column', /database migrations/],
  ];
  for (const [sentence, area] of cases) {
    const reason = ideaRefusal(sentence);
    assert.match(reason, area, sentence);
    assert.match(reason, /needs owner$/, sentence);
  }
  assert.equal(ideaRefusal('make the inbox search faster'), '');
  assert.equal(ideaRefusal('speed up the test runner'), '');
});

test('a refused idea stays on the list with its reason and a retry will not unrefuse it', () => {
  const repo = tempRepo();
  const saved = atris(['idea', 'rotate the oauth tokens'], repo);
  assert.equal(saved.status, 0, saved.stderr);
  assert.match(saved.stdout, /will not build it alone: touches auth/);

  const listed = atris(['idea'], repo).stdout;
  assert.match(listed, /1\. refused\s+rotate the oauth tokens/);
  assert.match(listed, /touches auth \("oauth"\), needs owner/);

  const retried = atris(['idea', 'retry', '1'], repo);
  assert.equal(retried.status, 2);
  assert.equal(readIdeas(repo)[0].status, 'refused');
});

test('retry puts a failed build back in line', () => {
  const repo = tempRepo();
  const idea = addIdea(repo, 'speed up the test runner');
  updateIdea(repo, idea.id, { status: 'refused', reason: 'the checks failed' });
  const retried = atris(['idea', 'retry', '1'], repo);
  assert.equal(retried.status, 0, retried.stderr);
  const after = readIdeas(repo)[0];
  assert.equal(after.status, 'waiting');
  assert.equal(after.reason, '');
});

test('the oldest waiting idea goes first', () => {
  const repo = tempRepo();
  const first = addIdea(repo, 'speed up the test runner');
  const second = addIdea(repo, 'make the inbox search faster');
  assert.equal(nextWaitingIdea(readIdeas(repo)).id, first.id);
  updateIdea(repo, first.id, { status: 'building' });
  assert.equal(nextWaitingIdea(readIdeas(repo)).id, second.id);
});

test('a built change touching protected paths or destructive SQL is refused', () => {
  assert.match(changeRefusal({ paths: ['db/migrations/0042_tags.sql'] }), /database migrations/);
  assert.match(changeRefusal({ paths: ['lib/auth.js'] }), /auth \(lib\/auth\.js\)/);
  assert.match(changeRefusal({ paths: ['backend/routers/billing/stripe_hooks.py'] }), /money/);
  assert.match(changeRefusal({ paths: ['scripts/send_outreach.py'] }), /sending/);
  assert.match(changeRefusal({ paths: ['lib/search.js'], addedLines: ['db.run("DROP TABLE users")'] }), /deleting user data/);
  assert.equal(changeRefusal({ paths: ['lib/search.js', 'test/search.test.js'], addedLines: ['const fast = true;'] }), '');
});
