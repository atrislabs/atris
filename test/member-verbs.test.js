'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { memberRunVerb, memberWakeVerb } = require('../lib/member-verbs');
const { createMemberUp, parseMemberUpArgs } = require('../lib/member-up');

// A temp project with the given members, each a folder with a MEMBER.md.
function tempProject(t, members = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-verbs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of members) {
    const dir = path.join(root, 'atris', 'team', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'MEMBER.md'), `---\nname: ${name}\nrole: ${name}\ndescription: works on ${name} things\n---\n\n# ${name}\n`);
  }
  return root;
}

// Handlers that record every call and start nothing.
function stubs(root) {
  const calls = [];
  const lines = [];
  return {
    calls,
    lines,
    handlers: {
      root,
      run: (...args) => { calls.push(['run', ...args]); return 'ran'; },
      dispatch: (...args) => { calls.push(['dispatch', ...args]); return 'dispatched'; },
      wake: async (...args) => { calls.push(['wake', ...args]); return { ok: true, decision: 'tick' }; },
      up: async (...args) => { calls.push(['up', ...args]); return 'up'; },
      print: (line) => lines.push(line),
    },
  };
}

test('run with a job and no member name routes to dispatch with --ignite', (t) => {
  const root = tempProject(t, ['navigator', 'executor']);
  const s = stubs(root);
  assert.equal(memberRunVerb(['fix the flaky login test', '--json'], s.handlers), 'dispatched');
  assert.deepEqual(s.calls, [['dispatch', 'fix the flaky login test', '--json', '--ignite']]);
});

test('run with several plain words treats them all as the job', (t) => {
  const root = tempProject(t, ['navigator']);
  const s = stubs(root);
  memberRunVerb(['fix', 'the', 'login', 'bug'], s.handlers);
  assert.deepEqual(s.calls, [['dispatch', 'fix', 'the', 'login', 'bug', '--ignite']]);
});

test('run with a job keeps an --ignite the caller already passed, once', (t) => {
  const root = tempProject(t, ['navigator']);
  const s = stubs(root);
  memberRunVerb(['ship it', '--ignite'], s.handlers);
  assert.deepEqual(s.calls, [['dispatch', 'ship it', '--ignite']]);
});

test('run with a member name keeps the old member run path', (t) => {
  const root = tempProject(t, ['navigator', 'executor']);
  const s = stubs(root);
  assert.equal(memberRunVerb(['executor', 'improve onboarding proof', '--minutes', '30'], s.handlers), 'ran');
  assert.deepEqual(s.calls, [['run', 'executor', 'improve onboarding proof', '--minutes', '30']]);
});

test('run with no words or only flags keeps the old path (usage or mission flags)', (t) => {
  const root = tempProject(t, ['navigator']);
  const s = stubs(root);
  memberRunVerb([], s.handlers);
  memberRunVerb(['--help'], s.handlers);
  assert.deepEqual(s.calls, [['run', undefined], ['run', '--help']]);
});

test('run with a job and --dry-run goes through real dispatch and only previews', async (t) => {
  const root = tempProject(t, ['navigator', 'executor']);
  const { memberCommand } = require('../commands/member');
  const cwd = process.cwd();
  const log = console.log;
  const out = [];
  console.log = (...parts) => out.push(parts.join(' '));
  process.chdir(root);
  let payload;
  try {
    payload = await memberCommand('run', 'fix the flaky login test', '--dry-run');
  } finally {
    process.chdir(cwd);
    console.log = log;
  }
  assert.equal(payload.action, 'member_dispatch');
  assert.equal(payload.dry_run, true);
  assert.equal(payload.idea, 'fix the flaky login test');
  assert.match(payload.command, /^atris member run (navigator|executor) "fix the flaky login test" --ignite$/);
});

test('wake 5 starts member up with --max 5', async (t) => {
  const s = stubs(tempProject(t));
  assert.equal(await memberWakeVerb(['5'], s.handlers), 'up');
  assert.deepEqual(s.calls, [['up', '--max', '5']]);
});

test('wake 5 passes its flags through to member up', async (t) => {
  const s = stubs(tempProject(t));
  await memberWakeVerb(['5', '--dry-run'], s.handlers);
  assert.deepEqual(s.calls, [['up', '--max', '5', '--dry-run']]);
});

test('wake a b starts member up limited to a and b', async (t) => {
  const s = stubs(tempProject(t));
  await memberWakeVerb(['navigator', 'executor'], s.handlers);
  assert.deepEqual(s.calls, [['up', '--only', 'navigator,executor']]);
  assert.deepEqual(s.lines, []);
});

test('wake a (one name) keeps the old wake and prints the keep hint', async (t) => {
  const s = stubs(tempProject(t));
  const result = await memberWakeVerb(['navigator', '--plan'], s.handlers);
  assert.deepEqual(result, { ok: true, decision: 'tick' });
  assert.deepEqual(s.calls, [['wake', 'navigator', '--plan']]);
  assert.deepEqual(s.lines, ['to keep navigator working: atris member wake navigator --keep']);
});

test('wake a --json keeps the old wake and prints no hint into the json', async (t) => {
  const s = stubs(tempProject(t));
  await memberWakeVerb(['navigator', '--json'], s.handlers);
  assert.deepEqual(s.calls, [['wake', 'navigator', '--json']]);
  assert.deepEqual(s.lines, []);
});

test('wake a --keep starts member up for a only', async (t) => {
  const s = stubs(tempProject(t));
  await memberWakeVerb(['navigator', '--keep'], s.handlers);
  assert.deepEqual(s.calls, [['up', '--only', 'navigator']]);
});

test('wake with no arguments prints the three forms and starts nothing', async (t) => {
  const s = stubs(tempProject(t));
  const result = await memberWakeVerb([], s.handlers);
  assert.equal(result.usage, true);
  assert.deepEqual(s.calls, []);
  assert.equal(s.lines.length, 4);
  assert.match(s.lines.join('\n'), /atris member wake 5/);
  assert.match(s.lines.join('\n'), /atris member wake navigator executor/);
  assert.match(s.lines.join('\n'), /--keep/);
});

test('member wake with no arguments through the real command prints usage only', async (t) => {
  const root = tempProject(t, ['navigator']);
  const { memberCommand } = require('../commands/member');
  const cwd = process.cwd();
  const log = console.log;
  const out = [];
  console.log = (...parts) => out.push(parts.join(' '));
  process.chdir(root);
  try {
    const result = await memberCommand('wake');
    assert.equal(result.usage, true);
  } finally {
    process.chdir(cwd);
    console.log = log;
  }
  assert.equal(out[0], 'wake members three ways:');
  assert.equal(fs.existsSync(path.join(root, '.atris')), false, 'nothing was started or written');
});

test('member up only option never starts other members, and skips unknown names once', () => {
  let clock = Date.UTC(2026, 9, 14, 12, 0, 0);
  const lines = [];
  const spawned = [];
  const members = ['a', 'b', 'c'].map((name) => ({ name }));
  const deps = {
    listMembers: () => members,
    pickTask: (name) => ({ id: `t-${name}`, title: `task for ${name}`, metadata: { verify: 'node --test test/x.test.js' } }),
    spawn: (name) => { spawned.push(name); },
    now: () => clock,
    print: (line) => lines.push(line),
  };
  const up = createMemberUp(deps, { only: ['a', 'zed'] });
  up.check();
  clock += 60 * 1000;
  up.check();
  assert.deepEqual(spawned, ['a']);
  assert.deepEqual(up.only, ['a', 'zed']);
  assert.equal(lines.filter((line) => line === 'zed is not on the team, skipping').length, 1);
});

test('member up only option ignores members working elsewhere when counting the limit', () => {
  const spawned = [];
  const deps = {
    listMembers: () => [{ name: 'busy', live: true }, { name: 'a' }],
    pickTask: (name) => ({ id: `t-${name}`, title: name, metadata: { verify: 'node --test test/x.test.js' } }),
    spawn: (name) => { spawned.push(name); },
    now: () => 0,
    print: () => {},
  };
  createMemberUp(deps, { only: ['a'], max: 1 }).check();
  assert.deepEqual(spawned, ['a']);
});

test('member up reads --max, --only and --dry-run', () => {
  assert.deepEqual(parseMemberUpArgs(['--max', '5']), { max: 5, only: null, dryRun: false });
  assert.deepEqual(parseMemberUpArgs(['--only', 'a,b', '--dry-run']), { max: undefined, only: ['a', 'b'], dryRun: true });
  assert.deepEqual(parseMemberUpArgs(['--only=a']), { max: undefined, only: ['a'], dryRun: false });
  assert.ok(parseMemberUpArgs(['--max', '0']).error);
  assert.ok(parseMemberUpArgs(['--only', '']).error);
});
