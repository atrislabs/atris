'use strict';

// A refused check never waits a second pass: it is rewritten to the allowed
// shape, or the job goes back to its builder with a note. Real job database.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const taskDb = require('../lib/task-db');
const { allowedShapeFor, rerouteDisallowedChecks, vitestPaths } = require('../lib/check-shape-reroute');

function fixture({ vitestRunner = true } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-check-reroute-')));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  if (vitestRunner) fs.writeFileSync(path.join(repo, 'scripts', 'verify-vitest.mjs'), '// runs vitest on the given paths\n');
  const dbPath = path.join(base, 'tasks.db');
  process.env.ATRIS_TASKS_DB = dbPath;
  taskDb.close();
  const db = taskDb.open(dbPath);
  return { base, repo, db };
}

function cleanup(fx) {
  taskDb.close();
  delete process.env.ATRIS_TASKS_DB;
  fs.rmSync(fx.base, { recursive: true, force: true });
}

function reviewJob(fx, { title, verify, claimedBy = 'builder' }) {
  return taskDb.addTask(fx.db, {
    title,
    workspaceRoot: fx.repo,
    status: 'review',
    claimedBy,
    metadata: { approval_status: 'pending', verify, agent_review_pass_count: 1 },
  }).id;
}

const rows = (fx) => taskDb.withTaskDisplayRefs(taskDb.listTasks(fx.db, { workspaceRoot: fx.repo })).filter((t) => t.status === 'review');

test('vitest commands map to their paths, anything shell-shaped does not', () => {
  assert.deepEqual(vitestPaths('npx vitest run app/a.test.ts app/b'), ['app/a.test.ts', 'app/b']);
  assert.deepEqual(vitestPaths('npx vitest run app/a --reporter dot -t "x"'), null, 'quotes are refused');
  assert.deepEqual(vitestPaths('vitest run app/a --reporter dot'), ['app/a']);
  assert.deepEqual(vitestPaths('npm test -- app/x'), ['app/x']);
  assert.equal(vitestPaths('npx vitest run app/a; rm -rf /'), null);
  assert.equal(vitestPaths('npx vitest run ../outside'), null);
  assert.equal(vitestPaths('npx vitest run'), null);
});

test('the allowed shape is offered only where the project has the vitest runner', () => {
  const fx = fixture();
  const bare = fixture({ vitestRunner: false });
  try {
    assert.equal(allowedShapeFor('npx vitest run app/dashboard/orb', fx.repo), 'node scripts/verify-vitest.mjs app/dashboard/orb');
    assert.equal(allowedShapeFor('npx vitest run app/dashboard/orb', bare.repo), null);
    // A command copied out of a proof with its result still attached.
    assert.equal(
      allowedShapeFor('node scripts/verify-vitest.mjs app/x app/y, exit 0, 298 focused tests', fx.repo),
      'node scripts/verify-vitest.mjs app/x app/y',
    );
  } finally {
    cleanup(bare);
    cleanup(fx);
  }
});

test('a refused check is rewritten to the allowed shape in the same pass; one with no shape goes back to its builder', () => {
  const fx = fixture();
  try {
    const fixable = reviewJob(fx, { title: 'Member list loads faster', verify: 'npx vitest run app/dashboard/members' });
    const stuck = reviewJob(fx, { title: 'Speed check on the shell', verify: 'node /tmp/speed/run-all.mjs --runs 5' });
    const fine = reviewJob(fx, { title: 'Toast copy', verify: 'npm test' });

    const preview = rerouteDisallowedChecks({ root: fx.repo, tasks: rows(fx), dryRun: true });
    assert.deepEqual(preview.rerouted.map((r) => r.id), [fixable]);
    assert.deepEqual(preview.sent_back.map((r) => r.id), [stuck]);
    assert.equal(taskDb.getTask(fx.db, fixable).metadata.verify, 'npx vitest run app/dashboard/members', 'a preview writes nothing');

    const out = rerouteDisallowedChecks({ root: fx.repo, tasks: rows(fx) });
    assert.deepEqual(out.rerouted.map((r) => r.to), ['node scripts/verify-vitest.mjs app/dashboard/members']);
    const rewritten = taskDb.getTask(fx.db, fixable);
    assert.equal(rewritten.status, 'review');
    assert.equal(rewritten.metadata.verify, 'node scripts/verify-vitest.mjs app/dashboard/members');
    assert.equal(rewritten.metadata.verify_rerouted_from, 'npx vitest run app/dashboard/members');

    const sent = taskDb.getTask(fx.db, stuck);
    assert.equal(sent.status, 'claimed', 'back with its builder');
    assert.equal(sent.claimed_by, 'builder');
    assert.match(sent.metadata.human_revision_note, /is not a check this machine may run on its own/);
    assert.equal(taskDb.getTask(fx.db, fine).status, 'review');

    // The next pass has nothing left to do for either.
    const again = rerouteDisallowedChecks({ root: fx.repo, tasks: rows(fx) });
    assert.deepEqual(again.rerouted, []);
    assert.deepEqual(again.sent_back, []);
  } finally {
    cleanup(fx);
  }
});
