'use strict';

// Regression: the README must show how to give members a job and how to keep
// one member working, and each command it shows must route the way it says.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const { memberRunVerb, memberWakeVerb } = require('../lib/member-verbs');

function membersSection() {
  const start = README.indexOf('### Put members to work');
  assert.ok(start >= 0, 'expected a "Put members to work" heading');
  const rest = README.slice(README.indexOf('\n', start) + 1);
  const next = rest.search(/^#{2,3} /m);
  return next >= 0 ? rest.slice(0, next) : rest;
}

function teamRoot(names) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-members-jobs-'));
  for (const name of names) {
    fs.mkdirSync(path.join(root, 'atris', 'team', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'team', name, 'MEMBER.md'), `# ${name}\n`);
  }
  return root;
}

function recorder() {
  const calls = [];
  return {
    calls,
    wake: (...args) => { calls.push(['wake', ...args]); return { ok: true }; },
    up: (...args) => { calls.push(['up', ...args]); return { ok: true }; },
    print: () => {},
  };
}

test('README gives a member a job with run, and run hands an unnamed job to the picker', () => {
  assert.match(membersSection(), /atris member run "fix one failing test"/);
  const root = teamRoot(['executor']);
  const calls = [];
  memberRunVerb(['fix one failing test'], {
    root,
    run: (...args) => calls.push(['run', ...args]),
    dispatch: (...args) => calls.push(['dispatch', ...args]),
  });
  assert.deepStrictEqual(calls, [['dispatch', 'fix one failing test', '--ignite']]);
});

test('README keeps one member working with wake <name> --keep, and that keeps it working', async () => {
  const section = membersSection();
  assert.match(section, /atris member wake executor --keep/);
  assert.match(section, /one step of work/);
  const h = recorder();
  await memberWakeVerb(['executor', '--keep'], h);
  assert.deepStrictEqual(h.calls, [['up', '--only', 'executor']]);
});

test('a single name without --keep is one step, as the README says', async () => {
  const h = recorder();
  await memberWakeVerb(['executor'], h);
  assert.deepStrictEqual(h.calls, [['wake', 'executor']]);
});

test('README wake examples for a number and for names keep members working', async () => {
  const section = membersSection();
  assert.match(section, /atris member wake 5/);
  assert.match(section, /atris member wake navigator executor/);
  const byCount = recorder();
  await memberWakeVerb(['5'], byCount);
  assert.deepStrictEqual(byCount.calls, [['up', '--max', '5']]);
  const byName = recorder();
  await memberWakeVerb(['navigator', 'executor'], byName);
  assert.deepStrictEqual(byName.calls, [['up', '--only', 'navigator,executor']]);
});

test('members section has no long dashes', () => {
  assert.ok(!membersSection().includes('—'), 'no em dashes in the members section');
});
