'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { whoCommand } = require('../commands/who');
const {
  buildWorkforcePresence,
  parsePsOutput,
  renderWorkforcePresence,
} = require('../lib/workforce-presence');

const NOW = Date.parse('2026-08-16T00:45:00.000Z');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-workforce-presence-'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function fixtureProcesses() {
  return [
    { pid: 101, engine: 'codex', command: '/usr/local/bin/codex exec', started_at: '2026-08-16T00:37:28.000Z' },
    { pid: 303, engine: 'cursor', command: '/usr/local/bin/cursor-agent youtube', started_at: '2026-08-16T00:40:00.000Z' },
    { pid: 404, engine: 'agy', command: '/usr/local/bin/agy work', started_at: '2026-08-16T00:41:00.000Z' },
  ];
}

function fixtureTasks() {
  return [
    {
      id: 'task-current',
      display_id: 'CLI-1265',
      title: 'build local workforce presence',
      status: 'claimed',
      claimed_by: 'runtime-engineer',
      updated_at: '2026-08-16T00:37:28.000Z',
    },
    {
      id: 'task-waiting',
      display_id: 'CLI-1300',
      title: 'wait for a free engine',
      status: 'claimed',
      claimed_by: 'task-planner',
      updated_at: '2026-08-16T00:43:00.000Z',
    },
    {
      id: 'task-stale',
      display_id: 'CLI-1200',
      title: 'old abandoned claim',
      status: 'claimed',
      claimed_by: 'old-builder',
      updated_at: '2026-08-01T00:00:00.000Z',
    },
  ];
}

function fixtureReceipts() {
  return [
    {
      name: 'dispatch-running.json',
      receipt: {
        schema: 'atris.dispatch_receipt.v1',
        status: 'running',
        pid: 101,
        engine: 'codex',
        actor: 'runtime-engineer',
        tasks: ['CLI-1265'],
        started_at: '2026-08-16T00:37:28.000Z',
      },
    },
    {
      name: 'dispatch-dead.json',
      receipt: {
        schema: 'atris.dispatch_receipt.v1',
        status: 'running',
        pid: 202,
        engine: 'grok',
        actor: 'researcher',
        tasks: ['CLI-1299'],
        started_at: '2026-08-16T00:30:00.000Z',
      },
    },
    {
      name: 'dispatch-done.json',
      receipt: {
        schema: 'atris.dispatch_receipt.v1',
        status: 'completed',
        pid: 909,
        engine: 'devin',
        actor: 'validator',
        tasks: ['CLI-1199'],
        started_at: '2026-08-15T23:30:00.000Z',
        finished_at: '2026-08-16T00:10:00.000Z',
        result: { kind: 'dispatch_landed', passed: true },
      },
    },
  ];
}

test('ps parsing recognizes the supported local engines and only headless claude', () => {
  const parsed = parsePsOutput([
    '101 1 Sat Aug 15 17:40:00 2026 /usr/local/bin/codex exec task',
    '102 1 Sat Aug 15 17:40:01 2026 /usr/local/bin/cursor-agent task',
    '103 1 Sat Aug 15 17:40:02 2026 /usr/local/bin/grok task',
    '104 1 Sat Aug 15 17:40:03 2026 /usr/local/bin/devin task',
    '105 1 Sat Aug 15 17:40:04 2026 /usr/local/bin/droid task',
    '106 1 Sat Aug 15 17:40:05 2026 /usr/local/bin/agy task',
    '107 1 Sat Aug 15 17:40:06 2026 /usr/local/bin/claude -p task',
    '108 1 Sat Aug 15 17:40:07 2026 /usr/local/bin/claude interactive',
    '109 1 Sat Aug 15 17:40:08 2026 /Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Codex (Renderer)',
    '110 1 Sat Aug 15 17:40:09 2026 node /opt/homebrew/bin/atris engine dispatch CLI-1265 --engine codex',
  ].join('\n'));

  assert.deepEqual(parsed.map((row) => row.engine), ['codex', 'cursor', 'grok', 'devin', 'droid', 'agy', 'claude']);
  assert.equal(parsed.some((row) => row.pid === 108), false);
  assert.equal(parsed.some((row) => row.pid === 109), false);
  assert.equal(parsed.some((row) => row.pid === 110), false);
});

test('a claimed task joins a process only when its command carries the task reference', () => {
  const presence = buildWorkforcePresence({
    nowMs: NOW,
    processes: [{
      pid: 501,
      engine: 'cursor',
      command: 'cursor-agent worktree cursor-cli-1301',
      started_at: '2026-08-16T00:40:00.000Z',
    }],
    tasks: [{
      id: 'task-ref-match',
      display_id: 'CLI-1301',
      title: 'repair claim release',
      status: 'claimed',
      claimed_by: 'runtime-engineer',
      updated_at: '2026-08-16T00:39:00.000Z',
    }],
  });

  assert.deepEqual(presence.working.map((row) => [row.member, row.engine, row.task, row.pid]), [
    ['runtime-engineer', 'cursor', 'CLI-1301', 501],
  ]);
  assert.equal(presence.unowned.length, 0);
});

test('a stale receipt cannot borrow an unrelated process from the same engine', () => {
  const presence = buildWorkforcePresence({
    nowMs: NOW,
    processes: [{
      pid: 998,
      engine: 'codex',
      command: 'codex exec other work',
      started_at: '2026-08-16T00:30:00.000Z',
    }],
    receipts: [{
      name: 'dead-codex.json',
      receipt: {
        status: 'running',
        pid: 998,
        engine: 'codex',
        actor: 'builder',
        started_at: '2026-08-10T00:40:00.000Z',
      },
    }],
  });

  assert.equal(presence.working.length, 0);
  assert.equal(presence.stale.length, 1);
  assert.deepEqual(presence.unowned.map((row) => row.pid), [998]);
});

test('presence joins processes, claims, receipts, and missions into honest states', () => {
  const presence = buildWorkforcePresence({
    nowMs: NOW,
    processes: fixtureProcesses(),
    tasks: fixtureTasks(),
    receipts: fixtureReceipts(),
    missions: [{
      id: 'youtube-mission',
      status: 'running',
      owner: 'video-producer',
      runner: 'cursor',
      objective: 'process the youtube lesson',
      updated_at: '2026-08-16T00:40:00.000Z',
    }],
  });

  assert.deepEqual(presence.totals, { working: 2, waiting: 1, done: 1, stale: 2, unowned: 1 });
  assert.deepEqual(presence.working.map((row) => [row.member, row.engine, row.task]), [
    ['video-producer', 'cursor', null],
    ['runtime-engineer', 'codex', 'CLI-1265'],
  ]);
  assert.equal(presence.waiting[0].member, 'task-planner');
  assert.equal(presence.done[0].result, 'dispatch_landed passed');
  assert.deepEqual(presence.stale.map((row) => row.member).sort(), ['old-builder', 'researcher']);
  assert.deepEqual(presence.unowned.map((row) => row.engine), ['agy']);

  const text = renderWorkforcePresence(presence);
  assert.match(text, /^working:/);
  assert.match(text, /video-producer: cursor on process the youtube lesson/);
  assert.match(text, /done:\n  validator: devin on CLI-1199/);
  assert.match(text, /unowned:\n  agy pid 404/);
  assert.match(text, /totals: 2 working, 1 waiting, 1 done, 2 stale, 1 unowned$/);
  assert.doesNotMatch(text, /\u2014/);
});

test('who reads fixture state with an injected process list and returns the JSON contract', () => {
  const root = tempRoot();
  const output = [];
  try {
    writeJson(path.join(root, '.atris', 'state', 'tasks.projection.json'), { tasks: fixtureTasks() });
    fs.writeFileSync(path.join(root, '.atris', 'state', 'missions.jsonl'), `${JSON.stringify({
      id: 'youtube-mission',
      status: 'running',
      owner: 'video-producer',
      runner: 'cursor',
      objective: 'process the youtube lesson',
      updated_at: '2026-08-16T00:40:00.000Z',
    })}\n`);
    for (const entry of fixtureReceipts()) {
      writeJson(path.join(root, 'atris', 'runs', entry.name), entry.receipt);
    }

    const code = whoCommand(['--json'], {
      root,
      now: () => NOW,
      processes: fixtureProcesses(),
      write: (text) => output.push(text),
    });
    assert.equal(code, 0);
    const payload = JSON.parse(output.join(''));
    assert.equal(payload.schema, 'atris.workforce_presence.v1');
    assert.deepEqual(payload.totals, { working: 2, waiting: 1, done: 1, stale: 2, unowned: 1 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('who --clear archives only finished workforce receipts', () => {
  const root = tempRoot();
  const output = [];
  try {
    for (const entry of fixtureReceipts()) {
      writeJson(path.join(root, 'atris', 'runs', entry.name), entry.receipt);
    }
    const code = whoCommand(['--clear'], { root, write: (text) => output.push(text) });
    assert.equal(code, 0);
    assert.equal(fs.existsSync(path.join(root, 'atris', 'runs', 'dispatch-done.json')), false);
    assert.equal(fs.existsSync(path.join(root, 'atris', 'runs', 'archive', 'dispatch-done.json')), true);
    assert.equal(fs.existsSync(path.join(root, 'atris', 'runs', 'dispatch-running.json')), true);
    assert.equal(fs.existsSync(path.join(root, 'atris', 'runs', 'dispatch-dead.json')), true);
    assert.equal(output.join(''), 'archived 1 finished run in atris/runs/archive.\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('top-level who help routes without reading processes or state', () => {
  const root = tempRoot();
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), 'who', '--help'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /usage: atris who \[--json\]/);
    assert.equal(fs.existsSync(path.join(root, '.atris')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
