'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { truthCommand } = require('../commands/truth');

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-truth-cmd-test-'));
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  return dir;
}

function writeFeature(dir, name, { status, proofAgeDays } = {}) {
  const fdir = path.join(dir, 'atris', 'features', name);
  fs.mkdirSync(fdir, { recursive: true });
  fs.writeFileSync(path.join(fdir, 'validate.md'), `status: ${status}\n`, 'utf8');
  if (proofAgeDays != null) {
    const proofDir = path.join(fdir, 'proof');
    fs.mkdirSync(proofDir, { recursive: true });
    const receipt = path.join(proofDir, 'receipt.md');
    fs.writeFileSync(receipt, 'proof\n', 'utf8');
    const when = new Date(Date.now() - proofAgeDays * 86400000);
    fs.utimesSync(receipt, when, when);
  }
}

// Run truthCommand inside `dir` with HOME and the task db pointed at temp
// paths, capturing console.log/console.error. Returns { code, out, err }.
function runTruth(dir, args) {
  const prevCwd = process.cwd();
  const prevHome = process.env.HOME;
  const prevDb = process.env.ATRIS_TASKS_DB;
  const prevState = process.env.ATRIS_TEST_STATE_DIR;
  const prevLog = console.log;
  const prevErr = console.error;
  const out = [];
  const err = [];
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  let code;
  try {
    process.chdir(dir);
    process.env.HOME = dir;
    process.env.ATRIS_TEST_STATE_DIR = dir;
    process.env.ATRIS_TASKS_DB = path.join(dir, 'tasks.db');
    code = truthCommand(args);
  } finally {
    console.log = prevLog;
    console.error = prevErr;
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevDb === undefined) delete process.env.ATRIS_TASKS_DB; else process.env.ATRIS_TASKS_DB = prevDb;
    if (prevState === undefined) delete process.env.ATRIS_TEST_STATE_DIR; else process.env.ATRIS_TEST_STATE_DIR = prevState;
  }
  return { code, out: out.join('\n'), err: err.join('\n') };
}

test('truth renders workspace report for an empty atris workspace', () => {
  const dir = makeWorkspace();
  try {
    const { code, out } = runTruth(dir, []);
    assert.equal(code, 0);
    assert.match(out, /ATRIS TRUTH/);
    assert.match(out, /Scope: workspace/);
    assert.match(out, /Missions active: 0/);
    assert.match(out, /Feature lanes \(0\)/);
    assert.match(out, /Loops \(0\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('truth --json dedupes missions, filters closed ones, and verdicts features by proof age', () => {
  const dir = makeWorkspace();
  try {
    const stateDir = path.join(dir, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'missions.jsonl'),
      [
        JSON.stringify({ id: 'm1', status: 'active', owner: 'devin' }),
        'not json',
        JSON.stringify({ mission_id: 'm2', status: 'blocked' }),
        JSON.stringify({ id: 'm1', status: 'complete' }),
        JSON.stringify({ id: 'm3', status: 'stopped' }),
      ].join('\n') + '\n',
      'utf8',
    );

    writeFeature(dir, 'fresh', { status: 'in progress', proofAgeDays: 0 });
    writeFeature(dir, 'old', { status: 'in progress', proofAgeDays: 30 });
    writeFeature(dir, 'idea', { status: 'draft' });
    writeFeature(dir, 'jammed', { status: 'blocked on review' });
    writeFeature(dir, '_scratch', { status: 'in progress' });

    const { code, out } = runTruth(dir, ['--json']);
    assert.equal(code, 0);
    const result = JSON.parse(out);

    assert.equal(result.ok, true);
    assert.equal(result.scope.kind, 'workspace');

    const missionIds = result.missions_active.map((m) => m.id).sort();
    assert.deepEqual(missionIds, ['m2']);

    const rows = Object.fromEntries(result.feature_rows.map((f) => [f.lane, f.verdict]));
    assert.equal(rows.fresh, 'proven');
    assert.equal(rows.old, 'stale');
    assert.equal(rows.idea, 'unproven');
    assert.equal(rows.jammed, 'blocked');
    assert.equal(rows._scratch, undefined);
    assert.equal(result.features.proven, 1);
    assert.equal(result.features.stale, 1);
    assert.equal(result.features.unproven, 1);
    assert.equal(result.features.blocked, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('truth --json verdicts workspace loops from dated log lines', () => {
  const dir = makeWorkspace();
  try {
    const loopsDir = path.join(dir, 'atris', 'loops');
    fs.mkdirSync(loopsDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(path.join(loopsDir, 'alive.md'), `# alive\n\n- ${today}: tick\n`, 'utf8');
    fs.writeFileSync(path.join(loopsDir, 'dead.md'), '# dead\n\n- 2020-01-01: tick\n', 'utf8');
    fs.writeFileSync(path.join(loopsDir, 'fresh.md'), '# fresh\n\nno runs yet\n', 'utf8');
    fs.writeFileSync(path.join(loopsDir, 'LOOPS.md'), '# index\n\n- 2020-01-01: ignored\n', 'utf8');

    const { code, out } = runTruth(dir, ['--json']);
    assert.equal(code, 0);
    const result = JSON.parse(out);

    const rows = Object.fromEntries(result.loop_rows.map((l) => [l.id, l.verdict]));
    assert.equal(rows.alive, 'proven');
    assert.equal(rows.dead, 'stale');
    assert.equal(rows.fresh, 'never-ran');
    assert.equal(rows.LOOPS, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('truth refuses with code 2 in a scratch folder that has no atris/ tree', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-truth-scratch-'));
  try {
    const { code, err } = runTruth(dir, []);
    assert.equal(code, 2);
    assert.match(err, /account-global; pass --account to continue/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
