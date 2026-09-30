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

// An hourly autoland tick receipt, stamped at a fixed time so ages are exact.
function writeAutolandTick(dir, at) {
  const runsDir = path.join(dir, 'atris', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const file = path.join(runsDir, `autoland-tick-${at.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ at, landed: [] })}\n`, 'utf8');
  const when = new Date(at);
  fs.utimesSync(file, when, when);
}

function writeVitalsFixtures(dir) {
  // Retired cron pulse receipts linger on disk; the vitals must not read them.
  writeJsonl(pulse.pulseReceiptsPath(dir), [
    { schema: pulse.PULSE_RECEIPT_SCHEMA, phase: 'finished', ts: '2026-07-08T11:48:00.000Z', reward: 2 },
  ]);
  writeAutolandTick(dir, '2026-07-08T11:14:00.000Z');

  writeJson(path.join(dir, '.atris', 'state', 'experiments-daily.json'), {
    last_run_date: '2026-07-08',
    history: [{ reward: 1 }, { reward: 2 }],
  });

  writeJsonl(path.join(dir, '.atris', 'state', 'missions.jsonl'), [
    // A leftover scout mission row: its writer is retired, so no line shows it.
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
      'excrete',
      'usage',
      'guarantee',
      'install_nudge',
      'sentences',
      'groups',
    ]);
    assert.equal(vitals.heartbeat.source, 'autoland');
    assert.equal(vitals.heartbeat.last_ran_ago, '46 minutes ago');
    assert.equal(vitals.heartbeat.live, true);
    assert.equal(vitals.install_nudge, null);
    assert.equal(vitals.exploit.ran_today, true);
    assert.equal(vitals.exploit.total_experiments, 2);
    assert.equal(vitals.excrete.open, 1);
    assert.equal(vitals.excrete.overdue, 1);
    assert.equal(vitals.usage.used_this_week, 2);
    assert.equal(vitals.usage.known_commands, knownCommands.length);
    // The fixture dir has no git history, so the guarantee gauge stays silent.
    assert.equal(vitals.guarantee, null);
    assert.ok(!vitals.sentences.some((s) => /fortnight/.test(s)));

    const output = formatImproveVitals(vitals);
    assert.match(output, /the hourly heartbeat that lands finished work last ran 46 minutes ago\./);
    assert.match(output, /todays experiment already ran, with 2 total experiments\./);
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
    heartbeat: { sentence: 'the hourly heartbeat that lands finished work has not run here yet.' },
    exploit: { sentence: 'no experiment yet today, with 0 total experiments.' },
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

// The cron pulse loops were retired on 2026-07-20 and the scout missions
// stopped being written when the scout cadence was switched off. No vitals
// line may send anyone to a retired mechanism or show a date only a retired
// writer could move.
test('no vitals line recommends pulse install or reports the retired scout', () => {
  const cases = [
    { name: 'no tick yet', tick: null, nudge: 'turn it on: atris autoland on', heartbeat: /has not run here yet/ },
    { name: 'quiet tick', tick: '2026-07-05T10:00:00.000Z', nudge: 'it has gone quiet. turn it back on: atris autoland on', heartbeat: /last ran 3 days ago\./ },
    { name: 'live tick', tick: '2026-07-08T11:14:00.000Z', nudge: null, heartbeat: /last ran 46 minutes ago\./ },
  ];
  for (const c of cases) {
    const dir = makeTempDir();
    try {
      writeVitalsFixtures(dir);
      fs.rmSync(path.join(dir, 'atris', 'runs'), { recursive: true, force: true });
      if (c.tick) writeAutolandTick(dir, c.tick);
      // Even with a retired pulse schedule reported missing, nothing nudges pulse.
      const vitals = collectImproveVitals(
        { workspace: dir, now: '2026-07-08T12:00:00.000Z' },
        { cronInstalled: () => false }
      );
      assert.equal(vitals.install_nudge, c.nudge, c.name);
      const lines = formatImproveVitals(vitals).split('\n');
      assert.match(vitals.heartbeat.sentence, c.heartbeat, c.name);
      for (const line of lines) {
        assert.doesNotMatch(line, /pulse install/, `${c.name}: ${line}`);
        assert.doesNotMatch(line, /\bpulse\b/, `${c.name}: ${line}`);
        assert.doesNotMatch(line, /scout/, `${c.name}: ${line}`);
      }
      assert.equal(vitals.explore, undefined);
    } finally {
      cleanupTempDir(dir);
    }
  }
});

test('a linked worktree reads the heartbeat from its main checkout', () => {
  const { execSync } = require('node:child_process');
  const dir = makeTempDir();
  const main = path.join(dir, 'main');
  const linked = path.join(dir, 'linked');
  try {
    fs.mkdirSync(main);
    execSync('git init -q && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m seed', { cwd: main, stdio: 'pipe' });
    execSync(`git worktree add -q "${linked}"`, { cwd: main, stdio: 'pipe' });
    writeAutolandTick(main, '2026-07-08T11:14:00.000Z');
    const vitals = collectImproveVitals({ workspace: linked, now: '2026-07-08T12:00:00.000Z' }, {});
    assert.equal(vitals.heartbeat.last_ran_ago, '46 minutes ago');
    assert.equal(vitals.install_nudge, null);
  } finally {
    cleanupTempDir(dir);
  }
});
