'use strict';

// Waking members by name opens a window for just those members. Other members
// keep working and writing progress at the same time; none of their lines may
// show up in this window, or it looks like two members took the same job.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { memberWakeVerb } = require('../lib/member-verbs');
const { runMemberUp, parseMemberUpArgs } = require('../lib/member-up');

const withCheck = (task) => ({ ...task, metadata: { verify: 'node --test test/x.test.js' } });

// One window: `atris member wake <args>` routed the real way, with a fake
// team and a real progress folder that every member writes into.
async function openWindow(t, wakeArgs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wake-own-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = Date.now();
  const lines = [];
  const exits = new Map();
  const tasks = { a: [{ id: 't1', title: 'fix the board' }], b: [{ id: 't2', title: 'tidy the readme' }], c: [{ id: 't3', title: 'fix the board' }] };
  const deps = {
    // c is already working, started from another window.
    listMembers: () => [{ name: 'a' }, { name: 'b' }, { name: 'c', live: true }],
    pickTask: (name) => (tasks[name] ? withCheck(tasks[name][0]) : null),
    spawn: (name, onExit, onClaim) => { exits.set(name, onExit); onClaim(tasks[name][0]); },
    now: () => now,
    print: (line) => lines.push(line),
    sleep: () => new Promise(() => {}),
  };
  let loop;
  await memberWakeVerb(wakeArgs, {
    print: (line) => lines.push(line),
    wake: () => { throw new Error('a kept wake must run the supervisor'); },
    up: (...args) => {
      const parsed = parseMemberUpArgs(args);
      loop = runMemberUp(deps, { ...parsed, progressDir: dir, progressPollMs: 5 });
    },
  });
  t.after(() => loop.stop());
  const at = new Date(now + 1000).toISOString();
  const write = (member, text) => fs.appendFileSync(path.join(dir, `${member}.log`), `${at} m-${member} ${text}\n`);
  return { lines, write, exits, loop };
}

const aboutMember = (line) => line.trim().split(/\s+/)[0];

test('waking one member by name shows only that member, while others work', async (t) => {
  const win = await openWindow(t, ['a', '--keep']);
  win.write('a', 'editing lib/member-board.js');
  win.write('b', 'editing README.md');
  win.write('c', 'editing lib/member-board.js');
  win.write('c', 'finished: ok');
  win.loop.scanProgress();
  win.exits.get('a')(0, { ok: true, summary: 'board fixed' });

  assert.deepEqual([...win.exits.keys()], ['a'], 'only the named member is started');
  assert.ok(win.lines.length >= 3, `expected a's own lines, got ${JSON.stringify(win.lines)}`);
  assert.ok(win.lines.some((line) => /^ {2}a \d\d:\d\d {2}editing lib\/member-board\.js$/.test(line)));
  assert.ok(win.lines.includes('a done ok: board fixed'));
  for (const line of win.lines) {
    assert.equal(aboutMember(line), 'a', `a's window printed a line about someone else: ${line}`);
  }
});

test('waking two members by name shows both of them and nobody else', async (t) => {
  const win = await openWindow(t, ['a', 'b']);
  win.write('a', 'editing lib/member-board.js');
  win.write('b', 'editing README.md');
  win.write('c', 'editing lib/member-board.js');
  win.loop.scanProgress();

  assert.deepEqual([...win.exits.keys()].sort(), ['a', 'b']);
  const who = new Set(win.lines.map(aboutMember));
  assert.deepEqual([...who].sort(), ['a', 'b'], JSON.stringify(win.lines));
});
