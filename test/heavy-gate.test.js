'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { listSlots, tryTakeSlot, waitForTurn, releaseSlot, runHeavy, HELD_ENV } = require('../lib/heavy-gate');

function settingsIn(dir, overrides = {}) {
  return { dir, slots: 2, pollMs: 1, maxMemoryWaitMs: 50, maxWaitMs: 100, ...overrides };
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heavy-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const roomy = { readMachineResources: () => ({ free_pct: 60 }), log: () => {} };

test('a third job finds no free turn while two are held', (t) => {
  const s = settingsIn(tempDir(t));
  const me = { pid: process.pid };
  assert.ok(tryTakeSlot(s, me));
  assert.ok(tryTakeSlot(s, me));
  assert.strictEqual(tryTakeSlot(s, me), null);
  assert.strictEqual(listSlots(s).length, 2);
});

test('a turn held by a dead job is freed for the next one', (t) => {
  const s = settingsIn(tempDir(t), { slots: 1 });
  fs.mkdirSync(s.dir, { recursive: true });
  fs.writeFileSync(path.join(s.dir, 'slot-0.lock'), JSON.stringify({ pid: 999999 }));
  assert.ok(tryTakeSlot(s, { pid: process.pid }));
});

test('a waiting job takes the turn once it is released', async (t) => {
  const s = settingsIn(tempDir(t), { slots: 1, maxWaitMs: 10_000 });
  const first = tryTakeSlot(s, { pid: process.pid });
  let polls = 0;
  const turn = await waitForTurn({ pid: process.pid }, s, {
    ...roomy,
    sleep: async () => { polls += 1; if (polls === 3) releaseSlot(first); },
  });
  assert.ok(turn.file);
  assert.strictEqual(polls, 3);
});

test('low memory makes a job wait, then it runs once the memory wait is over', async (t) => {
  const s = settingsIn(tempDir(t), { maxMemoryWaitMs: 5, maxWaitMs: 10_000 });
  let clock = 0;
  const lines = [];
  const turn = await waitForTurn({ pid: process.pid }, s, {
    readMachineResources: () => ({ free_pct: 5 }),
    now: () => clock,
    sleep: async () => { clock += 2; },
    log: (l) => lines.push(l),
  });
  assert.ok(turn.file);
  assert.ok(turn.waitedMs >= 5);
  assert.deepStrictEqual(lines, ['heavy job waiting: memory is low']);
});

test('high swap alone never holds a job back', async (t) => {
  const s = settingsIn(tempDir(t));
  const turn = await waitForTurn({ pid: process.pid }, s, {
    ...roomy,
    readMachineResources: () => ({ free_pct: 46, swap_used_mb: 9300, swap_total_mb: 10240 }),
    sleep: async () => { throw new Error('should not wait'); },
  });
  assert.ok(turn.file);
});

test('no job waits forever', async (t) => {
  const s = settingsIn(tempDir(t), { slots: 1 });
  tryTakeSlot(s, { pid: process.pid });
  let clock = 0;
  const turn = await waitForTurn({ pid: process.pid }, s, { ...roomy, now: () => clock, sleep: async () => { clock += 40; } });
  assert.strictEqual(turn.file, null);
  assert.match(turn.reason, /running anyway/);
});

test('a heavy job started inside another runs at once and keeps the exit code', async (t) => {
  const dir = tempDir(t);
  const code = await runHeavy(['sh', '-c', `test "$${HELD_ENV}" = 1 && exit 7`], {
    env: { ...process.env, [HELD_ENV]: '1', ATRIS_HEAVY_DIR: dir, ATRIS_HEAVY_SLOTS: '1' },
    log: () => {},
    spawn,
  });
  assert.strictEqual(code, 7);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('the turn is given back after the job ends', async (t) => {
  const dir = tempDir(t);
  const code = await runHeavy(['sh', '-c', 'exit 0'], {
    env: { ...process.env, [HELD_ENV]: '', ATRIS_HEAVY_DIR: dir },
    ...roomy,
  });
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});


test('releasing a slot never removes a lock another job now holds', (t) => {
  const s = settingsIn(tempDir(t), { slots: 1 });
  const mine = tryTakeSlot(s, { pid: process.pid });
  fs.writeFileSync(mine.file, JSON.stringify({ pid: process.pid, token: 'someone-else' }));
  releaseSlot(mine);
  assert.ok(fs.existsSync(mine.file));
});

test('a lock left half written is never mistaken for a free slot', (t) => {
  const s = settingsIn(tempDir(t), { slots: 1 });
  tryTakeSlot(s, { pid: process.pid });
  const raw = fs.readFileSync(path.join(s.dir, 'slot-0.lock'), 'utf8');
  assert.ok(JSON.parse(raw).token);
  assert.strictEqual(tryTakeSlot(s, { pid: process.pid }), null);
});

test('a very old lock frees its slot even if its process id came back to life', (t) => {
  const s = settingsIn(tempDir(t), { slots: 1, maxHoldMs: 1000 });
  fs.mkdirSync(s.dir, { recursive: true });
  fs.writeFileSync(path.join(s.dir, 'slot-0.lock'), JSON.stringify({ pid: process.pid, at: new Date(Date.now() - 5000).toISOString() }));
  assert.ok(tryTakeSlot(s, { pid: process.pid }));
});
