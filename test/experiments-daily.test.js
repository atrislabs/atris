const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const daily = require('../lib/experiments/daily');
const { SCORECARD_SCHEMA, evaluateKeepRule } = require('../lib/experiments/daily');
const { loadLessonMetadata } = require('../commands/autopilot');

function makeTempRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-experiments-daily-'));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  runGit(['init', '-b', 'master'], repo);
  runGit(['config', 'user.email', 'test@example.com'], repo);
  runGit(['config', 'user.name', 'Test'], repo);
  fs.mkdirSync(path.join(repo, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'target.txt'), 'baseline content\n', 'utf8');
  runGit(['add', '.'], repo);
  runGit(['commit', '-m', 'init'], repo);
  return { base, repo };
}

function cleanup(base) {
  fs.rmSync(base, { recursive: true, force: true });
}

function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result;
}

function runCli(args, cwd, extraEnv = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      CI: 'true',
      ...extraEnv,
    },
  });
  if (result.error) throw result.error;
  return result;
}

function writeBenchStub(repo, scenarios) {
  const stubPath = path.join(repo, '.bench-stub.js');
  const body = `#!/usr/bin/env node
const scenarios = ${JSON.stringify(scenarios)};
const args = process.argv.slice(2);
const labelIdx = args.indexOf('--label');
const label = labelIdx >= 0 ? args[labelIdx + 1] : 'baseline';
const scenario = scenarios[label] || scenarios.default || { exitCode: 2 };
const payload = {
  schema: 'atris.bench.run.v1',
  label,
  passed: scenario.passed || [],
  failed: scenario.failed || [],
  skipped: scenario.skipped || [],
};
process.stdout.write(JSON.stringify(payload));
process.exit(typeof scenario.exitCode === 'number' ? scenario.exitCode : 0);
`;
  fs.writeFileSync(stubPath, body, 'utf8');
  fs.chmodSync(stubPath, 0o755);
  return stubPath;
}

function seedQueue(repo, entry) {
  daily.appendQueueEntry(repo, entry);
}

function benchEnv(repo, scenarios) {
  return { ATRIS_BENCH_CMD: writeBenchStub(repo, scenarios) };
}

test('evaluateKeepRule: superset keeps, regression and verify failure revert', () => {
  const keep = evaluateKeepRule({
    baseline: { passed: ['a', 'b'], failed: [], skipped: [] },
    candidate: { passed: ['a', 'b', 'c'], failed: [], skipped: [] },
    verifyPassed: true,
    keepIfAllPass: false,
  });
  assert.equal(keep.keep, true);

  const revert = evaluateKeepRule({
    baseline: { passed: ['a', 'b'], failed: [], skipped: [] },
    candidate: { passed: ['a'], failed: ['b'], skipped: [] },
    verifyPassed: true,
    keepIfAllPass: false,
  });
  assert.equal(revert.keep, false);

  const verifyFail = evaluateKeepRule({
    baseline: { passed: ['a'], failed: [], skipped: [] },
    candidate: { passed: ['a'], failed: [], skipped: [] },
    verifyPassed: false,
    keepIfAllPass: false,
  });
  assert.equal(verifyFail.keep, false);
});

test('same-day gate no-ops and --force overrides', () => {
  const { base, repo } = makeTempRepo();
  try {
    daily.writeDailyState(repo, { last_run_date: new Date().toISOString().slice(0, 10), history: [] });
    const gated = runCli(['experiments', 'daily', '--json'], repo);
    assert.equal(gated.status, 0, gated.stderr || gated.stdout);
    const gatedPayload = JSON.parse(gated.stdout);
    assert.equal(gatedPayload.skipped, true);
    assert.equal(gatedPayload.reason, 'already_ran_today');

    const forced = runCli(['experiments', 'daily', '--force', '--json'], repo);
    assert.equal(forced.status, 0, forced.stderr || forced.stdout);
    const forcedPayload = JSON.parse(forced.stdout);
    assert.equal(forcedPayload.reason, 'queue_empty');
  } finally {
    cleanup(base);
  }
});

test('queue add/list and picker skips history', () => {
  const { base, repo } = makeTempRepo();
  try {
    const add = runCli([
      'experiments', 'queue', 'add', 'exp-a',
      '--target', 'target.txt',
      '--apply', 'apply.sh',
      '--verify', 'true',
      '--note', 'first',
    ], repo);
    assert.equal(add.status, 0, add.stderr || add.stdout);

    const list = runCli(['experiments', 'queue', 'list', '--json'], repo);
    assert.equal(list.status, 0, list.stderr || list.stdout);
    const parsed = JSON.parse(list.stdout);
    assert.equal(parsed.entries.length, 1);
    assert.equal(parsed.entries[0].id, 'exp-a');

    daily.writeDailyState(repo, { history: ['exp-a'], last_run_date: null });
    seedQueue(repo, {
      id: 'exp-b',
      kind: 'patch',
      target_files: ['target.txt'],
      apply: 'apply.sh',
      verify: null,
      note: '',
      added: new Date().toISOString(),
    });
    const picked = daily.pickQueueEntry(repo, daily.readDailyState(repo).history);
    assert.equal(picked.id, 'exp-b');
  } finally {
    cleanup(base);
  }
});

test('dirty target refusal', () => {
  const { base, repo } = makeTempRepo();
  try {
    seedQueue(repo, {
      id: 'dirty-exp',
      kind: 'patch',
      target_files: ['target.txt'],
      apply: 'apply.sh',
      verify: null,
      note: '',
      added: new Date().toISOString(),
    });
    fs.writeFileSync(path.join(repo, 'target.txt'), 'dirty\n', 'utf8');
    const result = runCli(['experiments', 'daily', '--force', '--json'], repo, benchEnv(repo, {}));
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.error, 'dirty_targets');
  } finally {
    cleanup(base);
  }
});

test('KEEP path end to end with stub bench', () => {
  const { base, repo } = makeTempRepo();
  try {
    fs.writeFileSync(path.join(repo, 'apply.sh'), '#!/bin/sh\necho "better" >> target.txt\n', 'utf8');
    fs.chmodSync(path.join(repo, 'apply.sh'), 0o755);
    seedQueue(repo, {
      id: 'keep-me',
      kind: 'patch',
      target_files: ['target.txt'],
      apply: 'apply.sh',
      verify: 'grep -q better target.txt',
      note: 'should keep',
      added: new Date().toISOString(),
    });

    const result = runCli(['experiments', 'daily', '--force', '--json'], repo, benchEnv(repo, {
      baseline: { exitCode: 0, passed: ['a', 'b'], failed: [], skipped: [] },
      candidate: { exitCode: 0, passed: ['a', 'b', 'c'], failed: [], skipped: [] },
    }));
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.decision, 'kept');

    const log = runGit(['log', '-1', '--format=%s'], repo);
    assert.equal(log.stdout.trim(), 'experiment(keep-me): kept');
    assert.match(fs.readFileSync(path.join(repo, 'target.txt'), 'utf8'), /better/);

    const scorecard = JSON.parse(fs.readFileSync(path.join(repo, '.atris', 'state', 'scorecards.jsonl'), 'utf8').trim());
    assert.equal(scorecard.schema, SCORECARD_SCHEMA);
    assert.equal(scorecard.decision, 'kept');

    const tsv = fs.readFileSync(path.join(repo, 'atris', 'experiments', 'daily', 'results.tsv'), 'utf8');
    assert.match(tsv, /keep-me\tkept/);

    const meta = loadLessonMetadata(repo);
    assert.equal(meta['experiment-keep-me'].status, 'pass');
    assert.match(meta['experiment-keep-me'].detector, /grep -q better target.txt/);
  } finally {
    cleanup(base);
  }
});

test('REVERT path restores byte-identical content', () => {
  const { base, repo } = makeTempRepo();
  try {
    const original = fs.readFileSync(path.join(repo, 'target.txt'));
    fs.writeFileSync(path.join(repo, 'apply.sh'), '#!/bin/sh\necho "worse" >> target.txt\n', 'utf8');
    fs.chmodSync(path.join(repo, 'apply.sh'), 0o755);
    seedQueue(repo, {
      id: 'revert-me',
      kind: 'patch',
      target_files: ['target.txt'],
      apply: 'apply.sh',
      verify: 'true',
      note: 'should revert',
      added: new Date().toISOString(),
    });

    const result = runCli(['experiments', 'daily', '--force', '--json'], repo, benchEnv(repo, {
      baseline: { exitCode: 0, passed: ['a', 'b'], failed: [], skipped: [] },
      candidate: { exitCode: 1, passed: ['a'], failed: ['b'], skipped: [] },
    }));
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.decision, 'reverted');
    assert.deepEqual(fs.readFileSync(path.join(repo, 'target.txt')), original);

    const meta = loadLessonMetadata(repo);
    assert.equal(meta['experiment-revert-me'].status, 'observed');
    assert.equal(meta['experiment-revert-me'].detector, undefined);
  } finally {
    cleanup(base);
  }
});

test('--keep-if all-pass rejects superset with lingering failures', () => {
  const { base, repo } = makeTempRepo();
  try {
    fs.writeFileSync(path.join(repo, 'apply.sh'), '#!/bin/sh\necho "better" >> target.txt\n', 'utf8');
    fs.chmodSync(path.join(repo, 'apply.sh'), 0o755);
    seedQueue(repo, {
      id: 'all-pass',
      kind: 'patch',
      target_files: ['target.txt'],
      apply: 'apply.sh',
      verify: 'true',
      note: '',
      added: new Date().toISOString(),
    });

    const result = runCli(['experiments', 'daily', '--force', '--keep-if', 'all-pass', '--json'], repo, benchEnv(repo, {
      baseline: { exitCode: 0, passed: ['a', 'b'], failed: [], skipped: [] },
      candidate: { exitCode: 1, passed: ['a', 'b', 'c'], failed: ['d'], skipped: [] },
    }));
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.decision, 'reverted');
    assert.equal(payload.keep_reason, 'all_pass_required');
  } finally {
    cleanup(base);
  }
});

test('exit-2 baseline abort leaves state untouched and nothing applied', () => {
  const { base, repo } = makeTempRepo();
  try {
    fs.writeFileSync(path.join(repo, 'apply.sh'), '#!/bin/sh\necho "nope" >> target.txt\n', 'utf8');
    fs.chmodSync(path.join(repo, 'apply.sh'), 0o755);
    seedQueue(repo, {
      id: 'abort-me',
      kind: 'patch',
      target_files: ['target.txt'],
      apply: 'apply.sh',
      verify: null,
      note: '',
      added: new Date().toISOString(),
    });

    const before = fs.readFileSync(path.join(repo, 'target.txt'), 'utf8');
    const result = runCli(['experiments', 'daily', '--force', '--json'], repo, benchEnv(repo, {
      baseline: { exitCode: 2 },
      candidate: { exitCode: 0, passed: ['a'], failed: [], skipped: [] },
    }));
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.error, 'bench_infra_error');
    assert.equal(payload.stage, 'baseline');
    assert.equal(fs.readFileSync(path.join(repo, 'target.txt'), 'utf8'), before);
    assert.equal(fs.existsSync(path.join(repo, '.atris', 'state', 'scorecards.jsonl')), false);
    const state = daily.readDailyState(repo);
    assert.notEqual(state.last_run_date, new Date().toISOString().slice(0, 10));
  } finally {
    cleanup(base);
  }
});

test('integration with real atris bench run', { skip: !fs.existsSync(path.join(repoRoot, 'commands', 'bench.js')) ? 'commands/bench.js not present in this worktree' : false }, () => {
  const { base, repo } = makeTempRepo();
  try {
    fs.writeFileSync(path.join(repo, 'apply.sh'), '#!/bin/sh\ntrue\n', 'utf8');
    fs.chmodSync(path.join(repo, 'apply.sh'), 0o755);
    seedQueue(repo, {
      id: 'real-bench',
      kind: 'patch',
      target_files: ['target.txt'],
      apply: 'apply.sh',
      verify: 'true',
      note: '',
      added: new Date().toISOString(),
    });
    const result = runCli(['experiments', 'daily', '--force', '--json'], repo);
    assert.ok(result.status === 0 || result.status === 1, result.stderr || result.stdout);
  } finally {
    cleanup(base);
  }
});

// [2026-07-07] apply_failed root cause: apply scripts ran via `sh` + polyglot
// `exec node`, which needs node on PATH — overnight cron PATHs lack it, so the
// nightly experiment reverted before its patch ever applied. .js apply scripts
// must run on the CLI's own node binary, PATH-independent.
test('runApplyScript runs .js apply scripts without node on PATH', () => {
  const { runApplyScript } = require('../lib/experiments/daily');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-apply-'));
  const script = path.join(dir, 'apply.js');
  fs.writeFileSync(script, "':' //; exec node \"$0\" \"$@\"\nprocess.exit(0);\n");
  const savedPath = process.env.PATH;
  process.env.PATH = '';
  try {
    const result = runApplyScript(dir, script);
    assert.equal(result.status, 0, result.stderr || String(result.error || ''));
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
