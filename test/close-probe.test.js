// Live-probe incidents on the closure ledger: a diagnosis is only recordable
// with a command that fails right now, re-checks decide whether the old theory
// is still live, and closing needs the probe to hold across a real gap.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const close = require('../commands/close');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-close-probe-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function capture(fn) {
  const stdout = [];
  const stderr = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => stdout.push(args.join(' '));
  console.error = (...args) => stderr.push(args.join(' '));
  try {
    const code = fn();
    return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function runClose(args, context) {
  return capture(() => close.run(args, context));
}

function readLedger(dir) {
  const file = close.ledgerPath(dir);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split(/\n/).filter(Boolean).map((line) => JSON.parse(line));
}

const stubProbe = (exitCode) => () => ({ pass: exitCode === 0, exit_code: exitCode });

const T0 = '2026-08-13T01:00:00.000Z';
const T0_PLUS_10M = '2026-08-13T01:10:00.000Z';
const T0_PLUS_20M = '2026-08-13T01:20:00.000Z';
const T0_PLUS_30M = '2026-08-13T01:30:00.000Z';
const T0_PLUS_2H = '2026-08-13T03:00:00.000Z';

test('add --probe refuses when the probe passes right now', () => {
  const dir = makeTempDir();
  try {
    const result = runClose(
      ['add', 'dashboard rejects valid session', '--probe', 'true'],
      { cwd: dir, now: T0, runProbe: stubProbe(0) }
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /probe passes right now/);
    assert.equal(readLedger(dir).length, 0);
  } finally {
    cleanupTempDir(dir);
  }
});

test('add --probe with a failing probe opens the incident and records the command', () => {
  const dir = makeTempDir();
  try {
    const result = runClose(
      ['add', 'dashboard rejects valid session', '--probe', 'exit 3'],
      { cwd: dir, now: T0, runProbe: stubProbe(3) }
    );
    assert.equal(result.code, 0);
    assert.match(result.stdout, /probe failing as required \(exit 3\)/);
    const events = readLedger(dir);
    assert.equal(events.length, 1);
    assert.equal(events[0].probe, 'exit 3');
  } finally {
    cleanupTempDir(dir);
  }
});

test('add --probe without a command is an error', () => {
  const dir = makeTempDir();
  try {
    const result = runClose(['add', 'something broke', '--probe'], { cwd: dir, now: T0 });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--probe needs a command/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('add --probe runs the real command when no stub is injected', () => {
  const dir = makeTempDir();
  try {
    const result = runClose(
      ['add', 'real shell probe', '--probe', 'exit 7'],
      { cwd: dir, now: T0 }
    );
    assert.equal(result.code, 0);
    assert.match(result.stdout, /exit 7/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('check reports a still-failing probe as a live theory and stops after repeated failures', () => {
  const dir = makeTempDir();
  try {
    runClose(['add', 'auth storm', '--probe', 'exit 1'], { cwd: dir, now: T0, runProbe: stubProbe(1) });

    const first = runClose(['check'], { cwd: dir, now: T0_PLUS_10M, runProbe: stubProbe(1) });
    assert.equal(first.code, 1);
    assert.match(first.stdout, /still failing \(exit 1\)/);
    assert.match(first.stdout, /theory is still live/);
    assert.doesNotMatch(first.stdout, /stop and tell the human/);

    const second = runClose(['check'], { cwd: dir, now: T0_PLUS_20M, runProbe: stubProbe(1) });
    assert.equal(second.code, 1);
    assert.match(second.stdout, /2 fix attempts have not moved the probe\. stop and tell the human\./);
  } finally {
    cleanupTempDir(dir);
  }
});

test('done is gated until the probe passes twice at least an hour apart', () => {
  const dir = makeTempDir();
  try {
    runClose(['add', 'auth storm', '--probe', 'exit 1'], { cwd: dir, now: T0, runProbe: stubProbe(1) });
    const id = readLedger(dir)[0].id;

    const whileFailing = runClose(['done', id], { cwd: dir, now: T0_PLUS_10M });
    assert.equal(whileFailing.code, 2);
    assert.match(whileFailing.stderr, /probe still fails/);

    runClose(['check'], { cwd: dir, now: T0_PLUS_10M, runProbe: stubProbe(0) });
    const afterOnePass = runClose(['done', id], { cwd: dir, now: T0_PLUS_20M });
    assert.equal(afterOnePass.code, 2);
    assert.match(afterOnePass.stderr, /passed once/);

    runClose(['check'], { cwd: dir, now: T0_PLUS_30M, runProbe: stubProbe(0) });
    const gapTooShort = runClose(['done', id], { cwd: dir, now: T0_PLUS_30M });
    assert.equal(gapTooShort.code, 2);
    assert.match(gapTooShort.stderr, /passed once/);

    const held = runClose(['check'], { cwd: dir, now: T0_PLUS_2H, runProbe: stubProbe(0) });
    assert.equal(held.code, 0);
    assert.match(held.stdout, /probe held/);

    const closed = runClose(['done', id], { cwd: dir, now: T0_PLUS_2H });
    assert.equal(closed.code, 0);
    const closedEvent = readLedger(dir).find((event) => event.kind === 'closed');
    assert.equal(closedEvent.proof, 'probe held: exit 1');
  } finally {
    cleanupTempDir(dir);
  }
});

test('a pass after failures resets the stop counter path back to holding logic', () => {
  const dir = makeTempDir();
  try {
    runClose(['add', 'flaky storm', '--probe', 'exit 1'], { cwd: dir, now: T0, runProbe: stubProbe(1) });
    runClose(['check'], { cwd: dir, now: T0_PLUS_10M, runProbe: stubProbe(1) });
    runClose(['check'], { cwd: dir, now: T0_PLUS_20M, runProbe: stubProbe(0) });
    const list = runClose(['list'], { cwd: dir, now: T0_PLUS_20M });
    assert.match(list.stdout, /probe passed once/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('flags without probes keep the old immediate close behavior', () => {
  const dir = makeTempDir();
  try {
    runClose(['add', 'plain loop'], { cwd: dir, now: T0 });
    const id = readLedger(dir)[0].id;
    const result = runClose(['done', id, '--proof', 'resolved'], { cwd: dir, now: T0_PLUS_10M });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /closed/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('check with an id errors when the flag has no probe', () => {
  const dir = makeTempDir();
  try {
    runClose(['add', 'plain loop'], { cwd: dir, now: T0 });
    const id = readLedger(dir)[0].id;
    const result = runClose(['check', id], { cwd: dir, now: T0_PLUS_10M });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /not an open incident with a probe/);
  } finally {
    cleanupTempDir(dir);
  }
});
