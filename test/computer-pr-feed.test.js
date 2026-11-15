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
    await computerPr('token', ['a/b', 'Fix this. More detail', ...args], { businessId: 'b', workspaceId: 'w' }, { model: 'model-x' }, {
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
    assert.deepEqual(rows[0].metadata.feed.progress.map(p => p.text.replace(/^\d+:\d\d /, '')), ['First progress.', 'Second progress.']);
    assert.ok(rows[0].metadata.feed.progress.every(p => /^\d+:\d\d /.test(p.text) && p.by === 'executor' && !Number.isNaN(Date.parse(p.at))));
    assert.match(rows[0].metadata.result, /^Pull request https:\/\/github.com\/a\/b\/pull\/1 · \d+m \d+s · model-x$/);
    await run(project, ['--no-think'], ['Could not finish.\n']);
    rows = store.listTasks(store.open(), { workspaceRoot: store.workspaceRoot(project) });
    assert.equal(rows.length, 2);
    const failed = rows.find(row => row.status === 'failed');
    assert.equal(failed.metadata.result, 'Could not finish.');
    await run(project, ['--no-feed'], ['PR_URL=https://github.com/a/b/pull/2\n']);
    await run(root, [], ['PR_URL=https://github.com/a/b/pull/3\n']);
    assert.equal(store.listTasks(store.open(), { workspaceRoot: store.workspaceRoot(project) }).length, 2);
    assert.equal(store.listTasks(store.open(), { workspaceRoot: store.workspaceRoot(root) }).length, 0);
  } finally { process.chdir(oldCwd); process.exitCode = oldExit; if (oldDb === undefined) delete process.env.ATRIS_TASKS_DB; else process.env.ATRIS_TASKS_DB = oldDb; }
});
