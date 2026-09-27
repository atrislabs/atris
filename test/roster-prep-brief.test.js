'use strict';

// A heavy roster worker can ask for a prep pass ("prep: search"): the search
// job's lead reads the task first and writes a trimmed brief, and the heavy
// worker works from that brief. Also covers the run record's own upkeep: the
// file is trimmed when it grows past its cap, and a hand-edited line with odd
// field types never crashes the view. Every room is a scratch project with a
// scratch home, fake engines sit on PATH, and the clock is injected, so the
// real ~/.atris is never read or written.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ENV_KEYS = [
  'ATRIS_MACHINE_ROSTER_PATH', 'ATRIS_MACHINE_ROSTER_MD_PATH', 'ATRIS_ROUTER_EXPLAIN', 'ATRIS_ROSTER_SESSION',
  'ATRIS_ROSTER_SESSIONS_DIR', 'ATRIS_CODEX_MODELS_CACHE_PATH', 'ATRIS_CODEX_CONFIG_PATH',
  'ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_MODEL', 'ATRIS_RUNNER_BIN', 'ATRIS_RUNNER_COMMAND_TEMPLATE',
  'ATRIS_CLAUDE_MODEL', 'ATRIS_CLAUDE_BIN', 'ATRIS_CLAUDE_COMMAND_TEMPLATE', 'ATRIS_ENGINE_COOLDOWN_MINUTES',
  'PATH',
];

const NOW = Date.parse('2026-09-27T12:00:00.000Z');

async function withRoom(fn, { roster = '' } = {}) {
  const { readEngineRegistry, setEngineHealth } = require('../lib/engine-registry');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-prep-brief-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-prep-brief-home-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-prep-brief-bin-'));
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-prep-brief-wt-'));
  spawnSync('git', ['init', '-q', root]);
  spawnSync('git', ['init', '-q', wt]);
  fs.mkdirSync(path.join(root, 'atris'));
  if (roster) fs.writeFileSync(path.join(root, 'atris', 'ROSTER.md'), roster);
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) if (key !== 'PATH') delete process.env[key];
  process.env.ATRIS_MACHINE_ROSTER_PATH = path.join(home, '.atris', 'roster.json');
  process.env.ATRIS_ROUTER_EXPLAIN = '0';
  process.env.PATH = `${bin}${path.delimiter}${saved.get('PATH') || ''}`;
  readEngineRegistry(root);
  for (const name of ['devin', 'grok', 'cursor', 'codex', 'claude', 'haiku']) setEngineHealth(name, 'ready', root);
  try {
    return await fn({ root, home, bin, wt });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of [root, home, bin, wt]) fs.rmSync(dir, { recursive: true, force: true });
  }
}

function command(root, args) {
  const { engineCommand } = require('../commands/engine');
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...parts) => logs.push(parts.join(' '));
  console.error = (...parts) => logs.push(parts.join(' '));
  try {
    const exit = engineCommand(args, { root, now: new Date(NOW + 3600000) });
    return { exit, out: logs.join('\n') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

// --- the run record's own upkeep ------------------------------------------

test('the run record is trimmed to its newest whole lines once it passes its size cap', async () => {
  await withRoom(async ({ root }) => {
    const runs = require('../lib/roster-runs');
    const file = runs.rosterRunsPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = (i) => JSON.stringify({ at: new Date(NOW).toISOString(), job: 'build', engine: 'cursor', outcome: 'landed', task: `CLI-${i}`, detail: 'x'.repeat(200) });
    const lines = [];
    let bytes = 0;
    for (let i = 0; bytes <= runs.RUNS_ROTATE_BYTES; i += 1) {
      const text = `${line(i)}\n`;
      lines.push(text);
      bytes += Buffer.byteLength(text);
    }
    fs.writeFileSync(file, lines.join(''));
    runs.appendRosterRun(root, { at: new Date(NOW).toISOString(), job: 'build', engine: 'devin', outcome: 'landed', task: 'CLI-LAST' });
    const after = fs.readFileSync(file, 'utf8');
    assert.ok(Buffer.byteLength(after) <= runs.RUNS_KEEP_BYTES, `kept ${Buffer.byteLength(after)} bytes`);
    const kept = after.split('\n').filter(Boolean);
    for (const row of kept) JSON.parse(row);
    assert.equal(JSON.parse(kept[kept.length - 1]).task, 'CLI-LAST');
    assert.ok(kept.length > 100);
    assert.equal(fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp')).length, 0);
  });
});

test('a record line with odd field types reads cleanly and never crashes the runs view', async () => {
  await withRoom(async ({ root }) => {
    const runs = require('../lib/roster-runs');
    const file = runs.rosterRunsPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const at = new Date(NOW).toISOString();
    fs.writeFileSync(file, [
      JSON.stringify({ at, job: 'build', engine: 'cursor', outcome: 'landed', cost_usd: '0.42', tokens: '1200', seconds: 'soon', max_seconds: {}, model: 7, detail: ['x'], task: '  CLI-1  ' }),
      JSON.stringify({ at, job: 5, engine: 'devin', outcome: 'failed', tokens: null, handed_over_to: { who: 'x' }, brief_bytes: 'big' }),
      '',
    ].join('\n'));
    const rows = runs.readRosterRuns(root, { now: NOW + 60000 });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].cost_usd, 0.42);
    assert.equal(rows[0].tokens, 1200);
    assert.equal('seconds' in rows[0], false);
    assert.equal('max_seconds' in rows[0], false);
    assert.equal('model' in rows[0], false);
    assert.equal('detail' in rows[0], false);
    assert.equal(rows[0].task, 'CLI-1');
    assert.equal('handed_over_to' in rows[1], false);
    assert.equal('brief_bytes' in rows[1], false);
    for (const row of rows) runs.renderRunLine(row);
    const listed = command(root, ['roster', '--runs']);
    assert.equal(listed.exit, 0);
    assert.match(listed.out, /\$0\.42/);
  });
});

// --- the prep field on a roster line ---------------------------------------

const PREP_ROSTER = `# roster

## search
- claude, model: haiku, max: 2 min

## build
- cursor, max: 20 min, prep: search
- devin, model: swe-2-max
`;

test('a worker line reads "prep: search" and the roster view says "prepped by search"', async () => {
  await withRoom(async ({ root }) => {
    const { readRosterState } = require('../lib/engine-registry');
    const picks = readRosterState(root).project.picks;
    assert.equal(picks.executor.workers[0].prep, 'navigator');
    assert.equal('prep' in picks.executor.workers[1], false);
    const view = command(root, ['roster']);
    assert.equal(view.exit, 0);
    assert.match(view.out, /build .*prepped by search/);
    const json = JSON.parse(command(root, ['roster', '--json']).out);
    const build = json.jobs.find((row) => row.job === 'build');
    assert.equal(build.prep, 'search');
    assert.deepEqual(build.workers.map((worker) => worker.prep), ['search', null]);
  }, { roster: PREP_ROSTER });
});

test('prep naming its own job warns in plain words and the worker still counts', async () => {
  await withRoom(async ({ root }) => {
    const { readRosterState } = require('../lib/engine-registry');
    const layer = readRosterState(root).project;
    assert.equal(layer.picks.executor.engine, 'cursor');
    assert.equal('prep' in layer.picks.executor.workers[0], false);
    assert.match(layer.warnings.map((w) => w.message).join('\n'), /asks build to prep for itself, so this worker runs without prep/);
    const view = command(root, ['roster']);
    assert.equal(view.exit, 0);
    assert.doesNotMatch(view.out, /prepped by/);
  }, { roster: '# roster\n\n## build\n- cursor, prep: build\n' });
});

test('assign --prep writes the field, and refuses a job prepping for itself', async () => {
  await withRoom(async ({ root }) => {
    const written = command(root, ['assign', 'review', 'claude', '--prep', 'search']);
    assert.equal(written.exit, 0, written.out);
    assert.match(fs.readFileSync(path.join(root, 'atris', 'ROSTER.md'), 'utf8'), /## review\n- claude code, prep: search\n/);
    assert.match(written.out, /review .*prepped by search/);
    const refused = command(root, ['assign', 'build', 'cursor', '--prep', 'build']);
    assert.equal(refused.exit, 2);
    assert.match(refused.out, /build cannot prep for itself/);
    const bad = command(root, ['assign', 'build', 'cursor', '--prep', '???']);
    assert.equal(bad.exit, 2);
    assert.match(bad.out, /is not a job name/);
  });
});

// --- the prep pass at launch -----------------------------------------------

const TASK = {
  display_id: 'CLI-900',
  status: 'open',
  title: 'Fix the widget. Done: widget renders once. Check: node --test test/widget.test.js.',
};

const BRIEF = '- lib/widget.js:12 renders twice here\n    render(); render();\n- test/widget.test.js:3 the check';

// Each call moves the clock 90 seconds.
function stepClock(start = NOW, step = 90000) {
  let at = start;
  return () => {
    const value = at;
    at += step;
    return value;
  };
}

// A fake engine binary: logs that it ran and every argument it got (the
// prompt rides in as an argument), then prints stdout or sleeps past its cap.
function fakeEngine(bin, name, { stdout = '', exit = 0, sleep = 0 } = {}) {
  const file = path.join(bin, name);
  fs.writeFileSync(`${file}.out`, stdout);
  fs.writeFileSync(file, [
    '#!/bin/sh',
    `echo "${name}" >> "${path.join(bin, 'calls.log')}"`,
    `printf '%s\\n' "$@" > "${file}.args"`,
    sleep ? `sleep ${sleep}` : '',
    `cat "${file}.out"`,
    `exit ${exit}`,
    '',
  ].join('\n'));
  fs.chmodSync(file, 0o755);
}

function calls(bin) {
  const file = path.join(bin, 'calls.log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : [];
}

function argsOf(bin, name) {
  const file = path.join(bin, `${name}.args`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function ownCli(wt) {
  return (args) => {
    if (args[0] === 'task' && args[1] === 'show') return { status: 0, stdout: JSON.stringify(TASK), stderr: '' };
    if (args[0] === 'worktree' && args[1] === 'start') return { status: 0, stdout: `next: cd ${wt}\n`, stderr: '' };
    return { status: 0, stdout: 'done: worktree shipped\n', stderr: '' };
  };
}

// The same flight `atris engine dispatch --engine cursor` starts: the build
// line's pins for cursor, prep included, ride along.
function dispatchAsCommand(root, wt, options = {}) {
  const { rosterPinFor } = require('../lib/engine-registry');
  const fleet = require('../lib/fleet');
  const pin = rosterPinFor('executor', 'cursor', root);
  return fleet.runDispatchFlight({
    root,
    taskIds: ['CLI-900'],
    engine: 'cursor',
    installedEngines: [],
    ownCli: ownCli(wt),
    rebase: () => ({ ok: true, stage: 'rebased' }),
    verifier: () => ({ status: 0, stdout: '# pass 1\n', stderr: '' }),
    scoutAsk: false,
    log: () => {},
    clock: stepClock(),
    ...(pin.roster_max_seconds ? { maxSeconds: pin.roster_max_seconds } : {}),
    ...(pin.roster_prep ? { prep: pin.roster_prep } : {}),
    ...options,
  });
}

function runs(root) {
  return require('../lib/roster-runs').readRosterRuns(root, { now: NOW + 3600000 });
}

test('a worker with prep: search runs the search lead first and gets a prompt with the brief', async () => {
  await withRoom(async ({ root, bin, wt }) => {
    fakeEngine(bin, 'claude', { stdout: `${BRIEF}\n` });
    fakeEngine(bin, 'cursor-agent', { stdout: 'built the widget\n' });
    const flight = await dispatchAsCommand(root, wt);
    assert.equal(flight.landed.length, 1);
    assert.deepEqual(calls(bin), ['claude', 'cursor-agent']);
    const prepArgs = argsOf(bin, 'claude');
    assert.match(prepArgs, /prep pass for a heavier build worker/);
    assert.match(prepArgs, /Fix the widget/);
    const prompt = argsOf(bin, 'cursor-agent');
    assert.match(prompt, /## brief from the prep pass \(search, claude\)/);
    assert.match(prompt, /Work from this brief\. Open other files only if the brief is missing something, and say in your final report what was missing\./);
    assert.match(prompt, /lib\/widget\.js:12 renders twice here/);
    // Two lines: the prep pass, then the heavy run with the brief size.
    const rows = runs(root);
    assert.deepEqual(rows.map((row) => [row.job, row.engine, row.outcome]), [
      ['search', 'claude', 'landed'],
      ['build', 'cursor', 'landed'],
    ]);
    assert.equal(rows[0].source, 'prep');
    assert.equal(rows[0].task, 'CLI-900');
    assert.equal(rows[0].max_seconds, 120);
    assert.match(rows[0].detail, /^brief for build, 3 lines, /);
    assert.equal(rows[1].prep, 'prepped by search');
    assert.equal(rows[1].brief_lines, 3);
    assert.equal(rows[1].brief_bytes, Buffer.byteLength(BRIEF));
    const listed = command(root, ['roster', '--runs']);
    assert.match(listed.out, /build CLI-900: cursor .*landed, prepped by search \(\d+ bytes brief\)/);
  }, { roster: PREP_ROSTER });
});

test('the brief is capped at its line and size limits', async () => {
  const { capBrief, PREP_MAX_LINES, PREP_MAX_BYTES } = require('../lib/roster-prep');
  const long = Array.from({ length: 1000 }, (_, i) => `- lib/file${i}.js:${i} note`).join('\n');
  const byLines = capBrief(long);
  assert.equal(byLines.cut, true);
  assert.ok(byLines.text.split('\n').length <= PREP_MAX_LINES);
  assert.ok(byLines.bytes <= PREP_MAX_BYTES);
  assert.match(byLines.text, /brief cut to fit its size cap\)$/);
  const wide = Array.from({ length: 100 }, () => 'x'.repeat(1000)).join('\n');
  const byBytes = capBrief(wide);
  assert.ok(byBytes.bytes <= PREP_MAX_BYTES);
  assert.ok(byBytes.text.split('\n').every((line) => line === 'x'.repeat(1000) || /cut to fit/.test(line)));
  assert.deepEqual(capBrief('  \n \n'), { text: '', lines: 0, bytes: 0, cut: false });

  await withRoom(async ({ root, bin, wt }) => {
    fakeEngine(bin, 'claude', { stdout: `${long}\n` });
    fakeEngine(bin, 'cursor-agent', { stdout: 'built the widget\n' });
    await dispatchAsCommand(root, wt);
    const prompt = argsOf(bin, 'cursor-agent');
    assert.match(prompt, /lib\/file0\.js:0 note/);
    assert.doesNotMatch(prompt, /lib\/file999\.js/);
    const heavy = runs(root).find((row) => row.job === 'build');
    assert.ok(heavy.brief_lines <= PREP_MAX_LINES);
    assert.ok(heavy.brief_bytes <= PREP_MAX_BYTES);
  }, { roster: PREP_ROSTER });
});

test('a prep stall or empty answer still runs the heavy worker and records "prep skipped"', async () => {
  const stallRoster = PREP_ROSTER.replace('- claude, model: haiku, max: 2 min', '- claude, model: haiku, max: 1s');
  await withRoom(async ({ root, bin, wt }) => {
    fakeEngine(bin, 'claude', { stdout: BRIEF, sleep: 30 });
    fakeEngine(bin, 'cursor-agent', { stdout: 'built the widget\n' });
    const flight = await dispatchAsCommand(root, wt);
    assert.equal(flight.landed.length, 1);
    assert.doesNotMatch(argsOf(bin, 'cursor-agent'), /brief from the prep pass/);
    const rows = runs(root);
    assert.deepEqual(rows.map((row) => [row.job, row.engine, row.outcome]), [
      ['search', 'claude', 'stalled'],
      ['build', 'cursor', 'landed'],
    ]);
    assert.equal(rows[0].detail, 'stalled at 1s');
    assert.equal(rows[1].prep, 'prep skipped: stalled at 1s');
    assert.equal('brief_bytes' in rows[1], false);
  }, { roster: stallRoster });
  await withRoom(async ({ root, bin, wt }) => {
    fakeEngine(bin, 'claude', { stdout: '   \n' });
    fakeEngine(bin, 'cursor-agent', { stdout: 'built the widget\n' });
    const flight = await dispatchAsCommand(root, wt);
    assert.equal(flight.landed.length, 1);
    assert.doesNotMatch(argsOf(bin, 'cursor-agent'), /brief from the prep pass/);
    const rows = runs(root);
    assert.deepEqual(rows.map((row) => [row.job, row.outcome]), [['search', 'failed'], ['build', 'landed']]);
    assert.equal(rows[1].prep, 'prep skipped: returned nothing');
  }, { roster: PREP_ROSTER });
  await withRoom(async ({ root, bin, wt }) => {
    fakeEngine(bin, 'claude', { stdout: 'boom\n', exit: 3 });
    fakeEngine(bin, 'cursor-agent', { stdout: 'built the widget\n' });
    await dispatchAsCommand(root, wt);
    assert.equal(runs(root)[1].prep, 'prep skipped: claude exited 3');
  }, { roster: PREP_ROSTER });
});

test('prep naming its own job runs the worker without prep', async () => {
  await withRoom(async ({ root, bin, wt }) => {
    fakeEngine(bin, 'claude', { stdout: BRIEF });
    fakeEngine(bin, 'cursor-agent', { stdout: 'built the widget\n' });
    const flight = await dispatchAsCommand(root, wt);
    assert.equal(flight.landed.length, 1);
    assert.deepEqual(calls(bin), ['cursor-agent']);
    assert.deepEqual(runs(root).map((row) => [row.job, row.prep || '']), [['build', '']]);
    // Handed a prep job equal to its own job at launch, the pass refuses too.
    const { runPrepPass } = require('../lib/roster-prep');
    const refused = await runPrepPass({ prepJob: 'build', forJob: 'build', task: TASK, root });
    assert.deepEqual([refused.ok, refused.reason], [false, 'build cannot prep for itself']);
  }, { roster: '# roster\n\n## search\n- claude, model: haiku\n\n## build\n- cursor, prep: build\n' });
});

test('a worker without prep runs exactly as before', async () => {
  await withRoom(async ({ root, bin, wt }) => {
    fakeEngine(bin, 'claude', { stdout: BRIEF });
    fakeEngine(bin, 'cursor-agent', { stdout: 'built the widget\n' });
    const flight = await dispatchAsCommand(root, wt);
    assert.equal(flight.landed.length, 1);
    assert.deepEqual(calls(bin), ['cursor-agent']);
    assert.doesNotMatch(argsOf(bin, 'cursor-agent'), /brief from the prep pass/);
    const rows = runs(root);
    assert.equal(rows.length, 1);
    assert.deepEqual(Object.keys(rows[0]).filter((key) => /prep|brief/.test(key)), []);
  }, { roster: '# roster\n\n## search\n- claude, model: haiku\n\n## build\n- cursor, max: 20 min\n' });
});

test('a handover backup preps only when its own line asks', async () => {
  const roster = '# roster\n\n## search\n- claude, model: haiku\n\n## build\n- devin, model: swe-2-max, max: 1s\n- cursor, prep: search\n';
  await withRoom(async ({ root, bin, wt }) => {
    fakeEngine(bin, 'claude', { stdout: BRIEF });
    fakeEngine(bin, 'devin', { stdout: 'never', sleep: 30 });
    fakeEngine(bin, 'cursor-agent', { stdout: 'built the widget\n' });
    const fleet = require('../lib/fleet');
    const flight = await fleet.runDispatchFlight({
      root,
      taskIds: ['CLI-900'],
      engine: 'devin',
      installedEngines: [],
      model: 'swe-2-max',
      maxSeconds: 1,
      ownCli: ownCli(wt),
      rebase: () => ({ ok: true, stage: 'rebased' }),
      verifier: () => ({ status: 0, stdout: '# pass 1\n', stderr: '' }),
      scoutAsk: false,
      log: () => {},
      clock: stepClock(),
    });
    assert.equal(flight.landed.length, 1);
    assert.deepEqual(calls(bin), ['devin', 'claude', 'cursor-agent']);
    assert.doesNotMatch(argsOf(bin, 'devin'), /brief from the prep pass/);
    assert.match(argsOf(bin, 'cursor-agent'), /brief from the prep pass/);
    const rows = runs(root);
    assert.deepEqual(rows.map((row) => [row.job, row.engine, row.outcome, row.prep || '']), [
      ['search', 'claude', 'landed', ''],
      ['build', 'devin', 'stalled', ''],
      ['build', 'cursor', 'landed', 'prepped by search'],
    ]);
  }, { roster });
});

test('a one-lap reviewer with prep reads the brief before it reviews', async () => {
  await withRoom(async ({ root, bin, wt }) => {
    fakeEngine(bin, 'claude', { stdout: BRIEF });
    const fleet = require('../lib/fleet');
    const prompts = [];
    const flight = await fleet.runDispatchFlight({
      root,
      taskIds: ['CLI-900'],
      engine: 'cursor',
      reviewOnly: true,
      verifierCommand: 'node --test test/widget.test.js',
      receiptContext: { source: 'one_lap', objective: 'Fix the widget' },
      ownCli: ownCli(wt),
      dispatcher: () => Promise.resolve({ exitCode: 0, report: 'built the widget' }),
      rebase: () => ({ ok: true, stage: 'rebased' }),
      verifier: () => ({ status: 0, stdout: '# pass 1\n', stderr: '' }),
      validatorEngines: ['codex'],
      validatorModels: { codex: { model: '', effort: 'high', max_seconds: 0, prep: 'navigator' } },
      validatorDispatcher: ({ prompt }) => {
        prompts.push(prompt);
        return Promise.resolve({ exitCode: 0, report: 'read the diff\nSIGNOFF: widget renders once' });
      },
      validatorStateInspector: () => ({ ok: true, head: 'abc', digest: 'clean-state' }),
      changeInspector: () => ({ has_change: true, base: 'a', head: 'b', commit: 'b', dirty: false }),
      scoutAsk: false,
      clock: stepClock(),
      log: () => {},
    });
    assert.equal(flight.ready.length, 1);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /## brief from the prep pass \(search, claude\)/);
    assert.match(argsOf(bin, 'claude'), /prep pass for a heavier review worker/);
    const rows = runs(root);
    assert.deepEqual(rows.map((row) => [row.job, row.engine, row.prep || '']), [
      ['search', 'claude', ''],
      ['review', 'codex', 'prepped by search'],
      ['build', 'cursor', ''],
    ]);
  }, { roster: '# roster\n\n## search\n- claude, model: haiku\n' });
});

test('a fleet build on the build lead honors its prep line', async () => {
  await withRoom(async ({ root, bin, wt }) => {
    fakeEngine(bin, 'claude', { stdout: BRIEF });
    fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(root, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      tasks: [{ display_id: 'CLI-900', status: 'open', title: TASK.title }],
    }));
    const prompts = [];
    const fleet = require('../lib/fleet');
    await fleet.runFleetFlight({
      root,
      engines: ['cursor'],
      ownCli: ownCli(wt),
      dispatcher: (entry) => {
        prompts.push(entry.prompt);
        return Promise.resolve({ exitCode: 0, report: 'built the widget' });
      },
      lander: () => ({ ok: false, stage: 'test_stop', detail: 'stop here' }),
      rebase: () => ({ ok: true, stage: 'rebased' }),
      guardCliLink: () => ({ ok: true, changed: false }),
      scoutAsk: false,
      clock: stepClock(),
      log: () => {},
    });
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /## brief from the prep pass \(search, claude\)/);
    assert.equal(runs(root)[0].job, 'search');
  }, { roster: PREP_ROSTER });
});

test('a reviewer past a credit wall reuses the brief when the next reviewer also preps', async () => {
  await withRoom(async ({ root, bin, wt }) => {
    fakeEngine(bin, 'claude', { stdout: BRIEF });
    const fleet = require('../lib/fleet');
    const prompts = [];
    const flight = await fleet.runDispatchFlight({
      root,
      taskIds: ['CLI-900'],
      engine: 'cursor',
      reviewOnly: true,
      verifierCommand: 'node --test test/widget.test.js',
      receiptContext: { source: 'one_lap', objective: 'Fix the widget' },
      ownCli: ownCli(wt),
      dispatcher: () => Promise.resolve({ exitCode: 0, report: 'built the widget' }),
      rebase: () => ({ ok: true, stage: 'rebased' }),
      verifier: () => ({ status: 0, stdout: '# pass 1\n', stderr: '' }),
      validatorEngines: ['codex', 'devin'],
      validatorModels: {
        codex: { model: '', effort: 'high', max_seconds: 0, prep: 'search' },
        devin: { model: '', effort: '', max_seconds: 0, prep: 'search' },
      },
      validatorDispatcher: ({ engine, prompt }) => {
        prompts.push(prompt);
        if (engine === 'codex') return Promise.resolve({ exitCode: 1, stderr: 'usage limit reached' });
        return Promise.resolve({ exitCode: 0, report: 'read the diff\nSIGNOFF: widget renders once' });
      },
      validatorStateInspector: () => ({ ok: true, head: 'abc', digest: 'clean-state' }),
      changeInspector: () => ({ has_change: true, base: 'a', head: 'b', commit: 'b', dirty: false }),
      scoutAsk: false,
      clock: stepClock(),
      log: () => {},
    });
    assert.equal(flight.ready.length, 1);
    assert.equal(prompts.length, 2);
    for (const prompt of prompts) assert.match(prompt, /## brief from the prep pass \(search, claude\)/);
    assert.deepEqual(calls(bin), ['claude'], 'the prep pass runs once for the task');
    const rows = runs(root);
    assert.deepEqual(rows.map((row) => [row.job, row.engine, row.prep || '']), [
      ['search', 'claude', ''],
      ['review', 'codex', 'prepped by search'],
      ['review', 'devin', 'prepped by search'],
      ['build', 'cursor', ''],
    ]);
  }, { roster: '# roster\n\n## search\n- claude, model: haiku\n' });
});

test('an append that lands while the record is being trimmed is kept', async () => {
  await withRoom(async ({ root }) => {
    const runs = require('../lib/roster-runs');
    const file = runs.rosterRunsPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = (i) => `${JSON.stringify({ at: new Date(NOW).toISOString(), job: 'build', engine: 'cursor', outcome: 'landed', task: `CLI-${i}`, detail: 'x'.repeat(200) })}\n`;
    const lines = [];
    let bytes = 0;
    for (let i = 0; bytes <= runs.RUNS_ROTATE_BYTES; i += 1) {
      lines.push(line(i));
      bytes += Buffer.byteLength(lines[lines.length - 1]);
    }
    fs.writeFileSync(file, lines.join(''));
    const marker = path.join(root, 'other-writer.done');
    const script = [
      `const runs = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'roster-runs'))});`,
      `runs.appendRosterRun(${JSON.stringify(root)}, { at: ${JSON.stringify(new Date(NOW).toISOString())}, job: 'build', engine: 'grok', outcome: 'landed', task: 'CLI-OTHER' });`,
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'done');`,
    ].join('\n');
    // A second process appends while this one sits between reading the
    // tail and renaming the trimmed copy over the log.
    const originalRename = fs.renameSync;
    let child = null;
    fs.renameSync = (from, to) => {
      if (to === file && !child) {
        const { spawn } = require('node:child_process');
        child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
        const until = Date.now() + 500;
        const pause = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(marker) && Date.now() < until) Atomics.wait(pause, 0, 0, 10);
      }
      return originalRename(from, to);
    };
    try {
      runs.appendRosterRun(root, { at: new Date(NOW).toISOString(), job: 'build', engine: 'devin', outcome: 'landed', task: 'CLI-LAST' });
    } finally {
      fs.renameSync = originalRename;
    }
    assert.ok(child, 'the trim reached its rename');
    await new Promise((resolve) => (child.exitCode !== null ? resolve() : child.on('exit', resolve)));
    const tasks = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((row) => JSON.parse(row).task);
    assert.ok(tasks.includes('CLI-LAST'));
    assert.ok(tasks.includes('CLI-OTHER'), 'the other writer\'s line survived the trim');
    assert.ok(Buffer.byteLength(fs.readFileSync(file)) < runs.RUNS_ROTATE_BYTES);
    assert.equal(fs.existsSync(`${file}.lock`), false, 'the lock is released');
  });
});

test('a lock left behind by a crashed writer is taken back, and a held lock never blocks recording', async () => {
  await withRoom(async ({ root }) => {
    const runs = require('../lib/roster-runs');
    const file = runs.rosterRunsPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lock = `${file}.lock`;
    // Stale: older than the stale window, so the next writer removes it.
    fs.writeFileSync(lock, '99999');
    const old = new Date(Date.now() - runs.RUNS_LOCK_STALE_MS - 1000);
    fs.utimesSync(lock, old, old);
    assert.ok(runs.appendRosterRun(root, { job: 'build', engine: 'devin', outcome: 'landed', task: 'CLI-1' }));
    assert.equal(fs.existsSync(lock), false);
    // Fresh: held by someone else, so the append waits briefly, writes anyway,
    // and leaves the other writer's lock alone.
    fs.writeFileSync(lock, '99999');
    const started = Date.now();
    assert.ok(runs.appendRosterRun(root, { job: 'build', engine: 'grok', outcome: 'landed', task: 'CLI-2' }));
    assert.ok(Date.now() - started < runs.RUNS_LOCK_WAIT_MS + 1000);
    assert.equal(fs.existsSync(lock), true);
    const tasks = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((row) => JSON.parse(row).task);
    assert.deepEqual(tasks, ['CLI-1', 'CLI-2']);
  });
});
