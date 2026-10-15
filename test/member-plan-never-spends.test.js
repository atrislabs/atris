'use strict';

// Asking for a plan never starts paid work. A single `member wake a --plan`
// already only plans; the keep-working forms (`--keep`, a count, several
// names) go through `member up`, which used to drop --plan and start the
// live team loop.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { createMemberUp, parseMemberUpArgs } = require('../lib/member-up');

const BIN = path.join(__dirname, '..', 'bin', 'atris.js');

function emptyWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-plan-never-spends-'));
  fs.mkdirSync(path.join(root, 'atris', 'team'), { recursive: true });
  return root;
}

test('--plan reads as a preview for the team loop', () => {
  assert.equal(parseMemberUpArgs(['--only', 'a', '--plan']).dryRun, true);
  assert.equal(parseMemberUpArgs(['--max', '3', '--plan']).dryRun, true);
  assert.equal(parseMemberUpArgs(['--only', 'a']).dryRun, false);
});

test('a plan ask never starts a member that has ready work', () => {
  const spawned = [];
  const written = [];
  const deps = {
    listMembers: () => [{ name: 'builder' }],
    pickTask: () => ({ id: 'T-1', title: 'ready work', metadata: { verify: 'node --test test/x.test.js' } }),
    writeNextJob: (name, opts) => { written.push(opts); return { skip: 'no mission' }; },
    spawn: (name) => { spawned.push(name); },
    now: () => Date.UTC(2026, 9, 14, 12),
    print: () => {},
  };
  const { only, max, dryRun } = parseMemberUpArgs(['--only', 'builder', '--plan']);
  const started = createMemberUp(deps, { only, max, dryRun }).check();
  assert.deepEqual(spawned, []);
  assert.ok(written.every((opts) => opts.dryRun === true));
  assert.equal(started.length, 1, 'the plan still names who would start');
});

for (const words of [['generalist', '--keep'], ['3'], ['navigator', 'executor']]) {
  test(`atris member wake ${words.join(' ')} --plan returns without starting the team`, () => {
    const root = emptyWorkspace();
    try {
      const run = spawnSync(process.execPath, [BIN, 'member', 'wake', ...words, '--plan'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 20000,
        env: { ...process.env, ATRIS_NO_UPDATE_CHECK: '1' },
      });
      assert.equal(run.error, undefined, `wake hung instead of planning: ${run.error && run.error.message}`);
      assert.equal(run.status, 0, run.stderr);
      assert.doesNotMatch(run.stdout, /team is up/);
      assert.equal(fs.existsSync(path.join(root, '.atris', 'state', 'member-up.json')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
