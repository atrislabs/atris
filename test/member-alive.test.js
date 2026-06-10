'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runAliveTick } = require('../lib/member-alive');

test('alive dry-run plans without execute', () => {
  const tick = runAliveTick('__missing_member__', { execute: false, confirmed: false });
  assert.equal(tick.mode, 'dry_run');
  assert.equal(tick.operate.skipped, true);
  assert.equal(tick.auto_accept.skipped, true);
});

// Writes a fake `atris` CLI that returns a fixed `member wake` decision so we can assert how an
// execute tick reacts to the member's own judgment without spinning up real member state.
function writeFakeAtris(dir, wakeDecision) {
  const binPath = path.join(dir, 'fake-atris.js');
  const wakeJson = JSON.stringify(wakeDecision);
  fs.writeFileSync(binPath, [
    'const argv = process.argv.slice(2);',
    'const sub = `${argv[0]} ${argv[1]}`;',
    `if (sub === 'member wake') { process.stdout.write(${JSON.stringify(wakeJson)}); }`,
    "else { process.stdout.write(JSON.stringify({ ok: true, summary: { would_accept: 0 } })); }",
    'process.exit(0);',
  ].join('\n'), 'utf8');
  return binPath;
}

test('alive execute honors a wait decision and skips operate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-wait-'));
  try {
    const atrisBin = writeFakeAtris(dir, {
      decision: 'wait',
      reason: 'open_experiment_proposed',
      needs_user: false,
      next_command: 'atris member review demo exp-1 --accept --proof "..." --value 4',
      checks: { has_mission: true, has_goal: true },
    });
    const tick = runAliveTick('demo', { execute: true, confirmed: true, noPrime: true, atrisBin, cwd: dir });
    // The member said "wait" — we must NOT force a failing operate tick.
    assert.equal(tick.operate.skipped, true);
    assert.equal(tick.operate.reason, 'wake_wait');
    assert.equal(tick.status, 'waiting');
    assert.equal(tick.reason, 'open_experiment_proposed');
    assert.equal(tick.blocked_on_human, true);
    assert.match(tick.next_command, /member review/);
    assert.equal(tick.ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('alive execute treats stop (no goal) as non-blocking idle, not failure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-stop-'));
  try {
    const atrisBin = writeFakeAtris(dir, {
      decision: 'stop',
      reason: 'no_active_goal',
      needs_user: false,
      next_command: 'atris member goal-from-mission demo',
      checks: { has_mission: true, has_goal: false },
    });
    const tick = runAliveTick('demo', { execute: true, confirmed: true, noPrime: true, atrisBin, cwd: dir });
    assert.equal(tick.operate.skipped, true);
    assert.equal(tick.status, 'waiting');
    assert.equal(tick.blocked_on_human, false);
    assert.equal(tick.ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
