'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const taskDb = require('../lib/task-db');
const { autolandMemberRun } = require('../lib/member-autoland');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-refused-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (args) => {
    const res = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout.trim();
  };
  git(['init', '-q', '-b', 'member-work']);
  git(['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'baseline']);
  fs.mkdirSync(path.join(dir, '.atris', 'policy'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.atris', 'policy', 'autoland.json'), JSON.stringify({ enabled: true }));
  fs.writeFileSync(path.join(dir, '.git', 'info', 'exclude'), '.atris/\n');
  const db = taskDb.open(path.join(dir, '.atris', 'tasks.db'));
  t.after(() => taskDb.close(db));
  const task = taskDb.addTask(db, { title: 'Tidy the board', tag: 'workspace', workspaceRoot: dir });
  const mission = { id: 'test-refused', objective: 'Tidy the board', lane: 'workspace', verifier_result: { passed: true }, xp_task: { task_id: task.id } };
  return { dir, db, task, mission, git, run: (m = mission) => autolandMemberRun({ mission: m, cwd: dir, loadTask: (id) => taskDb.getTask(db, id) }) };
}

test('a real task sent back by a person stays local despite a passing check', (t) => {
  const fx = fixture(t);
  assert.equal(taskDb.readyTask(fx.db, { id: fx.task.id, proof: 'node check.js', actor: 'builder' }).ready, true);
  assert.equal(taskDb.reviseTask(fx.db, { id: fx.task.id, note: 'the numbers are wrong', actor: 'operator' }).revised, true);
  const result = fx.run();
  assert.equal(result.gate, 'approval', result.line);
  assert.equal(result.auto_merge, false);
  assert.match(result.line, /turned down.*fresh proof/);
  // No origin exists: reaching a push would fail at a different gate.
  assert.equal(fx.git(['branch', '-r']), '');
  console.log(result.line);
});

test('every linked task and both approval fields honor a turn-down', (t) => {
  const fx = fixture(t);
  for (const state of ['revise', 'revised', 'rejected', ' REJECTED ']) {
    for (const field of ['metadata', 'review']) {
      const result = autolandMemberRun({
        mission: { ...fx.mission, task_ids: ['other'], task_id: fx.task.id }, cwd: fx.dir,
        loadTask: (id) => id === 'other' ? { title: 'Tidy another row', metadata: {}, [field]: { approval_status: state } } : taskDb.getTask(fx.db, id),
      });
      assert.equal(result.gate, 'approval', `${field}: ${state}`);
    }
  }
});

test('fresh submitted proof clears the turn-down without bypassing review', (t) => {
  const fx = fixture(t);
  taskDb.readyTask(fx.db, { id: fx.task.id, proof: 'node check.js', actor: 'builder' });
  taskDb.reviseTask(fx.db, { id: fx.task.id, note: 'fix the numbers', actor: 'operator' });
  assert.equal(fx.run().gate, 'approval');
  taskDb.readyTask(fx.db, { id: fx.task.id, proof: 'node check.js', actor: 'builder' });
  assert.equal(taskDb.getTask(fx.db, fx.task.id).metadata.approval_status, 'pending');
  assert.equal(fx.run().gate, 'review');
});

// Invoke the changed handoff in a separate Node process with a real task DB.
// Git and GitHub traps record any external handoff attempt before failing it.
test('the real handoff command makes no network or github calls for turned-down work', (t) => {
  const fx = fixture(t);
  taskDb.readyTask(fx.db, { id: fx.task.id, proof: 'node check.js', actor: 'builder' });
  taskDb.reviseTask(fx.db, { id: fx.task.id, note: 'wrong numbers', actor: 'operator' });
  const bin = path.join(fx.dir, '.atris', 'bin');
  fs.mkdirSync(bin);
  const log = path.join(fx.dir, '.atris', 'external-calls');
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase "$1" in push|fetch|ls-remote) echo git >> "${log}"; exit 99;; esac\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho gh >> "${log}"\nexit 99\n`, { mode: 0o755 });
  const script = `const db = require(${JSON.stringify(require.resolve('../lib/task-db'))}); const handle = db.open(process.argv[1]); const result = require(${JSON.stringify(require.resolve('../lib/member-autoland'))}).autolandMemberRun({ mission: JSON.parse(process.argv[2]), cwd: process.cwd(), loadTask: id => db.getTask(handle, id) }); console.log(result.line); db.close(handle); process.exit(result.gate === 'approval' ? 0 : 1);`;
  const res = spawnSync(process.execPath, ['-e', script, path.join(fx.dir, '.atris', 'tasks.db'), JSON.stringify(fx.mission)], {
    cwd: fx.dir, encoding: 'utf8', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /turned down/);
  assert.equal(fs.existsSync(log), false, 'no push, fetch, lookup, or github command');
  console.log('real handoff command exit 0: ' + res.stdout.trim());
});
