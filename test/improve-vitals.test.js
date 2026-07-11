'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pulse = require('../lib/pulse');
const usage = require('../lib/usage');
const close = require('../commands/close');
const {
  collectImproveVitals,
  formatImproveVitals,
  run,
  IMPROVE_VITALS_SCHEMA,
} = require('../commands/improve');
const { knownCommands } = require('../lib/known-commands');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-improve-vitals-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

async function captureConsole(fn) {
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const code = await fn();
    return { code, stdout: lines.join('\n') };
  } finally {
    console.log = originalLog;
  }
}

function writeVitalsFixtures(dir) {
  writeJsonl(pulse.pulseReceiptsPath(dir), [
    { schema: pulse.PULSE_RECEIPT_SCHEMA, phase: 'finished', ts: '2026-07-07T10:00:00.000Z', reward: 9 },
    { schema: pulse.PULSE_RECEIPT_SCHEMA, phase: 'started', ts: '2026-07-08T11:40:00.000Z', reward: 0 },
    { schema: pulse.PULSE_RECEIPT_SCHEMA, phase: 'finished', ts: '2026-07-08T11:48:00.000Z', reward: 2 },
  ]);

  writeJson(path.join(dir, '.atris', 'state', 'experiments-daily.json'), {
    last_run_date: '2026-07-08',
    history: [{ reward: 1 }, { reward: 2 }],
  });

  writeJsonl(path.join(dir, '.atris', 'state', 'missions.jsonl'), [
    { schema: 'atris.mission.v1', owner: 'scout', updated_at: '2026-07-08T10:00:00.000Z', finding_landed: true },
    { schema: 'atris.mission.v1', owner: 'mission-lead', updated_at: '2026-07-08T11:00:00.000Z' },
  ]);

  writeJsonl(close.ledgerPath(dir), [
    {
      kind: 'opened',
      at: '2026-07-06T00:00:00.000Z',
      id: 'close-approve-payroll-abc1234',
      what: 'Approve payroll',
      owner: 'you',
      lane: 'ops',
      opened_at: '2026-07-06T00:00:00.000Z',
      ttl_days: 1,
      close_condition: 'payroll is approved',
      source: 'test',
    },
  ]);

  writeJsonl(usage.usagePath(dir), [
    { at: '2026-07-08T10:00:00.000Z', cmd: 'improve' },
    { at: '2026-07-07T10:00:00.000Z', cmd: 'pulse' },
    { at: '2026-07-07T10:00:00.000Z', cmd: 'not-a-command' },
    { at: '2026-06-20T10:00:00.000Z', cmd: 'close' },
  ]);
}

test('collectImproveVitals reads metabolism fixtures and renders plain lowercase sentences', () => {
  const dir = makeTempDir();
  try {
    writeVitalsFixtures(dir);
    const vitals = collectImproveVitals(
      { workspace: dir, now: '2026-07-08T12:00:00.000Z' },
      { cronInstalled: () => false }
    );

    assert.equal(vitals.schema, IMPROVE_VITALS_SCHEMA);
    assert.deepEqual(Object.keys(vitals), [
      'schema',
      'generated_at',
      'heartbeat',
      'exploit',
      'explore',
      'excrete',
      'usage',
      'install_nudge',
      'sentences',
      'groups',
    ]);
    assert.equal(vitals.heartbeat.last_finished_ago, '12 minutes ago');
    assert.equal(vitals.heartbeat.reward_last_24h, 2);
    assert.equal(vitals.heartbeat.cron_installed, false);
    assert.equal(vitals.exploit.ran_today, true);
    assert.equal(vitals.exploit.total_experiments, 2);
    assert.equal(vitals.explore.finding_landed, true);
    assert.equal(vitals.explore.last_tick_ago, '2 hours ago');
    assert.equal(vitals.excrete.open, 1);
    assert.equal(vitals.excrete.overdue, 1);
    assert.equal(vitals.usage.used_this_week, 2);
    assert.equal(vitals.usage.known_commands, knownCommands.length);
    assert.equal(vitals.install_nudge, 'the scheduled improve loop is off. turn it on: atris pulse install --model claude-sonnet-5');

    const output = formatImproveVitals(vitals);
    assert.match(output, /the scheduled improve heartbeat last beat 12 minutes ago and earned 2 reward today\./);
    assert.match(output, /the scheduled improve loop is off\. turn it on: atris pulse install --model claude-sonnet-5/);
    assert.match(output, /todays experiment already ran, with 2 total experiments\./);
    assert.match(output, /the scout last explored 2 hours ago and landed a finding\./);
    assert.match(output, /the excretion loop has 1 open loop and 1 overdue loop\./);
    assert.match(output, /the top overdue loop says approve payroll is waiting on you, 1 day late, close it when payroll is approved\./);
    assert.match(output, new RegExp(`you used 2 of ${knownCommands.length} known commands this week\\.`));
    assert.match(output, /\n\n/);
    assert.equal(output, output.toLowerCase());
    assert.doesNotMatch(output, /—/);

    const coreSentences = vitals.sentences.join('\n');
    assert.doesNotMatch(coreSentences, /[0-9A-HJKMNP-TV-Z]{26}/);
    assert.doesNotMatch(coreSentences, /--/);
    assert.doesNotMatch(coreSentences, /close-/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('run --json returns vitals json for the bare front door', async () => {
  const vitals = {
    schema: IMPROVE_VITALS_SCHEMA,
    generated_at: '2026-07-08T12:00:00.000Z',
    heartbeat: { sentence: 'the heartbeat has not beaten yet and earned 0 reward today.' },
    exploit: { sentence: 'no experiment yet today, with 0 total experiments.' },
    explore: { sentence: 'the scout has not explored yet and no finding landed.' },
    excrete: { sentence: 'the excretion loop has 0 open loops and 0 overdue loops.' },
    usage: { sentence: 'you used 0 of 1 known commands this week.' },
    install_nudge: null,
    sentences: [],
    groups: [],
  };
  const result = await captureConsole(() => run(['--json'], {
    collectImproveVitals: () => vitals,
  }));
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), vitals);
});

test('run routes tick subcommand and flagged legacy invocations to the old tick path', async () => {
  const seen = [];
  const fakeRunImprove = async (opts) => {
    seen.push(opts);
    return { ok: true, source: 'api', summary: { shipped: 'legacy tick', reward: 1, verify: true }, receipt: 'skipped' };
  };

  const tick = await captureConsole(() => run(['tick', '--json'], {
    runImprove: fakeRunImprove,
    collectImproveVitals: () => { throw new Error('vitals should not run for tick'); },
  }));
  assert.equal(tick.code, 0);
  assert.equal(JSON.parse(tick.stdout).source, 'api');
  assert.equal(seen[0].json, true);

  const flagged = await captureConsole(() => run(['--focus', 'front-door', '--json'], {
    runImprove: fakeRunImprove,
    collectImproveVitals: () => { throw new Error('vitals should not run for flagged tick'); },
  }));
  assert.equal(flagged.code, 0);
  assert.equal(JSON.parse(flagged.stdout).source, 'api');
  assert.equal(seen[1].json, true);
});
