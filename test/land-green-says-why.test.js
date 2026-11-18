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
const { isPullRequestLookup, pullRequestAnswer } = require('./helpers/branch-pull-requests');

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

test('a check that cannot find its tool is could-not-tell with the exit code and the line, and only a could-not-tell count is kept', () => {
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
    // Only a could-not-tell count is kept, so the branch goes last next run.
    assert.equal(state['member/work'].action, 'unknown');
    assert.equal(state['member/work'].reason, 'verify_setup_failed');
    assert.equal(state['member/work'].untold, 1);
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
          command, status: 1, timed_out: false, duration_ms: 1000, timeout_lines: 1, tail: 'Error: Test timed out in 17500ms.',
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
    // The receipt keeps the first red, not only the green rerun.
    assert.equal(greenVerdictRow(verdict).rerun_of.status, 1);
    assert.deepEqual(greenVerdictRow(verdict).rerun_of.failing, ['app/other.test.tsx > slow under load']);

    // A timeout in a file the branch changed is the branch's: no rerun, red.
    const root2 = makeRepo();
    try {
      calls.length = 0;
      const own = () => {
        calls.push(1);
        return {
          command: 'npm test', status: 1, timed_out: false, duration_ms: 1000, timeout_lines: 1, tail: '',
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

// A repo whose test script is check.sh. The base copy runs `base`, the
// branch copy runs `branch`; the branch also adds feature.txt.
function scriptRepo(base, branch, { extra = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-why-'));
  git(root, ['init', '-q', '-b', 'master']);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0', scripts: { test: 'sh ./check.sh' } }));
  fs.writeFileSync(path.join(root, 'check.sh'), base);
  commitAll(root, 'base', new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString());
  git(root, ['checkout', '-q', '-b', 'member/work']);
  fs.writeFileSync(path.join(root, 'check.sh'), branch);
  fs.writeFileSync(path.join(root, 'feature.txt'), 'shipped\n');
  for (const [file, text] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  commitAll(root, 'member/work work', THREE_DAYS_AGO);
  git(root, ['checkout', '-q', 'master']);
  return root;
}

const PR = {
  mergePath: 'pull_request', localCheck: true,
  // No pull request on any branch; gh answers nothing else.
  runGh: (args) => (isPullRequestLookup(args) ? pullRequestAnswer(args) : { ok: false, stdout: '', stderr: 'no gh here' }),
  readEntries: () => [], readQueued: () => null, recordQueued: () => {},
};

const PY_BASE = [
  '#!/bin/sh',
  'echo "tests/test_ok.py ....   [100%]"',
  'echo "ERROR tests/test_ledger_postgres.py - ModuleNotFoundError: No module named psycopg2"',
  'echo "==== 1 error, 4 passed in 0.$$s ===="',
  'exit 1',
  '',
].join('\n');

test('a branch that fails what master fails and also a test the name reader cannot parse is red, not waved through', () => {
  const branch = PY_BASE.replace('echo "====', [
    'echo "FAILED tests/test_reply.py::test_reply_text[hello world] - AssertionError: assert hi == hello world"',
    'echo "====',
  ].join('\n'));
  const root = scriptRepo(PY_BASE, branch);
  try {
    const { verdict, flags } = run(root, { verifyCommand: 'npm test', ...PR });
    assert.equal(verdict.action, 'red');
    assert.deepEqual(verdict.verify.failing, ['tests/test_reply.py::test_reply_text[hello world]']);
    assert.equal(flags.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a branch that fails what master fails plus an unhandled error that names no test is red', () => {
  const base = [
    '#!/bin/sh',
    'echo " FAIL  app/MemberChat.status-lazy.test.tsx > MemberChat > closes it"',
    'echo "AssertionError: expected true to be false"',
    'exit 1',
    '',
  ].join('\n');
  const branch = base.replace('exit 1', [
    'echo "Vitest caught 1 unhandled error during the test run."',
    'echo "TypeError: Cannot read properties of undefined (reading id)"',
    'exit 1',
  ].join('\n'));
  const root = scriptRepo(base, branch);
  try {
    const { verdict, flags } = run(root, { verifyCommand: 'npm test', ...PR });
    assert.equal(verdict.action, 'red');
    assert.match(verdict.detail, /also printed a failure master does not/);
    assert.equal(flags.length, 1);
    assert.match(flags[0][2], /a failure the base does not have/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a branch that fails only what master fails, with the same output but other numbers, is still waved through', () => {
  const root = scriptRepo(PY_BASE, `${PY_BASE}\n# the branch only touches a comment\n`);
  try {
    const { verdict, flags } = run(root, { verifyCommand: 'npm test', ...PR });
    assert.notEqual(verdict.action, 'red');
    assert.deepEqual(verdict.known_red, ['tests/test_ledger_postgres.py']);
    assert.equal(flags.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a branch that breaks the check with a tool it never added is red, and the branch behind it lands', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-why-'));
  try {
    git(root, ['init', '-q', '-b', 'master']);
    const pkg = (test) => JSON.stringify({ name: 'fixture', version: '0.0.0', scripts: { test } });
    fs.writeFileSync(path.join(root, 'package.json'), pkg('echo all good'));
    commitAll(root, 'base', new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString());
    git(root, ['checkout', '-q', '-b', 'member/adds-lint']);
    fs.writeFileSync(path.join(root, 'package.json'), pkg('projlint-nobody-has . && echo all good'));
    commitAll(root, 'add a lint step', new Date(Date.now() - 6 * 24 * 3600 * 1000).toISOString());
    git(root, ['checkout', '-q', 'master']);
    git(root, ['checkout', '-q', '-b', 'member/work']);
    fs.writeFileSync(path.join(root, 'feature.txt'), 'shipped\n');
    commitAll(root, 'healthy work', THREE_DAYS_AGO);
    git(root, ['checkout', '-q', 'master']);

    const first = run(root, { verifyCommand: 'npm test' });
    const lint = first.result.verdicts.find((v) => v.branch === 'member/adds-lint');
    assert.equal(lint.action, 'red');
    assert.equal(lint.verify.status, 127);
    assert.match(lint.detail, /it does run on master, so the branch broke it/);
    const second = run(root, { verifyCommand: 'npm test' });
    assert.equal(second.verdict.action, 'landed');
    assert.ok(fs.existsSync(path.join(root, 'feature.txt')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a named failing test or a passing line that mentions a setup word is red, not a setup problem', () => {
  const node = `"${process.execPath}"`;
  const cases = [
    `${node} -e "console.log('✖ adds two numbers (3ms)'); process.exit(127)"`,
    `${node} -e "console.log('✔ refuses with EPERM: operation not permitted when locked (2ms)'); console.error('src/price.ts(3,5): error TS2322'); process.exit(2)"`,
  ];
  for (const cmd of cases) {
    const root = makeRepo();
    try {
      const { verdict } = run(root, { verifyCommand: cmd });
      assert.equal(verdict.action, 'red', cmd);
      assert.notEqual(verdict.reason, 'verify_setup_failed', cmd);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('a plain assertion failure gets no second run because a passing test title says timed out', () => {
  const counter = path.join(os.tmpdir(), `atris-land-runs-${process.pid}-${Date.now()}.txt`);
  const check = [
    '#!/bin/sh',
    `echo x >> "${counter}"`,
    'echo " ✓ app/banner.test.tsx > shows a banner when the request timed out 4ms"',
    'if [ -f src/price.ts ]; then',
    '  echo " FAIL  app/price.test.ts > rounds half up"',
    '  echo "AssertionError: expected 2 to be 3"',
    '  exit 1',
    'fi',
    'exit 0',
    '',
  ].join('\n');
  const root = scriptRepo(check, check, { extra: { 'src/price.ts': 'export const round = Math.floor;\n' } });
  try {
    const { verdict } = run(root, { verifyCommand: 'npm test' });
    assert.equal(verdict.action, 'red');
    assert.equal(fs.readFileSync(counter, 'utf8').trim().split('\n').length, 1, 'the check ran once');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(counter, { force: true });
  }
});
