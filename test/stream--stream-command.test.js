'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-stream-cmd-home-'));
const savedEnv = new Map();
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_') || key.startsWith('GIT_') || key === 'HOME') {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
}
process.env.HOME = home;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(home, 'gitconfig');
process.env.GIT_CONFIG_SYSTEM = path.join(home, 'gitconfig');
process.env.GIT_TERMINAL_PROMPT = '0';
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');

const { streamCommand } = require('../commands/stream');

const FIXED_NOW = '2026-07-06T12:00:00.000Z';

function capture(fn) {
  const logs = [];
  const log = console.log;
  console.log = (...args) => logs.push(args.map(String).join(' '));
  try {
    return { result: fn(), logs };
  } finally {
    console.log = log;
  }
}

function flat(logs) {
  return logs.flatMap((line) => String(line).split('\n')).filter((line) => line.length > 0);
}

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-stream-cmd-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Git walks parent directories looking for a repo. Stop that walk in this
  // temp folder so a parent checkout cannot leak into the command.
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(fs.realpathSync(root));
  return root;
}

function depsFor(root) {
  return {
    now: () => Date.parse(FIXED_NOW),
    listWorktrees: () => [],
    watch: () => ({ close() {} }),
    runGit(cwd, args) {
      if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) {
        return { status: 0, stdout: `${root}\n`, stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    },
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFixture(root) {
  writeJson(path.join(root, '.atris', 'state', 'tasks.projection.json'), {
    tasks: [
      {
        id: 'task-ship',
        title: 'ship the stream view',
        status: 'claimed',
        claimed_by: 'codex',
        updated_at: '2026-07-06T08:00:00.000Z',
        events: [],
      },
      {
        id: 'task-blocked',
        title: 'needs a human look',
        status: 'blocked',
        claimed_by: 'ada',
        updated_at: '2026-07-06T09:00:00.000Z',
        events: [],
      },
    ],
  });
  fs.writeFileSync(path.join(root, '.atris', 'state', 'missions.jsonl'), `${JSON.stringify({
    id: 'mission-plain',
    owner: 'mina',
    status: 'running',
    objective: 'watch the team',
    created_at: '2026-07-06T07:30:00.000Z',
    last_tick_at: '2026-07-06T10:00:00.000Z',
  })}\n`);
}

const SNAPSHOT = [
  'Team stream: 2 active agents.',
  'On now: codex: ship the stream view; mina: watch the team.',
  'Waiting on operator: 1 review.',
  'Watching missions, task events, scorecards, landings, and worktrees. Ctrl-C exits.',
];

test.after(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_') || key.startsWith('GIT_') || key === 'HOME') delete process.env[key];
  }
  for (const [key, value] of savedEnv) process.env[key] = value;
  fs.rmSync(home, { recursive: true, force: true });
});

test.describe('streamCommand', { concurrency: false }, () => {
  test('prints the team snapshot and the events since a fixed time', (t) => {
    const root = makeRoot(t);
    writeFixture(root);
    const seen = capture(() => streamCommand([
      '--once',
      '--since',
      '2026-07-01T00:00:00.000Z',
    ], depsFor(root)));
    assert.strictEqual(seen.result, 0);
    assert.deepStrictEqual(flat(seen.logs), [
      ...SNAPSHOT,
      '2026-07-06 08:00:00Z codex started ship the stream view.',
      '2026-07-06 09:00:00Z ada got blocked on needs a human look.',
      '2026-07-06 10:00:00Z mina is working on watch the team.',
    ]);
  });

  test('keeps the snapshot and limits the event lines to one agent', (t) => {
    const root = makeRoot(t);
    writeFixture(root);
    const seen = capture(() => streamCommand([
      '--once',
      '--agent',
      'ADA',
      '--since',
      '2026-07-01T00:00:00.000Z',
    ], depsFor(root)));
    assert.strictEqual(seen.result, 0);
    assert.deepStrictEqual(flat(seen.logs), [
      ...SNAPSHOT,
      '2026-07-06 09:00:00Z ada got blocked on needs a human look.',
    ]);
  });

  test('prints an empty json snapshot with the fixed clock', (t) => {
    const root = makeRoot(t);
    const seen = capture(() => streamCommand(['--once', '--json'], depsFor(root)));
    assert.strictEqual(seen.result, 0);
    const rows = flat(seen.logs).map((line) => JSON.parse(line));
    assert.strictEqual(rows.length, 4);
    assert.deepStrictEqual(rows.map((row) => row.summary), [
      'Team stream: 0 active agents.',
      'On now: no active work found on disk.',
      'Waiting on operator: nothing obvious.',
      'Watching missions, task events, scorecards, landings, and worktrees. Ctrl-C exits.',
    ]);
    for (const row of rows) {
      assert.strictEqual(row.ts, FIXED_NOW);
      assert.strictEqual(row.agent, 'team');
      assert.strictEqual(row.event, 'snapshot');
      assert.strictEqual(row.raw.snapshot.active_agents, 0);
      assert.strictEqual(row.raw.snapshot.waiting_operator, 0);
      assert.strictEqual(row.raw.snapshot.landing_wait, 0);
    }
  });

  test('rejects a since value that is not a time', (t) => {
    const root = makeRoot(t);
    const seen = capture(() => {
      assert.throws(
        () => streamCommand(['--once', '--since', 'yesterday'], depsFor(root)),
        { message: 'invalid --since value: yesterday' },
      );
    });
    assert.deepStrictEqual(seen.logs, []);
  });
});
