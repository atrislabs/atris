'use strict';

// CLI-879: tags were only settable at task creation, so an open task that
// becomes an owner decision (live case: BCK-1248 EFS mount) could not be
// flagged needs-human and fleets kept restaffing it. `atris task tag <id>
// --add <tag> [--remove <tag>]` updates tags on an existing task with an
// event logged; sweep and fleet staffing both honor a needs-human tag added
// this way.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const fleet = require('../lib/fleet');

function hasNodeSqlite() {
  const result = spawnSync(process.execPath, ['-e', 'require("node:sqlite")'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return result.status === 0;
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-tag-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      NODE_NO_WARNINGS: '1',
      ...(env || {}),
    },
  });
  if (result.error) throw result.error;
  return result;
}

function makeEnv(dir) {
  return {
    ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
    NODE_NO_WARNINGS: '1',
    ATRIS_AGENT_PROOF_ONLY: '0',
  };
}

function writeReceipt(dir, name, result) {
  const rel = path.join('atris', 'runs', name);
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), JSON.stringify({
    schema: 'atris.mission_receipt.v1',
    mission_id: `mission-${name.replace(/\.json$/, '')}`,
    result,
  }, null, 2) + '\n', 'utf8');
  return rel;
}

function verifiedProof(receiptRel) {
  return `${'context '.repeat(35)}Verifier receipt ${receiptRel} shows the verify passed. Checks: receipt ${receiptRel}; node --test test/task-tag.test.js passed; git diff --check passed.`;
}

function setupReadyTask(dir, env, { title, tag, proof }) {
  const created = runCli(['task', 'new', title, '--tag', tag, '--json'], { cwd: dir, env });
  assert.equal(created.status, 0, created.stderr);
  const task = JSON.parse(created.stdout).task;
  assert.equal(runCli(['task', 'claim', task.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
  const ready = runCli([
    'task', 'ready', task.display_id,
    '--proof', proof,
    '--happened', `Rendered ${title}`,
    '--checked', 'I checked the receipt verifier state before Review.',
    '--tested', 'I inspected the receipt JSON and the named verifier.',
    '--as', 'codex',
    '--json',
  ], { cwd: dir, env });
  assert.equal(ready.status, 0, ready.stderr);
  return task;
}

test('atris task tag --add records a tag on an existing task and logs an event', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const env = makeEnv(dir);
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const created = runCli(['task', 'new', 'Mount the EFS volume for BCK-1248', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const task = JSON.parse(created.stdout).task;

    const tagged = runCli(['task', 'tag', task.display_id, '--add', 'needs-human', '--as', 'keshav', '--json'], { cwd: dir, env });
    assert.equal(tagged.status, 0, tagged.stderr);
    const payload = JSON.parse(tagged.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.action, 'tagged');
    assert.deepEqual(payload.added, ['needs-human']);
    assert.deepEqual(payload.tags, ['needs-human']);

    const shown = JSON.parse(runCli(['task', 'show', task.display_id, '--json'], { cwd: dir, env }).stdout);
    assert.deepEqual(shown.metadata.tags, ['needs-human']);

    const events = JSON.parse(runCli(['task', 'events', task.display_id, '--json'], { cwd: dir, env }).stdout).events;
    const tagEvent = events.find((event) => event.event_type === 'task_tags_updated');
    assert.ok(tagEvent, 'expected a task_tags_updated event');
    assert.equal(tagEvent.actor, 'keshav');
    assert.deepEqual(tagEvent.payload.added, ['needs-human']);
    assert.deepEqual(tagEvent.payload.tags, ['needs-human']);
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris task tag --add/--remove merges, dedupes, and normalizes existing tags', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const env = makeEnv(dir);
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const task = JSON.parse(runCli(['task', 'new', 'Owner decision on rollout', '--json'], { cwd: dir, env }).stdout).task;

    runCli(['task', 'tag', task.display_id, '--add', 'needs-human', '--add', 'billing', '--json'], { cwd: dir, env });
    // Re-adding an existing tag is a no-op; removing one drops it.
    const second = JSON.parse(runCli([
      'task', 'tag', task.display_id, '--add', 'NEEDS-HUMAN', '--remove', 'billing', '--json',
    ], { cwd: dir, env }).stdout);
    assert.equal(second.action, 'tagged');
    assert.deepEqual(second.added, []);
    assert.deepEqual(second.removed, ['billing']);
    assert.deepEqual(second.tags, ['needs-human']);

    // Adding a tag already present makes no change and logs nothing new.
    const noop = JSON.parse(runCli(['task', 'tag', task.display_id, '--add', 'needs-human', '--json'], { cwd: dir, env }).stdout);
    assert.equal(noop.action, 'unchanged');
    assert.deepEqual(noop.tags, ['needs-human']);
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris task tag requires an id and at least one --add/--remove', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const env = makeEnv(dir);
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const task = JSON.parse(runCli(['task', 'new', 'Something', '--json'], { cwd: dir, env }).stdout).task;
    const noTags = runCli(['task', 'tag', task.display_id, '--json'], { cwd: dir, env });
    assert.notEqual(noTags.status, 0);
    assert.match(noTags.stdout + noTags.stderr, /add|remove/i);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task sweep --auto-accept honors a needs-human tag added after creation', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const env = makeEnv(dir);
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const acceptReceipt = writeReceipt(dir, 'tag-accept-receipt.json', { verifier_result: { passed: true } });
    const holdReceipt = writeReceipt(dir, 'tag-hold-receipt.json', { verifier_result: { passed: true } });

    // Control: an identically-verified review task with no hold flag.
    const control = setupReadyTask(dir, env, {
      title: 'Refresh the settings copy',
      tag: 'agent',
      proof: verifiedProof(acceptReceipt),
    });
    // The live case: verified review task flagged needs-human AFTER creation.
    const held = setupReadyTask(dir, env, {
      title: 'Provision the EFS mount for BCK-1248',
      tag: 'agent',
      proof: verifiedProof(holdReceipt),
    });
    assert.equal(runCli(['task', 'tag', held.display_id, '--add', 'needs-human', '--as', 'keshav', '--json'], { cwd: dir, env }).status, 0);

    const sweep = runCli(['task', 'sweep', '--auto-accept', '--json'], { cwd: dir, env });
    assert.equal(sweep.status, 0, sweep.stderr);
    const payload = JSON.parse(sweep.stdout);
    assert.equal(payload.summary.accepted, 1);
    assert.equal(payload.summary.skipped, 1);
    const heldResult = payload.results.find((row) => row.ref === held.display_id);
    assert.ok(heldResult, 'expected the held task in sweep results');
    assert.equal(heldResult.action, 'skipped');
    assert.equal(heldResult.reason, 'needs_human');

    assert.equal(JSON.parse(runCli(['task', 'show', held.display_id, '--json'], { cwd: dir, env }).stdout).status, 'review');
    assert.equal(JSON.parse(runCli(['task', 'show', control.display_id, '--json'], { cwd: dir, env }).stdout).status, 'done');
  } finally {
    cleanupTempDir(dir);
  }
});

test('fleet staffing skips a task flagged needs-human via metadata.tags', () => {
  const base = {
    display_id: 'CLI-901',
    status: 'open',
    title: 'Wire up the widget in commands/widget.js. Done: it renders. Check: node --test test/widget.test.js.',
  };
  // Without the flag, the task is safe-lane and gets staffed.
  const staffedOpen = fleet.staffFlight([base], { slots: 3 });
  assert.equal(staffedOpen.length, 1);
  assert.equal(fleet.isSafeLane(base), true);

  // A needs-human tag added via `atris task tag` lands in metadata.tags; the
  // fleet must read it there and refuse to staff the task.
  const held = { ...base, metadata: { tags: ['needs-human'] } };
  assert.equal(fleet.isSafeLane(held), false);
  assert.equal(fleet.staffFlight([held], { slots: 3 }).length, 0);

  // The underscore spelling normalizes to the same hold.
  assert.equal(fleet.isSafeLane({ ...base, metadata: { tags: ['needs_human'] } }), false);
  assert.equal(fleet.isHumanHoldTag('NEEDS-HUMAN'), true);
});
