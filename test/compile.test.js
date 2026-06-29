'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  appendRecord,
  readRecords,
  readManifest,
  writeManifest,
  defaultManifest,
  deepEqual,
  runBacktest,
  promoteProcess,
  executeBuild,
  buildCompilePrompt,
  parseValueArg,
  parseFlags,
  listProcesses,
  runnerPath,
  DEFAULT_THRESHOLD,
} = require('../commands/compile');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-compile-'));
}

function writeRunner(root, name, body) {
  const p = runnerPath(root, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

const DOUBLER = 'module.exports = { run: (input) => ({ doubled: input.n * 2 }) };\n';
const COMPILE_SRC = fs.readFileSync(path.join(__dirname, '..', 'commands', 'compile.js'), 'utf8');

function seedRecords(root, name, count, { badFrom = Infinity } = {}) {
  for (let i = 0; i < count; i++) {
    const expected = i >= badFrom ? { doubled: -1 } : { doubled: i * 2 };
    appendRecord(root, name, { input: { n: i }, output: expected });
  }
}

test('deepEqual: primitives, objects, arrays, NaN, null', () => {
  assert.equal(deepEqual(1, 1), true);
  assert.equal(deepEqual('a', 'a'), true);
  assert.equal(deepEqual(NaN, NaN), true);
  assert.equal(deepEqual(null, null), true);
  assert.equal(deepEqual(null, {}), false);
  assert.equal(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), true);
  assert.equal(deepEqual({ a: 1 }, { a: 1, b: 2 }), false);
  assert.equal(deepEqual([1, 2], { 0: 1, 1: 2 }), false);
});

test('parseValueArg: inline json, plain string, @file', () => {
  assert.deepEqual(parseValueArg('{"a":1}'), { a: 1 });
  assert.equal(parseValueArg('hello world'), 'hello world');
  assert.equal(parseValueArg('42'), 42);
  const root = makeRoot();
  const f = path.join(root, 'payload.json');
  fs.writeFileSync(f, '{"from":"file"}');
  assert.deepEqual(parseValueArg(`@${f}`), { from: 'file' });
});

test('parseFlags: --k v, --k=v, boolean flags, positionals', () => {
  const { flags, positional } = parseFlags(['name', '--input', '{"n":1}', '--threshold=0.9', '--record']);
  assert.deepEqual(positional, ['name']);
  assert.equal(flags.input, '{"n":1}');
  assert.equal(flags.threshold, '0.9');
  assert.equal(flags.record, true);
});

test('compile build uses the shared runner command instead of raw claude', () => {
  assert.doesNotMatch(COMPILE_SRC, /which claude/);
  assert.doesNotMatch(COMPILE_SRC, /claude -p "\$\(cat/);
  assert.doesNotMatch(COMPILE_SRC, /install Claude Code first/);
  assert.doesNotMatch(COMPILE_SRC, /resolveClaudeRunnerBin/);
  assert.match(COMPILE_SRC, /resolveRunnerBin/);
  assert.match(COMPILE_SRC, /buildRunnerAvailabilityCommand\(/);
  assert.match(COMPILE_SRC, /buildRunnerCommand\(/);
});

test('records: append + read round-trip with timestamps', () => {
  const root = makeRoot();
  appendRecord(root, 'demo', { input: { n: 1 }, output: { doubled: 2 } });
  appendRecord(root, 'demo', { input: { n: 2 }, output: { doubled: 4 }, expected: { doubled: 4 } });
  const records = readRecords(root, 'demo');
  assert.equal(records.length, 2);
  assert.ok(records[0].ts);
  assert.deepEqual(records[1].expected, { doubled: 4 });
  assert.deepEqual(listProcesses(root), ['demo']);
});

test('backtest: perfect runner passes the gate', async () => {
  const root = makeRoot();
  seedRecords(root, 'demo', 5);
  writeRunner(root, 'demo', DOUBLER);
  const { result, manifest } = await runBacktest(root, 'demo');
  assert.equal(result.total, 5);
  assert.equal(result.passed, 5);
  assert.equal(result.accuracy, 1);
  assert.equal(result.threshold, DEFAULT_THRESHOLD);
  assert.deepEqual(readManifest(root, 'demo').backtest.failures, []);
  assert.equal(manifest.status, 'draft');
});

test('backtest: mismatches and thrown errors counted as failures', async () => {
  const root = makeRoot();
  seedRecords(root, 'demo', 4, { badFrom: 3 }); // record 3 expects -1
  appendRecord(root, 'demo', { input: null, output: { doubled: 0 } }); // runner throws on null
  writeRunner(root, 'demo', DOUBLER);
  const { result, failureCount } = await runBacktest(root, 'demo');
  assert.equal(result.total, 5);
  assert.equal(result.passed, 3);
  assert.equal(failureCount, 2);
  assert.ok(result.failures.some((f) => f.error));
  assert.ok(result.failures.some((f) => f.actual));
});

test('backtest: expected overrides recorded output', async () => {
  const root = makeRoot();
  // recorded output was wrong; human corrected it via expected
  appendRecord(root, 'demo', { input: { n: 3 }, output: { doubled: 7 }, expected: { doubled: 6 } });
  writeRunner(root, 'demo', DOUBLER);
  const { result } = await runBacktest(root, 'demo');
  assert.equal(result.passed, 1);
});

test('backtest: missing records or runner throws clear errors', async () => {
  const root = makeRoot();
  await assert.rejects(() => runBacktest(root, 'ghost'), /no execution records/);
  seedRecords(root, 'demo', 1);
  await assert.rejects(() => runBacktest(root, 'demo'), /no compiled artifact/);
  writeRunner(root, 'demo', 'module.exports = {};\n');
  await assert.rejects(() => runBacktest(root, 'demo'), /must export \{ run\(input\) \}/);
});

test('promote: gate blocks below threshold, passes at threshold', async () => {
  const root = makeRoot();
  seedRecords(root, 'demo', 10, { badFrom: 9 }); // 9/10 = 90%
  writeRunner(root, 'demo', DOUBLER);
  const manifest = defaultManifest('demo');
  manifest.version = 1;
  writeManifest(root, 'demo', manifest);

  await runBacktest(root, 'demo');
  assert.throws(() => promoteProcess(root, 'demo'), /below the/);

  const promoted = promoteProcess(root, 'demo', { threshold: 0.9 });
  assert.equal(promoted.status, 'active');
  assert.ok(promoted.promotedAt);
  assert.equal(readManifest(root, 'demo').threshold, 0.9);
});

test('backtest: one-off --threshold does not rewrite the standing gate', async () => {
  const root = makeRoot();
  seedRecords(root, 'demo', 10, { badFrom: 9 }); // 9/10 = 90%
  writeRunner(root, 'demo', DOUBLER);
  writeManifest(root, 'demo', defaultManifest('demo'));

  const { result } = await runBacktest(root, 'demo', { threshold: 0.5 });
  assert.equal(result.threshold, 0.5); // this run was judged against the override
  assert.equal(readManifest(root, 'demo').threshold, DEFAULT_THRESHOLD); // gate untouched
  assert.throws(() => promoteProcess(root, 'demo'), /below the/); // promote still uses the gate
});

test('drift: one-off backtest threshold does not change the drift verdict', async () => {
  const root = makeRoot();
  seedRecords(root, 'demo', 5);
  writeRunner(root, 'demo', DOUBLER);
  writeManifest(root, 'demo', defaultManifest('demo'));
  await runBacktest(root, 'demo');
  promoteProcess(root, 'demo');

  seedRecords(root, 'demo', 10, { badFrom: 5 }); // accuracy drops to 10/15
  const { manifest } = await runBacktest(root, 'demo', { threshold: 0.1 }); // lax one-off
  assert.equal(manifest.status, 'drifted'); // still judged drifted against the standing gate
});

test('promote: refuses stale backtest from an older version', async () => {
  const root = makeRoot();
  seedRecords(root, 'demo', 3);
  writeRunner(root, 'demo', DOUBLER);
  const manifest = defaultManifest('demo');
  manifest.version = 1;
  writeManifest(root, 'demo', manifest);
  await runBacktest(root, 'demo');
  // simulate a recompile bumping the version after the backtest
  const bumped = readManifest(root, 'demo');
  bumped.version = 2;
  writeManifest(root, 'demo', bumped);
  assert.throws(() => promoteProcess(root, 'demo'), /re-run the backtest/);
});

test('promote: requires manifest and backtest to exist', () => {
  const root = makeRoot();
  assert.throws(() => promoteProcess(root, 'ghost'), /no manifest/);
  writeManifest(root, 'demo', defaultManifest('demo'));
  assert.throws(() => promoteProcess(root, 'demo'), /no backtest/);
});

test('drift: active process falling below gate is marked drifted', async () => {
  const root = makeRoot();
  seedRecords(root, 'demo', 5);
  writeRunner(root, 'demo', DOUBLER);
  const manifest = defaultManifest('demo');
  manifest.version = 1;
  writeManifest(root, 'demo', manifest);
  await runBacktest(root, 'demo');
  promoteProcess(root, 'demo');

  // the world changes: new records contradict the compiled logic
  seedRecords(root, 'demo', 10, { badFrom: 5 });
  const { manifest: after } = await runBacktest(root, 'demo');
  assert.equal(after.status, 'drifted');
});

test('rebuild: an active process drops to draft and must re-earn the gate', async () => {
  const root = makeRoot();
  seedRecords(root, 'demo', 5);
  writeRunner(root, 'demo', DOUBLER);
  const manifest = defaultManifest('demo');
  manifest.version = 1;
  writeManifest(root, 'demo', manifest);
  await runBacktest(root, 'demo');
  promoteProcess(root, 'demo');
  assert.equal(readManifest(root, 'demo').status, 'active');

  // recompile: cmdOverride seam stands in for the claude build (runner already on disk)
  const rebuilt = executeBuild(root, 'demo', { cmdOverride: 'true' });
  assert.equal(rebuilt.status, 'draft'); // active badge does not survive unverified code
  assert.equal(rebuilt.backtest, null);
  assert.equal(rebuilt.version, 2);
  assert.throws(() => promoteProcess(root, 'demo'), /no backtest/);
});

test('executeBuild honors ATRIS_CLAUDE_BIN when no cmdOverride is provided', () => {
  const root = makeRoot();
  seedRecords(root, 'demo', 5);
  const fakeRunner = path.join(root, 'fake-runner');
  fs.writeFileSync(fakeRunner, [
    '#!/bin/sh',
    'mkdir -p atris/processes/demo',
    "cat > atris/processes/demo/run.js <<'RUNNER'",
    DOUBLER.trim(),
    'RUNNER',
    '',
  ].join('\n'));
  fs.chmodSync(fakeRunner, 0o755);

  const prevRunnerBin = process.env.ATRIS_RUNNER_BIN;
  const prevRunnerProfile = process.env.ATRIS_RUNNER_PROFILE;
  const prevRunnerTemplate = process.env.ATRIS_RUNNER_COMMAND_TEMPLATE;
  const prevBin = process.env.ATRIS_CLAUDE_BIN;
  const prevTemplate = process.env.ATRIS_CLAUDE_COMMAND_TEMPLATE;
  delete process.env.ATRIS_RUNNER_PROFILE;
  delete process.env.ATRIS_RUNNER_BIN;
  delete process.env.ATRIS_RUNNER_COMMAND_TEMPLATE;
  process.env.ATRIS_CLAUDE_BIN = fakeRunner;
  delete process.env.ATRIS_CLAUDE_COMMAND_TEMPLATE;
  try {
    const manifest = executeBuild(root, 'demo');
    assert.equal(manifest.status, 'draft');
    assert.equal(manifest.version, 1);
    assert.ok(fs.existsSync(runnerPath(root, 'demo')));
  } finally {
    if (prevRunnerBin === undefined) delete process.env.ATRIS_RUNNER_BIN;
    else process.env.ATRIS_RUNNER_BIN = prevRunnerBin;
    if (prevRunnerProfile === undefined) delete process.env.ATRIS_RUNNER_PROFILE;
    else process.env.ATRIS_RUNNER_PROFILE = prevRunnerProfile;
    if (prevRunnerTemplate === undefined) delete process.env.ATRIS_RUNNER_COMMAND_TEMPLATE;
    else process.env.ATRIS_RUNNER_COMMAND_TEMPLATE = prevRunnerTemplate;
    if (prevBin === undefined) delete process.env.ATRIS_CLAUDE_BIN;
    else process.env.ATRIS_CLAUDE_BIN = prevBin;
    if (prevTemplate === undefined) delete process.env.ATRIS_CLAUDE_COMMAND_TEMPLATE;
    else process.env.ATRIS_CLAUDE_COMMAND_TEMPLATE = prevTemplate;
  }
});

test('writeManifest: leaves no partial tmp file behind', () => {
  const root = makeRoot();
  writeManifest(root, 'demo', defaultManifest('demo'));
  const dir = path.dirname(require('../commands/compile').manifestPath(root, 'demo'));
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')));
  assert.equal(readManifest(root, 'demo').status, 'draft');
});

test('backtest: supports async run()', async () => {
  const root = makeRoot();
  appendRecord(root, 'demo', { input: { n: 5 }, output: { doubled: 10 } });
  writeRunner(root, 'demo', 'module.exports = { run: async (input) => ({ doubled: input.n * 2 }) };\n');
  const { result } = await runBacktest(root, 'demo');
  assert.equal(result.accuracy, 1);
});

test('buildCompilePrompt: states the contract and samples records', () => {
  const root = makeRoot();
  const records = Array.from({ length: 30 }, (_, i) => ({ input: { n: i }, output: { doubled: i * 2 } }));
  const prompt = buildCompilePrompt(root, 'demo', records, 'watch the edge cases');
  assert.match(prompt, /module\.exports = \{ run \}/);
  assert.match(prompt, /deterministic/);
  assert.match(prompt, /zero npm dependencies/);
  assert.match(prompt, /do not hardcode a lookup table/);
  assert.match(prompt, /most recent 25 of 30/);
  assert.match(prompt, /watch the edge cases/);
  assert.match(prompt, /\[COMPILE_COMPLETE\]/);
  // no spec yet -> instructs the compiler to write one
  assert.match(prompt, /There is no spec file yet/);
});
