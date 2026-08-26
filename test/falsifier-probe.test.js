'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { probeVerifierCanFail, absolutePathIn } = require('../lib/falsifier-probe');

const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');

test('a check that passes with none of the work present is caught', () => {
  for (const cmd of ['true', 'echo done', 'exit 0', 'test 1 -eq 1']) {
    const probe = probeVerifierCanFail({ command: cmd });
    assert.equal(probe.probed, true, cmd);
    assert.equal(probe.canFail, false, cmd);
    assert.match(probe.reason, /passes in an empty directory/);
  }
});

test('a check anchored to the codebase fails without it, which is the point', () => {
  for (const cmd of ['node --test test/falsifier-probe.test.js', 'npm run test:nothing', 'test -f package.json']) {
    const probe = probeVerifierCanFail({ command: cmd });
    assert.equal(probe.probed, true, cmd);
    assert.equal(probe.canFail, true, cmd);
    assert.notEqual(probe.exit, 0, cmd);
  }
});

test('an absolute path is reported as unprobeable instead of getting a false verdict', () => {
  const probe = probeVerifierCanFail({ command: 'cd /Users/someone/repo && npm test' });
  assert.equal(probe.probed, false);
  assert.equal(probe.canFail, null);
  assert.match(probe.reason, /absolute path/);
  assert.equal(absolutePathIn('cd /Users/someone/repo && npm test'), '/Users/someone/repo');
  assert.equal(absolutePathIn('npm test'), '');
});

test('the probe leaves no directory behind, on either verdict', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-parent-'));
  try {
    probeVerifierCanFail({ command: 'true', tmpRoot });
    probeVerifierCanFail({ command: 'exit 3', tmpRoot });
    assert.deepEqual(fs.readdirSync(tmpRoot), []);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('a command that cannot start is reported, not counted as a verdict', () => {
  const probe = probeVerifierCanFail({
    command: 'npm test',
    runner: () => ({ error: new Error('spawn ENOENT') }),
  });
  assert.equal(probe.probed, false);
  assert.equal(probe.canFail, null);
  assert.match(probe.reason, /could not start/);
});

test('task ready refuses a verifier that cannot fail, and takes the same work with a real one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-falsify-cli-'));
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  try {
    const env = {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
      ATRIS_AGENT_ID: 'tester',
    };
    const run = (args) => spawnSync(process.execPath, [cliPath, ...args], { cwd: dir, encoding: 'utf8', env });
    spawnSync('git', ['init', '-q'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"probe-fixture","version":"1.0.0"}\n');
    fs.writeFileSync(path.join(dir, 'ok.js'), 'module.exports = 1;\n');

    const added = run(['task', 'add', 'prove the checker refuses a check that cannot fail', '--json']);
    assert.equal(added.status, 0, added.stderr || added.stdout);
    const ref = JSON.parse(added.stdout).task.display_id;
    assert.equal(run(['task', 'claim', ref, '--as', 'tester']).status, 0);

    const landing = 'Someone can trust that a signed-off check would have caught a mistake.';
    const result = 'Someone reviewing finished work can trust the check behind it would have failed if the work were wrong, so the record means something.';

    const fake = run(['task', 'ready', ref, '--verify', 'true', '--landing', landing, '--result', result, '--as', 'tester']);
    assert.equal(fake.status, 1, fake.stdout);
    assert.match(fake.stderr, /this check cannot fail/);

    const real = run(['task', 'ready', ref, '--verify', 'node --check ok.js', '--landing', landing, '--result', result, '--as', 'tester']);
    assert.equal(real.status, 0, real.stderr || real.stdout);

    const weak = run(['task', 'add', 'refuse a bare file-exists verifier', '--json']);
    assert.equal(weak.status, 0, weak.stderr || weak.stdout);
    const weakRef = JSON.parse(weak.stdout).task.display_id;
    assert.equal(run(['task', 'claim', weakRef, '--as', 'tester']).status, 0);
    const fileOnly = run(['task', 'ready', weakRef, '--verify', 'test -f package.json', '--landing', landing, '--result', result, '--as', 'tester']);
    assert.equal(fileOnly.status, 1, fileOnly.stdout);
    assert.match(fileOnly.stderr, /weak verifier|file-exists/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
