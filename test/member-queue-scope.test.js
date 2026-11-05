'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveMemberQueueScope } = require('../lib/member-queue-scope');
const { fittingTasks, claimTaskForMember } = require('../lib/member-task-pick');

function git(cwd, args) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
}
function fixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'member-scope-'));
  const main = path.join(tmp, 'main'), linked = path.join(tmp, 'linked'), other = path.join(tmp, 'other');
  fs.mkdirSync(main); git(main, ['init', '-q']);
  git(main, ['config', 'user.email', 'test@example.com']); git(main, ['config', 'user.name', 'Test']);
  fs.mkdirSync(path.join(main, 'atris')); fs.writeFileSync(path.join(main, 'atris', 'atris.md'), '# workspace\n');
  git(main, ['add', '.']); git(main, ['commit', '-qm', 'fixture']);
  git(main, ['worktree', 'add', '-qb', 'linked', linked]);
  fs.mkdirSync(other); git(other, ['init', '-q']);
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  return { main: fs.realpathSync(main), linked: fs.realpathSync(linked), other: fs.realpathSync(other) };
}

test('an explicit queue root must be a linked repository root', (t) => {
  const { main, linked, other } = fixture(t);
  assert.deepEqual(resolveMemberQueueScope(linked, main), { workspaceRoot: main, exactWorkspace: true });
  assert.throws(() => resolveMemberQueueScope(linked, other), /same Git repository/);
  assert.throws(() => resolveMemberQueueScope(linked, 'relative'), /absolute path/);
  const nested = path.join(linked, 'nested'); fs.mkdirSync(path.join(nested, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(nested, 'atris', 'atris.md'), '# nested\n');
  assert.throws(() => resolveMemberQueueScope(nested, main), /nested workspace/);
  fs.mkdirSync(path.join(linked, '.atris'), { recursive: true });
  fs.writeFileSync(path.join(linked, '.atris', 'business.json'), '{}');
  assert.throws(() => resolveMemberQueueScope(linked, main), /business workspace/);
});

test('exact scope filters sibling tasks consistently for preview and claim', () => {
  const jobs = [
    { id: 'sibling', status: 'open', title: 'Fix one', workspace_root: '/sibling', metadata: { verify: 'node --test test/x.test.js' }, created_at: 1 },
    { id: 'main', status: 'open', title: 'Fix two', workspace_root: '/main', metadata: { verify: 'node --test test/x.test.js' }, created_at: 2 },
  ];
  const claimed = [];
  const db = { listTasks: (_db, opts) => opts.status === 'open' ? jobs : [], claimTask: (_db, { id }) => { claimed.push(id); return { claimed: true, row: jobs.find(x => x.id === id) }; } };
  const opts = { workspaceRoot: '/main', exactWorkspace: true, member: 'builder', job: 'build', requireCheck: true };
  assert.deepEqual(fittingTasks(db, {}, opts).map(x => x.id), ['main']);
  assert.equal(claimTaskForMember(db, {}, opts).task.id, 'main');
  assert.deepEqual(claimed, ['main']);
});

test('supervised local records do not resolve to the primary copy', (t) => {
  const { resolveMemberWorkspaceRoot } = require('../commands/mission');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'member-local-records-'));
  const main = path.join(tmp, 'repo'), linked = path.join(tmp, '.agent-worktrees', 'repo', 'copy');
  fs.mkdirSync(path.join(main, 'atris'), { recursive: true }); fs.mkdirSync(path.join(linked, 'atris'), { recursive: true });
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const old = process.env.ATRIS_MEMBER_LOCAL_RECORDS;
  try {
    delete process.env.ATRIS_MEMBER_LOCAL_RECORDS;
    assert.equal(resolveMemberWorkspaceRoot(linked), main);
    process.env.ATRIS_MEMBER_LOCAL_RECORDS = '1';
    assert.equal(resolveMemberWorkspaceRoot(linked), fs.realpathSync(linked));
  } finally {
    if (old === undefined) delete process.env.ATRIS_MEMBER_LOCAL_RECORDS; else process.env.ATRIS_MEMBER_LOCAL_RECORDS = old;
  }
});

test('child task claim reports a database failure instead of an idle result', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'member-claim-error-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home'), root = path.join(tmp, 'workspace');
  fs.mkdirSync(path.join(root, 'atris', 'team', 'tester'), { recursive: true }); fs.mkdirSync(home);
  fs.writeFileSync(path.join(root, 'atris', 'atris.md'), '# test\n');
  fs.writeFileSync(path.join(root, 'atris', 'team', 'tester', 'MEMBER.md'), '---\nname: tester\nrole: Builder\n---\n');
  const badParent = path.join(tmp, 'not-a-directory'); fs.writeFileSync(badParent, 'x');
  const cli = path.resolve(__dirname, '../bin/atris.js');
  const out = spawnSync(process.execPath, [cli, 'member', 'go', 'tester', '--needs-check', '--json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, HOME: home, ATRIS_TASKS_DB: path.join(badParent, 'tasks.db'), ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_MEMBER_QUEUE_ROOT: '' },
  });
  assert.notEqual(out.status, 0);
  assert.notEqual(out.status, 75, 'a database error is not an idle exit');
  assert.match(out.stderr, /could not take a task from the list/);
});

test('linked supervisor preview and child preview see the same primary task without changing primary files', (t) => {
  const { main, linked } = fixture(t);
  for (const root of [main, linked]) {
    const dir = path.join(root, 'atris', 'team', 'builder'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'MEMBER.md'), '---\nname: builder\nrole: Builder\n---\n');
  }
  const taskDb = require('../lib/task-db'); taskDb.close();
  const database = path.join(path.dirname(main), 'queue.db'); const db = taskDb.open(database);
  try {
    taskDb.addTask(db, { title: 'Fix selected primary issue', tag: 'build', workspaceRoot: main, metadata: { verify: 'node --test test/x.test.js', assigned_to: 'builder' } });
    taskDb.addTask(db, { title: 'Do not take sibling issue', tag: 'build', workspaceRoot: linked, metadata: { verify: 'node --test test/y.test.js', assigned_to: 'builder' } });
  } finally { taskDb.close(); }
  const home = path.join(path.dirname(main), 'home'); fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, ATRIS_TASKS_DB: database, ATRIS_MEMBER_QUEUE_ROOT: main, ATRIS_SKIP_UPDATE_CHECK: '1' };
  const cli = path.resolve(__dirname, '../bin/atris.js');
  const status = () => spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: main, encoding: 'utf8' }).stdout;
  const before = status();
  const up = spawnSync(process.execPath, [cli, 'member', 'up', '--dry-run', '--only', 'builder', '--local-records'], { cwd: linked, env, encoding: 'utf8' });
  assert.equal(up.status, 0, up.stderr); assert.match(up.stdout, /Fix selected primary issue/); assert.doesNotMatch(up.stdout, /Do not take sibling issue/);
  const child = spawnSync(process.execPath, [cli, 'member', 'go', 'builder', '--needs-check', '--dry-run', '--json'], { cwd: linked, env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const output = JSON.parse(child.stdout); assert.equal(output.task.title, 'Fix selected primary issue');
  assert.equal(status(), before, 'dry-run never writes into the primary checkout');
});

test('a human hold added after preview is rechecked atomically at claim', () => {
  const open = { id: 'row', status: 'open', title: 'Fix the sample', workspace_root: '/main', metadata: { verify: 'node --test test/x.test.js' } };
  let blocked;
  const db = {
    listTasks: (_db, opts) => opts.status === 'open' ? [open] : [],
    claimTask: (_db, { refuseIf }) => { blocked = refuseIf({ ...open, metadata: { ...open.metadata, tags: ['needs-human'] } }); return { claimed: !blocked }; },
  };
  const out = claimTaskForMember(db, {}, { workspaceRoot: '/main', exactWorkspace: true, member: 'builder', job: 'build', requireCheck: true });
  assert.equal(out, null);
  assert.equal(blocked, 'needs_human');
});

test('starting a local-record mission in an agent copy does not write member records to primary', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'member-local-mission-'));
  const main = path.join(tmp, 'repo'), linked = path.join(tmp, '.agent-worktrees', 'repo', 'control'), home = path.join(tmp, 'home');
  fs.mkdirSync(main); git(main, ['init', '-q']); git(main, ['config', 'user.email', 'test@example.com']); git(main, ['config', 'user.name', 'Test']);
  const member = path.join(main, 'atris', 'team', 'builder'); fs.mkdirSync(member, { recursive: true });
  fs.writeFileSync(path.join(main, 'atris', 'atris.md'), '# workspace\n');
  fs.writeFileSync(path.join(member, 'MEMBER.md'), '---\nname: builder\nrole: Builder\n---\n');
  git(main, ['add', '.']); git(main, ['commit', '-qm', 'fixture']);
  fs.mkdirSync(path.dirname(linked), { recursive: true }); git(main, ['worktree', 'add', '-qb', 'control', linked]); fs.mkdirSync(home);
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const before = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: main, encoding: 'utf8' }).stdout;
  const cli = path.resolve(__dirname, '../bin/atris.js');
  const out = spawnSync(process.execPath, [cli, 'mission', 'start', 'Inspect the isolated sample', '--owner', 'builder', '--runner', 'manual', '--verify', 'node --test test/x.test.js', '--json'], {
    cwd: linked, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, HOME: home, ATRIS_TASKS_DB: path.join(tmp, 'tasks.db'), ATRIS_MEMBER_LOCAL_RECORDS: '1', ATRIS_MEMBER_QUEUE_ROOT: main, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  assert.equal(out.status, 0, out.stderr || out.stdout);
  const after = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: main, encoding: 'utf8' }).stdout;
  assert.equal(after, before);
  assert.equal(fs.existsSync(path.join(main, '.atris', 'state', 'mission-events.jsonl')), false);
});

test('claim and note from a linked local-record supervisor do not write to the primary', (t) => {
  const { main, linked } = fixture(t);
  for (const root of [main, linked]) {
    const dir = path.join(root, 'atris', 'team', 'builder'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'MEMBER.md'), '---\nname: builder\nrole: Builder\n---\n');
  }
  const taskDb = require('../lib/task-db'); taskDb.close();
  const database = path.join(path.dirname(main), 'queue.db'); const db = taskDb.open(database);
  let id;
  try { id = taskDb.addTask(db, { title: 'Investigate sample failure', tag: 'build', workspaceRoot: main, metadata: { verify: 'node --test test/x.test.js', assigned_to: 'builder' } }).id; } finally { taskDb.close(); }
  const home = path.join(path.dirname(main), 'home'); fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, ATRIS_TASKS_DB: database, ATRIS_MEMBER_QUEUE_ROOT: main, ATRIS_MEMBER_LOCAL_RECORDS: '1' };
  const before = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: main, encoding: 'utf8' }).stdout;
  const modulePath = path.resolve(__dirname, '../lib/task-db.js');
  const script = `const dbapi=require(${JSON.stringify(modulePath)});const db=dbapi.open();const got=dbapi.claimTask(db,{id:${JSON.stringify(id)},claimedBy:'builder'});if(!got.claimed)process.exit(3);dbapi.noteTask(db,{id:${JSON.stringify(id)},actor:'builder',content:'Investigated sample'});`;
  const out = spawnSync(process.execPath, ['-e', script], { cwd: linked, env, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const after = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: main, encoding: 'utf8' }).stdout;
  assert.equal(after, before);
  assert.ok(fs.existsSync(path.join(linked, 'atris', 'team', 'builder', 'logs')));
});

test('a child work copy writes task records to its validated control copy, not primary or child', (t) => {
  const { main, linked } = fixture(t);
  const child = path.join(path.dirname(main), 'worker'); git(main, ['worktree', 'add', '-qb', 'worker', child]);
  for (const root of [main, linked, child]) {
    const dir = path.join(root, 'atris', 'team', 'builder'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'MEMBER.md'), '---\nname: builder\nrole: Builder\n---\n');
  }
  const taskDb = require('../lib/task-db'); taskDb.close();
  const database = path.join(path.dirname(main), 'queue.db'); const db = taskDb.open(database);
  let id;
  try { id = taskDb.addTask(db, { title: 'Investigate sample failure', tag: 'build', workspaceRoot: main, metadata: { verify: 'node --test test/x.test.js', assigned_to: 'builder' } }).id; } finally { taskDb.close(); }
  const home = path.join(path.dirname(main), 'home'); fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, ATRIS_TASKS_DB: database, ATRIS_MEMBER_QUEUE_ROOT: main, ATRIS_MEMBER_LOCAL_RECORDS: '1', ATRIS_MEMBER_RECORDS_ROOT: linked };
  const modulePath = path.resolve(__dirname, '../lib/task-db.js');
  const script = `const api=require(${JSON.stringify(modulePath)});const db=api.open();const got=api.claimTask(db,{id:${JSON.stringify(id)},claimedBy:'builder'});if(!got.claimed)process.exit(3);api.noteTask(db,{id:${JSON.stringify(id)},actor:'builder',content:'Investigated sample'});`;
  const out = spawnSync(process.execPath, ['-e', script], { cwd: child, env, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.ok(fs.existsSync(path.join(linked, 'atris', 'team', 'builder', 'logs')));
  assert.equal(fs.existsSync(path.join(main, 'atris', 'team', 'builder', 'logs')), false);
  assert.equal(fs.existsSync(path.join(child, 'atris', 'team', 'builder', 'logs')), false);
});

test('local-record supervised verification fails closed before touching primary or scratch copies', () => {
  const { runVerifyAtJobCode } = require('../lib/job-code-verify');
  const before = process.env.ATRIS_MEMBER_LOCAL_RECORDS;
  try {
    process.env.ATRIS_MEMBER_LOCAL_RECORDS = '1';
    const result = runVerifyAtJobCode('node --test test/x.test.js', { id: 'x', workspace_root: '/unavailable-primary', metadata: {} }, { root: '/unavailable-control' });
    assert.equal(result.ok, false);
    assert.equal(result.unrunnable_cause, 'isolated_verifier_required');
    assert.equal(result.alarm, true);
  } finally {
    if (before === undefined) delete process.env.ATRIS_MEMBER_LOCAL_RECORDS; else process.env.ATRIS_MEMBER_LOCAL_RECORDS = before;
  }
});

test('a resumed mission restores its validated queue and distinct records roots', (t) => {
  const { main, linked, other } = fixture(t);
  const { restoreMemberMissionScope } = require('../lib/member-queue-scope');
  const mission = { member_queue_root: main, member_records_root: linked, local_member_records: true, require_independent_review: true };
  const env = {};
  restoreMemberMissionScope(mission, linked, env);
  assert.deepEqual(env, { ATRIS_MEMBER_QUEUE_ROOT: main, ATRIS_MEMBER_LOCAL_RECORDS: '1', ATRIS_MEMBER_RECORDS_ROOT: linked, ATRIS_MEMBER_REQUIRE_REVIEW: '1' });
  assert.throws(() => restoreMemberMissionScope({ ...mission, member_records_root: main }, linked, {}), /must differ/);
  assert.throws(() => restoreMemberMissionScope({ ...mission, member_queue_root: other }, linked, {}), /same Git repository/);
});

test('a failed claim never releases another run under the same member name', () => {
  let releases = 0;
  const task = { id: 'row', status: 'open', title: 'Fix one', workspace_root: '/main', metadata: { verify: 'node --test test/x.test.js' } };
  const db = { listTasks: (_db, opts) => opts.status === 'open' ? [task] : [], claimTask: () => { throw new Error('transaction failed'); }, releaseTask: () => { releases++; } };
  assert.throws(() => claimTaskForMember(db, {}, { workspaceRoot: '/main', exactWorkspace: true, member: 'builder', job: 'build', requireCheck: true }), /transaction failed/);
  assert.equal(releases, 0);
});

test('linked copies share one supervisor identity while a business workspace stays separate', (t) => {
  const { main, linked } = fixture(t);
  const { planMemberUpLaunch } = require('../lib/member-up-launch');
  const opts = { cliPath: '/tmp/atris.js', stateHome: '/tmp/atris-state', homeDir: '/tmp/atris-home', taskDb: '' };
  const a = planMemberUpLaunch({ ...opts, root: main });
  const b = planMemberUpLaunch({ ...opts, root: linked });
  assert.equal(a.label, b.label);
  assert.equal(a.pidFile, b.pidFile);
  assert.equal(a.dir, b.dir);
  fs.mkdirSync(path.join(linked, '.atris'), { recursive: true }); fs.writeFileSync(path.join(linked, '.atris', 'business.json'), '{}');
  const business = planMemberUpLaunch({ ...opts, root: linked });
  assert.notEqual(business.label, a.label);
  const nested = path.join(linked, 'inside', 'business');
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(planMemberUpLaunch({ ...opts, root: nested }).label, business.label);
  const nestedWorkspace = path.join(main, 'another-workspace');
  fs.mkdirSync(path.join(nestedWorkspace, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(nestedWorkspace, 'atris', 'atris.md'), '# nested workspace\n');
  fs.mkdirSync(path.join(nestedWorkspace, 'child'));
  const nestedPlan = planMemberUpLaunch({ ...opts, root: nestedWorkspace });
  assert.notEqual(nestedPlan.label, a.label);
  assert.equal(planMemberUpLaunch({ ...opts, root: path.join(nestedWorkspace, 'child') }).label, nestedPlan.label);
});

test('fresh mission process restores validated queue and records scope before verification', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'member-resume-scope-'));
  const main = path.join(tmp, 'repo'), linked = path.join(tmp, '.agent-worktrees', 'repo', 'control'), home = path.join(tmp, 'home');
  fs.mkdirSync(main); git(main, ['init', '-q']); git(main, ['config', 'user.email', 'test@example.com']); git(main, ['config', 'user.name', 'Test']);
  const member = path.join(main, 'atris', 'team', 'builder'); fs.mkdirSync(member, { recursive: true });
  fs.writeFileSync(path.join(main, 'atris', 'atris.md'), '# workspace\n');
  fs.writeFileSync(path.join(member, 'MEMBER.md'), '---\nname: builder\nrole: Builder\n---\n');
  fs.mkdirSync(path.join(main, 'test'));
  fs.writeFileSync(path.join(main, 'test', 'scope.test.js'), "require('fs').writeFileSync('observed-scope.json', JSON.stringify({queue:process.env.ATRIS_MEMBER_QUEUE_ROOT,records:process.env.ATRIS_MEMBER_RECORDS_ROOT,local:process.env.ATRIS_MEMBER_LOCAL_RECORDS,review:process.env.ATRIS_MEMBER_REQUIRE_REVIEW}));\n");
  git(main, ['add', '.']); git(main, ['commit', '-qm', 'fixture']);
  fs.mkdirSync(path.dirname(linked), { recursive: true }); git(main, ['worktree', 'add', '-qb', 'control', linked]); fs.mkdirSync(home);
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const cli = path.resolve(__dirname, '../bin/atris.js');
  const env = { ...process.env, HOME: home, ATRIS_TASKS_DB: path.join(tmp, 'tasks.db'), ATRIS_MEMBER_QUEUE_ROOT: main, ATRIS_MEMBER_RECORDS_ROOT: linked, ATRIS_MEMBER_LOCAL_RECORDS: '1', ATRIS_MEMBER_REQUIRE_REVIEW: '1', ATRIS_SKIP_UPDATE_CHECK: '1' };
  const before = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: main, encoding: 'utf8' }).stdout;
  const started = spawnSync(process.execPath, [cli, 'mission', 'start', 'Inspect the isolated sample', '--owner', 'builder', '--runner', 'manual', '--verify', 'node --test test/scope.test.js', '--json'], { cwd: linked, env, encoding: 'utf8', timeout: 20000 });
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const parsed = JSON.parse(started.stdout); const id = parsed.mission?.id || parsed.id;
  assert.ok(id, started.stdout);
  const freshEnv = { ...env }; for (const key of ['ATRIS_MEMBER_QUEUE_ROOT', 'ATRIS_MEMBER_RECORDS_ROOT', 'ATRIS_MEMBER_LOCAL_RECORDS', 'ATRIS_MEMBER_REQUIRE_REVIEW', 'NODE_TEST_CONTEXT']) delete freshEnv[key];
  const resumed = spawnSync(process.execPath, [cli, 'mission', 'run', id, '--no-claude', '--max-ticks', '1', '--json'], { cwd: linked, env: freshEnv, encoding: 'utf8', timeout: 30000 });
  assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
  assert.ok(fs.existsSync(path.join(linked, 'observed-scope.json')), resumed.stderr || resumed.stdout);
  const observed = JSON.parse(fs.readFileSync(path.join(linked, 'observed-scope.json'), 'utf8'));
  assert.deepEqual(observed, { queue: fs.realpathSync(main), records: fs.realpathSync(linked), local: '1', review: '1' });
  assert.equal(spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: main, encoding: 'utf8' }).stdout, before);
});
