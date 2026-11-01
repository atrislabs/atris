'use strict';

// cmdCertifyVerified is the second check: it re-runs a review job's named check
// as a different actor and certifies the job when that check passes. These
// tests use the real task database and projection code in a throwaway project
// folder. They cover the empty queue, the dry run, the builder guard, and the
// limit. None of them reaches the step that spawns the check command.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const taskDb = require('../lib/task-db');
const { cmdCertifyVerified } = require('../commands/task');

const BUILDER = 'codex';
const VERIFY = 'node --test test/pass.test.js';
const PROJECTION = path.join('.atris', 'state', 'tasks.projection.json');

// Run fn inside a fresh project folder with its own task database. HOME, the
// working folder, and the ATRIS_* env vars all point at or are cleared to the
// throwaway folder, and everything is restored afterwards.
function withProject(fn) {
  const savedCwd = process.cwd();
  const savedEnv = { ...process.env };
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-certify-verified-')));
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = base;
    process.env.ATRIS_TASKS_DB = path.join(base, 'tasks.db');
    // A workspace marker, so the workspace root resolves to this folder.
    fs.mkdirSync(path.join(base, 'atris'));
    fs.writeFileSync(path.join(base, 'atris', 'atris.md'), '# fixture\n');
    process.chdir(base);
    taskDb.close();
    const db = taskDb.open(process.env.ATRIS_TASKS_DB);
    return fn({ base, db });
  } finally {
    taskDb.close();
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// A proof long enough to pass the proof gate, ending with the check it names.
function proofWith(text) {
  return `${'context '.repeat(35)}Checks: ${text} passed.`;
}

// A job the builder finished with one pass, waiting in review for a second
// check. `order` fixes updated_at so the queue order never depends on the clock.
function reviewJob(fx, title, proof, { metadata = {}, order }) {
  const id = taskDb.addTask(fx.db, { title, workspaceRoot: fx.base, tag: 'test', metadata }).id;
  assert.strictEqual(taskDb.claimTask(fx.db, { id, claimedBy: BUILDER }).claimed, true);
  assert.strictEqual(taskDb.readyTask(fx.db, { id, actor: BUILDER, proof }).ready, true);
  fx.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(order, id);
  return id;
}

function quietly(fn) {
  const lines = [];
  const log = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    return { value: fn(), lines };
  } finally {
    console.log = log;
  }
}

test('an empty queue certifies nothing and says so in plain words', () => {
  withProject(({ base }) => {
    const { value: payload, lines } = quietly(() => cmdCertifyVerified([]));

    assert.deepStrictEqual(lines, ['certify-verified: no review rows to consider.']);
    assert.strictEqual(payload.ok, true);
    assert.strictEqual(payload.action, 'certify_verified');
    assert.strictEqual(payload.actor, 'autoland-verifier');
    assert.strictEqual(payload.certified, 0);
    assert.strictEqual(payload.failed, 0);
    assert.deepStrictEqual(payload.results, []);
    // A live pass writes the projection file into the folder it runs from.
    assert.strictEqual(payload.projection_path, path.join(base, PROJECTION));
    assert.strictEqual(fs.existsSync(payload.projection_path), true);
  });
});

test('a dry run names the check it would re-run and writes nothing', () => {
  withProject((fx) => {
    const id = reviewJob(fx, 'Builder finished the parser', proofWith(VERIFY), {
      metadata: { verify: VERIFY },
      order: 1000,
    });

    const payload = cmdCertifyVerified([], { preview: true, silent: true });

    assert.strictEqual(payload.action, 'certify_verified_dry_run');
    assert.strictEqual(payload.would_certify, 1);
    assert.strictEqual(payload.certified, 0);
    assert.strictEqual(payload.projection_path, null);
    assert.deepStrictEqual(payload.results.map((r) => [r.action, r.verify]), [['would_certify', VERIFY]]);
    // Nothing was stamped: the job is still waiting, with no check on record.
    const row = taskDb.getTask(fx.db, id);
    assert.strictEqual(row.status, 'review');
    assert.strictEqual(row.metadata.verify_cache, undefined);
    assert.strictEqual(row.metadata.certified_verified_at, undefined);
    assert.strictEqual(fs.existsSync(path.join(fx.base, PROJECTION)), false);
  });
});

test('the builder cannot be its own second check', () => {
  withProject((fx) => {
    reviewJob(fx, 'Builder finished the parser', proofWith(VERIFY), {
      metadata: { verify: VERIFY },
      order: 1000,
    });

    const payload = cmdCertifyVerified(['--as', BUILDER], { preview: true, silent: true });

    assert.strictEqual(payload.would_certify, 0);
    assert.strictEqual(payload.skipped, 1);
    assert.deepStrictEqual(payload.results.map((r) => [r.action, r.reason]), [['skipped', 'verifier_is_builder']]);
  });
});

test('nobody who ever built the job can be its second check, even after someone else rebuilt it', () => {
  withProject((fx) => {
    const id = reviewJob(fx, 'Built by codex, rebuilt by claude', proofWith(VERIFY), {
      metadata: { verify: VERIFY },
      order: 1000,
    });
    // A person reopens it from review. Claude takes it and hands in its own build, so claude is the
    // builder on record now. Codex built the first attempt and is no more independent than claude.
    assert.strictEqual(taskDb.reopenTask(fx.db, { id, actor: 'harman', reason: 'redo it', fromReview: true }).reopened, true);
    assert.strictEqual(taskDb.claimTask(fx.db, { id, claimedBy: 'claude' }).claimed, true);
    assert.strictEqual(taskDb.readyTask(fx.db, { id, actor: 'claude', proof: proofWith(VERIFY) }).ready, true);
    fx.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(1000, id);
    assert.strictEqual(taskDb.getTask(fx.db, id).metadata.built_by, 'claude');

    const outcome = (actor) => cmdCertifyVerified(['--as', actor], { preview: true, silent: true }).results.map((r) => [r.action, r.reason]);

    assert.deepStrictEqual(outcome('claude'), [['skipped', 'verifier_is_builder']]);
    assert.deepStrictEqual(outcome(BUILDER), [['skipped', 'verifier_is_builder']]);
    assert.deepStrictEqual(outcome(' Codex '), [['skipped', 'verifier_is_builder']], 'in any spelling of the name');
    assert.deepStrictEqual(outcome('validator'), [['would_certify', undefined]]);
  });
});

test('a job with no runnable check is skipped, and the limit counts only checks that run', () => {
  withProject((fx) => {
    // Oldest first. This one names no check at all, so it uses no turn.
    reviewJob(fx, 'Job with no check', proofWith('looked at it by eye'), { order: 1000 });
    reviewJob(fx, 'Job one', proofWith(VERIFY), { metadata: { verify: VERIFY }, order: 2000 });
    reviewJob(fx, 'Job two', proofWith(VERIFY), { metadata: { verify: VERIFY }, order: 3000 });

    const payload = cmdCertifyVerified(['--limit', '1'], { preview: true, silent: true });

    assert.strictEqual(payload.would_certify, 1);
    assert.deepStrictEqual(payload.results.map((r) => r.action), ['skipped', 'would_certify']);
    assert.strictEqual(payload.results[0].reason, 'no_runnable_check_in_proof');
    // Job two was never reached: the one check allowed for this pass was used.
    assert.strictEqual(payload.results.length, 2);
  });
});
