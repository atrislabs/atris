const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { computerPr } = require(path.join(__dirname, '../commands/computer'));
const store = require(path.join(__dirname, '../lib/task-db'));

test('computer PR publishes progress and outcomes only for enabled projects', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-feed-'));
  const oldCwd = process.cwd(), oldDb = process.env.ATRIS_TASKS_DB, oldExit = process.exitCode;
  process.env.ATRIS_TASKS_DB = path.join(root, 'tasks.db');
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, 'atris/team/executor'), { recursive: true });
  const run = async (cwd, args, output) => {
    process.chdir(cwd);
    const logs = [];
    let workerDone;
    await computerPr('token', ['a/b', 'Fix this. More detail', ...args], { businessId: 'b', workspaceId: 'w', model: 'saved-model' }, {}, {
      onFeedWorker: worker => { workerDone = new Promise(resolve => worker.on('exit', resolve)); },
      log: s => logs.push(s), logError: s => logs.push(s), write: () => {},
      ensureBusinessAwake: async () => true,
      apiRequestJson: async () => ({ ok: true, data: { execution_id: 'x' } }),
      streamBusinessChatResult: async (_t, _c, _i, _r, opts) => { for (const s of output) opts.write(s); return { ok: true, text: output.join('') }; },
    });
    if (workerDone) await workerDone;
    assert.match(logs.at(-1), /^Done in \d+m \d+s$/);
  };
  try {
    await run(project, [], ['First progress.\n', 'Second progress.\n', 'PR_URL=https://github.com/a/b/pull/1\n']);
    let rows = store.listTasks(store.open(), { workspaceRoot: store.workspaceRoot(project) });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'Fix this.');
    assert.equal(rows[0].status, 'review');
    assert.equal(rows[0].claimed_by, 'executor');
    assert.equal(rows[0].metadata.assigned_to, 'executor');
    assert.equal(rows[0].metadata.feed.source, 'codeops');
    assert.equal(rows[0].metadata.feed.repo, 'a/b');
    assert.deepEqual(rows[0].metadata.feed.progress, []);
    assert.match(rows[0].metadata.result, /^Fixed: Fix this\. Pull request ready in \d+m \d+s\. · saved-model$/);
    assert.equal(rows[0].metadata.feed.model, 'saved-model');
    assert.equal(rows[0].metadata.feed.url, 'https://github.com/a/b/pull/1');
    await run(project, ['--no-think'], ['Could not finish.\n']);
    rows = store.listTasks(store.open(), { workspaceRoot: store.workspaceRoot(project) });
    assert.equal(rows.length, 2);
    const failed = rows.find(row => row.status === 'failed');
    assert.match(failed.metadata.result, /^Could not finish: Fix this\. No pull request is ready\.$/);
    await run(project, ['--no-feed'], ['PR_URL=https://github.com/a/b/pull/2\n']);
    await run(root, [], ['PR_URL=https://github.com/a/b/pull/3\n']);
    assert.equal(store.listTasks(store.open(), { workspaceRoot: store.workspaceRoot(project) }).length, 2);
    assert.equal(store.listTasks(store.open(), { workspaceRoot: store.workspaceRoot(root) }).length, 0);
  } finally { process.chdir(oldCwd); process.exitCode = oldExit; if (oldDb === undefined) delete process.env.ATRIS_TASKS_DB; else process.env.ATRIS_TASKS_DB = oldDb; }
});

test('computer command saves the feed result before its real exit', () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-feed-exit-'));
  fs.mkdirSync(path.join(root, 'atris/team/executor'), { recursive: true });
  const dbPath = path.join(root, 'tasks.db');
  const computerPath = path.join(__dirname, '../commands/computer');
  const binPath = path.join(__dirname, '../bin/atris.js');
  const script = `
    const computer = require(${JSON.stringify(computerPath)});
    computer.runComputer = () => computer.computerPr('token', ['a/b', 'Fix this.', '--no-think'],
      { businessId: 'b', workspaceId: 'w' }, {}, {
        ensureBusinessAwake: async () => true,
        apiRequestJson: async () => ({ ok: true, data: { execution_id: 'x' } }),
        streamBusinessChatResult: async () => ({ ok: true, text: 'PR_URL=https://github.com/a/b/pull/1' }),
      });
    process.argv = [process.execPath, ${JSON.stringify(binPath)}, 'computer'];
    require(${JSON.stringify(binPath)});
  `;
  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: root, env: { ...process.env, ATRIS_TASKS_DB: dbPath }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(child.status, 0, child.stderr);
  const db = store.open(dbPath);
  try {
    const rows = store.listTasks(db, { workspaceRoot: store.workspaceRoot(root) });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'review');
    assert.match(rows[0].metadata.result, /^Fixed: Fix this\./);
  } finally { db.close(); }
});

test('computer PR saves a stopped feed card on SIGINT', async () => {
  const { spawn } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-feed-signal-'));
  fs.mkdirSync(path.join(root, 'atris/team/executor'), { recursive: true });
  const dbPath = path.join(root, 'tasks.db');
  const computerPath = path.join(__dirname, '../commands/computer');
  const script = `
    const { computerPr } = require(${JSON.stringify(computerPath)});
    computerPr('token', ['a/b', 'Fix this.', '--no-think'], { businessId: 'b', workspaceId: 'w' }, {}, {
      ensureBusinessAwake: async () => true,
      apiRequestJson: async () => ({ ok: true, data: { execution_id: 'x' } }),
      streamBusinessChatResult: async () => { console.log('READY'); await new Promise(() => {}); },
    });
  `;
  const child = spawn(process.execPath, ['-e', script], { cwd: root, env: { ...process.env, ATRIS_TASKS_DB: dbPath } });
  let output = '';
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('child did not become ready')); }, 5000);
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('READY')) { clearTimeout(timeout); resolve(); } });
    child.on('error', reject);
  });
  child.kill('SIGINT');
  await exited;
  const db = store.open(dbPath);
  try {
    const rows = store.listTasks(db, { workspaceRoot: store.workspaceRoot(root) });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'failed');
    assert.equal(rows[0].metadata.result, 'Stopped: Fix this. No pull request yet.');
  } finally { db.close(); }
});
