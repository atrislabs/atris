// The npm read-back after a release, replayed on recorded real outputs.
//
// Fixtures in test/fixtures/npm-publish-readback/ are trimmed copies of real
// output, timestamps and tarball file lists removed:
// - accepted-processing.publish.txt: the publish step of release 3.83.4 on
//   2026-11-15. npm accepted it, then took 55 minutes to show it, and the old
//   30 minute wait marked the shipped release failed.
// - accepted-visible.publish.txt: the publish step of release 3.83.5.
// - rejected.publish.txt: npm refusing 3.82.20 on 2026-11-12 (exit 1).
// - view-visible.stdout.txt: npm view atris@3.83.5 version --json.
// - view-missing.*.txt: npm view of a version npm does not have (exit 1, E404).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const fixtures = path.join(__dirname, 'fixtures', 'npm-publish-readback');
const script = path.join(__dirname, '..', 'scripts', 'npm-publish-readback.js');
const read = (name) => fs.readFileSync(path.join(fixtures, name), 'utf8');

const accepted = (name) => ({ status: 0, stdout: '', stderr: read(name) });
const rejected = () => ({ status: 1, stdout: '', stderr: read('rejected.publish.txt') });
const viewVisible = () => ({ status: 0, stdout: read('view-visible.stdout.txt'), stderr: '' });
const viewMissing = () => ({ status: 1, stdout: read('view-missing.stdout.txt'), stderr: read('view-missing.stderr.txt') });

function capture(fn) {
  const out = [];
  const err = [];
  const o = process.stdout.write;
  const e = process.stderr.write;
  process.stdout.write = (c) => { out.push(String(c)); return true; };
  process.stderr.write = (c) => { err.push(String(c)); return true; };
  try {
    return { value: fn(), stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
}

// A fake npm: the duplicate check sees nothing, publish returns the recorded
// output, and every later exact-version read returns the recorded view.
function fakeNpm(publish, view) {
  const calls = [];
  let published = false;
  const runner = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (args[0] === 'publish') { published = true; return publish(); }
    if (args[0] === 'view') return published ? view() : viewMissing();
    throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
  };
  return { runner, calls };
}

test('release 3.83.4: accepted and still processing ends green within a few minutes', () => {
  const { publishAtrisRelease } = require('../scripts/publish-atris-release');
  const { runner, calls } = fakeNpm(() => accepted('accepted-processing.publish.txt'), viewMissing);
  const sleeps = [];
  const run = capture(() => publishAtrisRelease([], runner, {
    version: '3.83.4',
    verificationSleep: (ms) => sleeps.push(ms),
  }));
  assert.equal(run.value, 0, run.stderr);
  assert.match(run.stdout, /npm accepted atris@3\.83\.4 and is still processing it/);
  const waitedMs = sleeps.reduce((a, b) => a + b, 0);
  assert.ok(waitedMs <= 3 * 60 * 1000, `waited ${waitedMs} ms`);
  // reads the exact version, never the latest tag
  const reads = calls.filter((c) => c.startsWith('npm view'));
  assert.ok(reads.length > 1);
  assert.ok(reads.every((c) => c.startsWith('npm view atris@3.83.4 ')), reads.join('\n'));
});

test('release 3.83.5: accepted and visible ends green on the first read', () => {
  const { publishAtrisRelease } = require('../scripts/publish-atris-release');
  const { runner, calls } = fakeNpm(() => accepted('accepted-visible.publish.txt'), viewVisible);
  const run = capture(() => publishAtrisRelease([], runner, { version: '3.83.5', verificationSleep: () => {} }));
  assert.equal(run.value, 0, run.stderr);
  assert.match(run.stdout, /npm shows atris@3\.83\.5/);
  assert.equal(calls.filter((c) => c.startsWith('npm view')).length, 2);
});

test('a publish npm rejected still fails', () => {
  const { publishAtrisRelease } = require('../scripts/publish-atris-release');
  const { runner, calls } = fakeNpm(rejected, viewMissing);
  const run = capture(() => publishAtrisRelease([], runner, { version: '3.82.20', verificationSleep: () => {} }));
  assert.equal(run.value, 1);
  assert.match(run.stderr, /npm rejected atris@3\.82\.20: You cannot publish over the previously published versions: 3\.82\.20\./);
  assert.equal(calls.filter((c) => c.startsWith('npm view')).length, 1, 'no read-back after a rejection');
});

test('the script decides the three recorded cases from files', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'readback-'));
  try {
    const run = (version, publishFile, publishStatus, viewOut, viewErr, viewStatus) => spawnSync(process.execPath, [
      script, 'decide', version,
      '--publish-status', String(publishStatus), '--publish-output', path.join(fixtures, publishFile),
      '--view-status', String(viewStatus),
      '--view-stdout', path.join(fixtures, viewOut),
      '--view-stderr', viewErr ? path.join(fixtures, viewErr) : path.join(dir, 'none'),
    ], { encoding: 'utf8', cwd: dir });
    const visible = run('3.83.5', 'accepted-visible.publish.txt', 0, 'view-visible.stdout.txt', null, 0);
    assert.equal(visible.status, 0, visible.stderr);
    assert.equal(visible.stdout.trim(), 'npm shows atris@3.83.5.');
    const processing = run('3.83.4', 'accepted-processing.publish.txt', 0, 'view-missing.stdout.txt', 'view-missing.stderr.txt', 1);
    assert.equal(processing.status, 0, processing.stderr);
    assert.match(processing.stdout.trim(), /^npm accepted atris@3\.83\.4 and is still processing it/);
    const refused = run('3.82.20', 'rejected.publish.txt', 1, 'view-missing.stdout.txt', 'view-missing.stderr.txt', 1);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /^npm rejected atris@3\.82\.20: You cannot publish over/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the exact-version read sorts visible, missing and unclear answers', () => {
  const { readExactVersion } = require('../scripts/npm-publish-readback');
  assert.equal(readExactVersion('3.83.5', () => viewVisible()), 'visible');
  assert.equal(readExactVersion('3.83.99', () => viewMissing()), 'missing');
  assert.equal(readExactVersion('3.83.5', () => ({ status: 0, stdout: '"3.83.4"\n' })), 'missing');
  assert.equal(readExactVersion('3.83.5', () => ({ status: 1, stderr: 'npm error code ETIMEDOUT\n' })), 'unknown');
});

test('the follow-up wait stops as soon as the exact version shows', () => {
  const { waitForVersion } = require('../scripts/npm-publish-readback');
  const answers = [viewMissing, viewMissing, viewVisible];
  const sleeps = [];
  const result = waitForVersion('3.83.5', () => answers.shift()(), {
    minutes: 90, everySeconds: 30, sleep: (ms) => sleeps.push(ms), log: () => {},
  });
  assert.equal(result.state, 'visible');
  assert.equal(result.tries, 3);
  assert.deepEqual(sleeps, [30000, 30000]);
});

test('the follow-up wait gives up after its window', () => {
  const { waitForVersion } = require('../scripts/npm-publish-readback');
  let tries = 0;
  const result = waitForVersion('3.83.4', () => { tries += 1; return viewMissing(); }, {
    minutes: 2, everySeconds: 30, sleep: () => {}, log: () => {},
  });
  assert.equal(result.state, 'missing');
  assert.equal(tries, 5);
});

test('the workflow lists the MCP registry in a follow-up job that waits for the exact version', () => {
  const wf = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'publish.yml'), 'utf8');
  const publishJob = wf.slice(wf.indexOf('  publish:'), wf.indexOf('  mcp-registry:'));
  const followUp = wf.slice(wf.indexOf('  mcp-registry:'));
  assert.ok(wf.indexOf('  mcp-registry:') > 0, 'follow-up job exists');
  assert.doesNotMatch(publishJob, /mcp-publisher/);
  assert.match(publishJob, /timeout-minutes:\s*15/);
  assert.match(followUp, /needs:\s*publish/);
  assert.match(followUp, /continue-on-error:\s*true/);
  assert.match(followUp, /node scripts\/npm-publish-readback\.js wait/);
  assert.ok(followUp.indexOf('npm-publish-readback.js wait') < followUp.indexOf('./mcp-publisher publish'));
});
