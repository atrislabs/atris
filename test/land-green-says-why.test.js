'use strict';

// A branch is never marked red without a reason a person can act on, and a
// check that never reached the branch's code is not held against it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { landStaleGreenBranches, failingLines, flagWhat } = require('../lib/land-green');
const { greenVerdictRow } = require('../commands/autoland');

const THREE_DAYS_AGO = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();

function git(cwd, args, env = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function commitAll(cwd, message, when) {
  git(cwd, ['add', '-A']);
  git(cwd, ['-c', 'user.name=Bench Author', '-c', 'user.email=bench@example.com', 'commit', '-q', '-m', message], {
    GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when,
  });
}

// A repo with one stale branch that adds feature.txt.
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-why-'));
  git(root, ['init', '-q', '-b', 'master']);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }));
  commitAll(root, 'base', new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString());
  git(root, ['checkout', '-q', '-b', 'member/work']);
  fs.writeFileSync(path.join(root, 'feature.txt'), 'shipped\n');
  commitAll(root, 'member/work work', THREE_DAYS_AGO);
  git(root, ['checkout', '-q', 'master']);
  return root;
}

function run(root, opts) {
  const flags = [];
  const stateFile = path.join(root, '.git', 'atris-land-green.json');
  const result = landStaleGreenBranches(root, {
    push: false, stateFile, runCli: (args) => { flags.push(args); return { status: 0, stdout: '' }; }, ...opts,
  });
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')).branches : {};
  return { result, flags, state, verdict: result.verdicts.find((v) => v.branch === 'member/work') };
}

test('vitest and pytest failures are named, not only node test runner lines', () => {
  const out = [
    ' ✓ app/ok.test.tsx (3 tests) 20ms',
    '   × a second press while it loads closes it 17502ms',
    ' FAIL  app/dashboard/preview/MemberChat.status-lazy.test.tsx > MemberChat > a second press while it loads closes it',
    'FAILED tests/test_agent_ledger.py::test_writes_once - AssertionError: 1 != 2',
    'ERROR tests/test_agent_ledger_postgres.py - ModuleNotFoundError: No module named psycopg2',
    '\u001b[31m FAIL \u001b[39m app/colored.test.ts > shows red',
  ].join('\n');
  assert.deepEqual(failingLines(out), [
    'a second press while it loads closes it',
    'app/dashboard/preview/MemberChat.status-lazy.test.tsx > MemberChat > a second press while it loads closes it',
    'tests/test_agent_ledger.py::test_writes_once',
    'tests/test_agent_ledger_postgres.py',
    'app/colored.test.ts > shows red',
  ]);
});

test('a check that cannot find its tool is could-not-tell with the exit code and the line, and nothing is kept against the branch', () => {
  const root = makeRepo();
  try {
    const { result, flags, state, verdict } = run(root, { verifyCommand: 'atris-tool-that-is-not-installed --run' });
    assert.equal(verdict.action, 'unknown');
    assert.equal(verdict.reason, 'verify_setup_failed');
    assert.equal(verdict.verify.status, 127);
    assert.match(verdict.detail, /exit 127/);
    assert.match(verdict.detail, /not found/);
    assert.match(verdict.detail, /missing tool or setup problem on this computer, not the branch/);
    assert.deepEqual(result.red, []);
    assert.deepEqual(result.could_not_tell, ['member/work']);
    assert.equal(flags.length, 0, 'no close flag for a setup problem');
    assert.equal(state['member/work'], undefined, 'nothing recorded against the branch');
    const row = greenVerdictRow(verdict);
    assert.equal(row.exit_code, 127);
    assert.match(row.error_line, /not found/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('npm with no test script is a setup problem, not a red branch', () => {
  const root = makeRepo();
  try {
    const { verdict, flags } = run(root, { verifyCommand: 'npm test' });
    assert.equal(verdict.action, 'unknown');
    assert.equal(verdict.reason, 'verify_setup_failed');
    assert.match(verdict.detail, /Missing script/);
    assert.equal(flags.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a red check that names no failing test carries its exit code and first error line to the verdict, the receipt and the flag', () => {
  const root = makeRepo();
  try {
    const cmd = `"${process.execPath}" -e "console.log('building'); console.error('Error: the bundle step broke on feature.txt'); console.log('done'); process.exit(2)"`;
    const { verdict, flags } = run(root, { verifyCommand: cmd });
    assert.equal(verdict.action, 'red');
    assert.match(verdict.detail, /exited with code 2 and named no failing test: Error: the bundle step broke on feature\.txt/);
    const row = greenVerdictRow(verdict);
    assert.equal(row.exit_code, 2);
    assert.equal(row.error_line, 'Error: the bundle step broke on feature.txt');
    assert.equal(flags.length, 1);
    assert.match(flags[0][2], /the verify command failed \(exit 2\): Error: the bundle step broke/);
    assert.match(flagWhat(verdict), /exit 2/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a timeout only in files the branch never touched gets one more run, and a green rerun lands', () => {
  const root = makeRepo();
  try {
    const calls = [];
    const flaky = (command, cwd, opts) => {
      calls.push(opts);
      if (calls.length === 1) {
        return {
          command, status: 1, timed_out: false, duration_ms: 1000, mentions_timeout: true, tail: 'Error: Test timed out in 17500ms.',
          failing: ['app/other.test.tsx > slow under load'], failing_all: ['app/other.test.tsx > slow under load'], error_line: 'Error: Test timed out in 17500ms.',
        };
      }
      return { command, status: 0, timed_out: false, duration_ms: 1000, failing: [], failing_all: [], tail: '', error_line: '' };
    };
    const { verdict, flags } = run(root, { verifyCommand: 'npm test', runVerifyFn: flaky });
    assert.equal(calls.length, 2);
    assert.equal(verdict.action, 'landed');
    assert.equal(verdict.verify.rerun_of.status, 1);
    assert.equal(flags.length, 0);

    // A timeout in a file the branch changed is the branch's: no rerun, red.
    const root2 = makeRepo();
    try {
      calls.length = 0;
      const own = () => {
        calls.push(1);
        return {
          command: 'npm test', status: 1, timed_out: false, duration_ms: 1000, mentions_timeout: true, tail: '',
          failing: ['feature.txt > hangs'], failing_all: ['feature.txt > hangs'], error_line: 'Error: Test timed out in 17500ms.',
        };
      };
      const second = run(root2, { verifyCommand: 'npm test', runVerifyFn: own });
      assert.equal(calls.length, 1);
      assert.equal(second.verdict.action, 'red');
    } finally {
      fs.rmSync(root2, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the local check is told where the main checkout is', () => {
  const root = makeRepo();
  const out = path.join(os.tmpdir(), `atris-land-root-${process.pid}-${Date.now()}.txt`);
  try {
    const cmd = `"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1], process.env.ATRIS_LAND_ROOT || '')" "${out}"`;
    const { verdict } = run(root, { verifyCommand: cmd });
    assert.ok(verdict.verify, 'the check ran');
    assert.equal(fs.readFileSync(out, 'utf8'), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(out, { force: true });
  }
});
