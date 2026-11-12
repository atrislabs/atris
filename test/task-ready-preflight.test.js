'use strict';

// `atris task ready --verify` runs a command that can take a minute. Wording the gate would
// refuse anyway must be refused before that run. A bad sentence never costs a test run.
// Each case here uses a verifier that appends a line to a marker file: a marker line means
// the verifier ran, no marker means the refusal came first.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');

const LANDING = 'Someone can trust that a signed-off check would have caught a mistake.';
const RESULT = 'Someone reviewing finished work can trust the check behind it would have failed if the work were wrong.';
const VERIFY = 'git diff --check && node write-marker.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ready-preflight-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"preflight-fixture","version":"1.0.0"}\n');
  fs.writeFileSync(
    path.join(dir, 'write-marker.js'),
    "require('fs').appendFileSync(require('path').join(__dirname, 'marker.txt'), 'ran\\n');\n",
  );
  fs.writeFileSync(
    path.join(dir, 'rename-task.js'),
    "const { spawnSync } = require('child_process');\n"
    + "const [ref, title] = process.argv.slice(2);\n"
    + "const res = spawnSync(process.execPath, [process.env.PREFLIGHT_CLI, 'task', 'retitle', ref, title], { encoding: 'utf8' });\n"
    + "if (res.status !== 0) { console.error(res.stderr || res.stdout); process.exit(1); }\n",
  );
  const env = {
    ...process.env,
    ATRIS_SKIP_UPDATE_CHECK: '1',
    ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
    ATRIS_AGENT_ID: 'tester',
    PREFLIGHT_CLI: cliPath,
  };
  delete env.NODE_TEST_CONTEXT;
  const run = (args) => spawnSync(process.execPath, [cliPath, ...args], { cwd: dir, encoding: 'utf8', env });
  const claimed = (title) => {
    const added = run(['task', 'add', title, '--json']);
    assert.equal(added.status, 0, added.stderr || added.stdout);
    const ref = JSON.parse(added.stdout).task.display_id;
    const claim = run(['task', 'claim', ref, '--as', 'tester']);
    assert.equal(claim.status, 0, claim.stderr || claim.stdout);
    return ref;
  };
  const shownTask = (ref) => {
    const shown = run(['task', 'show', ref, '--json']);
    assert.equal(shown.status, 0, shown.stderr || shown.stdout);
    return JSON.parse(shown.stdout);
  };
  const status = (ref) => shownTask(ref).status;
  const markerLines = () => {
    const file = path.join(dir, 'marker.txt');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;
  };
  const receipts = () => {
    const runs = path.join(dir, 'atris', 'runs');
    return fs.existsSync(runs) ? fs.readdirSync(runs).filter((name) => name.endsWith('.json')) : [];
  };
  return { dir, run, claimed, status, shownTask, markerLines, receipts };
}

function assertRefusedBeforeVerifier(f, ref, res, { code, pattern }) {
  assert.equal(res.status, code, res.stderr || res.stdout);
  assert.match(res.stderr, pattern);
  assert.equal(f.markerLines(), 0, 'the verifier ran before the refusal');
  assert.deepEqual(f.receipts(), [], 'a receipt was written before the refusal');
  assert.equal(f.status(ref), 'claimed', 'the refused task changed state');
}

test('a result sentence the gate refuses is refused before the verifier runs', (t) => {
  const f = fixture(t);
  const ref = f.claimed('refuse a weak result before the check runs');
  const res = f.run(['task', 'ready', ref, '--verify', VERIFY, '--landing', LANDING, '--result', 'Fixed it.', '--as', 'tester']);
  assertRefusedBeforeVerifier(f, ref, res, { code: 2, pattern: /too short/ });
});

test('a proof that names a command the verifier did not run is refused before the verifier runs', (t) => {
  const f = fixture(t);
  const ref = f.claimed('refuse a proof naming an unrun command');
  const res = f.run([
    'task', 'ready', ref,
    '--proof', 'npm test passed',
    '--verify', 'node write-marker.js', '--no-falsify-check',
    '--landing', LANDING, '--result', RESULT, '--as', 'tester',
  ]);
  assertRefusedBeforeVerifier(f, ref, res, { code: 2, pattern: /did not run it/ });
});

test('a landing sentence the gate refuses is refused before the verifier runs', (t) => {
  const f = fixture(t);
  const ref = f.claimed('refuse a weak landing before the check runs');
  const res = f.run([
    'task', 'ready', ref,
    '--verify', VERIFY,
    '--landing', 'Updated the --verify flag in task-db.js.',
    '--result', RESULT, '--as', 'tester',
  ]);
  assertRefusedBeforeVerifier(f, ref, res, { code: 2, pattern: /landing needs one plain sentence/ });
});

test('a verifier the gate calls weak is refused before it runs', (t) => {
  const f = fixture(t);
  const ref = f.claimed('refuse a bare file exists check before it runs');
  // A file-exists check cannot write the marker. The receipt it would leave is the witness.
  const res = f.run(['task', 'ready', ref, '--verify', 'test -f package.json', '--landing', LANDING, '--result', RESULT, '--as', 'tester']);
  assertRefusedBeforeVerifier(f, ref, res, { code: 1, pattern: /weak verifier/ });
});

test('an actor name the gate refuses is refused before the verifier runs', (t) => {
  const f = fixture(t);
  const ref = f.claimed('refuse a reserved actor before the check runs');
  const res = f.run(['task', 'ready', ref, '--verify', VERIFY, '--landing', LANDING, '--result', RESULT, '--as', 'autoland-verifier']);
  assertRefusedBeforeVerifier(f, ref, res, { code: 1, pattern: /reserved_actor/ });
});

test('a task that does not exist is refused before the verifier runs', (t) => {
  const f = fixture(t);
  f.claimed('keep the board non empty so the lookup is real');
  const res = f.run(['task', 'ready', 'NOPE-999', '--verify', VERIFY, '--landing', LANDING, '--result', RESULT, '--as', 'tester']);
  assert.notEqual(res.status, 0, res.stdout);
  assert.equal(f.markerLines(), 0, 'the verifier ran for a task that does not exist');
  assert.deepEqual(f.receipts(), [], 'a receipt was written for a task that does not exist');
});

test('valid text still runs the verifier exactly once with its receipt kept and the task handed in', (t) => {
  const f = fixture(t);
  const ref = f.claimed('hand in work whose text is fine');
  const res = f.run(['task', 'ready', ref, '--verify', VERIFY, '--landing', LANDING, '--result', RESULT, '--as', 'tester']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.equal(f.markerLines(), 1, 'the verifier should run exactly once');
  assert.equal(f.status(ref), 'review');
  const receipts = f.receipts();
  assert.equal(receipts.length, 1, `expected one receipt, got ${receipts.join(', ')}`);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.dir, 'atris', 'runs', receipts[0]), 'utf8'));
  assert.equal(receipt.command, VERIFY);
  assert.equal(receipt.result.passed, true);
  assert.match(res.stdout, new RegExp(receipts[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('a landing sentence that only matches the title after the verifier renamed the task is refused', (t) => {
  const f = fixture(t);
  const ref = f.claimed('hand in work whose title changes mid run');
  const renamed = 'Someone can now see which reviews still need a check because the list is plain';
  const res = f.run([
    'task', 'ready', ref,
    '--verify', `git diff --check && node rename-task.js ${ref} "${renamed}"`,
    '--landing', `Completed: ${renamed}.`,
    '--result', RESULT, '--as', 'tester',
  ]);
  assert.equal(res.status, 2, res.stderr || res.stdout);
  assert.match(res.stderr, /landing needs one plain sentence/);
  const task = f.shownTask(ref);
  assert.equal(task.title, renamed, 'the verifier should have renamed the task');
  assert.equal(task.status, 'claimed', 'the refused task changed state');
  assert.equal(f.receipts().length, 1, 'the verifier ran once before the landing was checked against the new title');
});

test('a verifier that fails still writes its receipt and leaves the task claimed', (t) => {
  const f = fixture(t);
  const ref = f.claimed('keep the failing check path as it was');
  const res = f.run([
    'task', 'ready', ref,
    '--verify', 'node write-marker.js && node -e "process.exit(3)"', '--no-falsify-check',
    '--landing', LANDING, '--result', RESULT, '--as', 'tester',
  ]);
  assert.equal(res.status, 1, res.stderr || res.stdout);
  assert.match(res.stderr, /verifier failed \(exit 3\)/);
  assert.equal(f.markerLines(), 1);
  assert.equal(f.receipts().length, 1);
  assert.equal(f.status(ref), 'claimed');
});
