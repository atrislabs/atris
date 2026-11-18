'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const tasks = require('../lib/task-db');
const { handleMissionBlocker } = require('../lib/self-drive');

if (process.env.ATRIS_BLOCKER_RACE_WORKER === '1') {
  const db = tasks.open(process.env.ATRIS_BLOCKER_RACE_DB);
  const wrapped = { ...tasks, open: () => db, reopenTask(connection, input) {
    process.send('at-reopen');
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(process.env.ATRIS_BLOCKER_RACE_GO)) {
      if (Date.now() > deadline) throw new Error('fixture barrier timed out');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    return tasks.reopenTask(connection, input);
  } };
  try {
    const result = handleMissionBlocker({
      mission: { id: 'race-mission', objective: 'Synthetic work', status: 'paused' },
      stopReason: 'runner-failed', workspaceRoot: process.env.ATRIS_BLOCKER_RACE_WORKSPACE,
    }, {
      taskDb: wrapped,
      resolveEngineForRole: () => null,
      createAgentWorktree: () => { throw new Error('unexpected worker'); },
      dispatchToEngine: () => { throw new Error('unexpected worker'); },
      loadSwarloApiKey: () => null,
      httpPost: () => { throw new Error('unexpected network'); },
    });
    process.send({ result }, () => process.exit(0));
  } catch (error) {
    process.send({ error: String(error.stack) }, () => process.exit(1));
  }
} else {
  for (const changed of ['new-incarnation', 'workspace']) {
    test(`successful reopen stops before notes and claims after ${changed}`, t => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-blocker-incarnation-'));
      const folder = path.join(dir, 'workspace'); fs.mkdirSync(folder);
      const ws = fs.realpathSync(folder), db = tasks.open(path.join(dir, 'tasks.db'));
      t.after(() => { tasks.close(); fs.rmSync(dir, { recursive: true, force: true }); });
      const item = tasks.addTask(db, { title: 'Historical blocker', workspaceRoot: ws, status: 'done', metadata: {
        mission_id: 'race-mission', mission_blocker_class: 'runner-failed',
      } });
      let notes = 0, claims = 0, dispatches = 0;
      const wrapped = { ...tasks, open: () => db,
        reopenTask(connection, input) {
          const result = tasks.reopenTask(connection, input);
          if (changed === 'new-incarnation') {
            assert.equal(tasks.doneTask(db, { id: item.id, actor: 'other' }).updated, true);
            assert.equal(tasks.reopenTask(db, { id: item.id, actor: 'other' }).reopened, true);
          } else {
            db.prepare('UPDATE tasks SET workspace_root = ? WHERE id = ?').run(path.join(dir, 'other'), item.id);
          }
          return result;
        },
        noteTask() { notes += 1; throw new Error('unexpected note'); },
        claimTask() { claims += 1; throw new Error('unexpected claim'); },
      };
      const result = handleMissionBlocker({
        mission: { id: 'race-mission', objective: 'Private synthetic context', status: 'paused' },
        stopReason: 'runner-failed', workspaceRoot: ws,
      }, {
        taskDb: wrapped, resolveEngineForRole: () => ({ id: 'fixture' }),
        createAgentWorktree: () => { dispatches += 1; throw new Error('unexpected worker'); },
        dispatchToEngine: () => { dispatches += 1; throw new Error('unexpected worker'); },
        loadSwarloApiKey: () => null,
        httpPost: () => { throw new Error('unexpected network'); },
      });
      assert.equal(result.reason, 'reopen needs inspection');
      assert.equal(result.dispatched, false);
      assert.equal(notes, 0);
      assert.equal(claims, 0);
      assert.equal(dispatches, 0);
      assert.equal(tasks.listTaskEvents(db, { taskId: item.id }).filter(event => event.event_type === 'message').length, 0);
    });
  }

  test('failed read BEGIN leaves caller-owned transaction intact', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-blocker-nested-'));
    const folder = path.join(dir, 'workspace'); fs.mkdirSync(folder);
    const ws = fs.realpathSync(folder), db = tasks.open(path.join(dir, 'tasks.db'));
    t.after(() => { tasks.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const item = tasks.addTask(db, { title: 'Historical blocker', workspaceRoot: ws, status: 'done', metadata: {
      mission_id: 'race-mission', mission_blocker_class: 'runner-failed',
    } });
    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('caller edit', item.id);
    const result = handleMissionBlocker({
      mission: { id: 'race-mission', objective: 'Synthetic work', status: 'paused' },
      stopReason: 'runner-failed', workspaceRoot: ws,
    }, { taskDb: { ...tasks, open: () => db }, loadSwarloApiKey: () => null });
    assert.equal(result.reason, 'reopen needs inspection');
    assert.equal(tasks.getTask(db, item.id).title, 'caller edit');
    db.exec('ROLLBACK');
    assert.equal(tasks.getTask(db, item.id).title, 'Historical blocker');
  });

  for (const phase of ['reopen']) {
    for (const changed of ['metadata', 'workspace']) {
      test(`changed ${changed} before ${phase} never mutates or dispatches the old blocker`, t => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-blocker-stale-'));
        const folder = path.join(dir, 'workspace'); fs.mkdirSync(folder);
        const ws = fs.realpathSync(folder), db = tasks.open(path.join(dir, 'tasks.db'));
        t.after(() => { tasks.close(); fs.rmSync(dir, { recursive: true, force: true }); });
        const item = tasks.addTask(db, { title: 'Historical blocker', workspaceRoot: ws, status: 'done', metadata: {
          mission_id: 'race-mission', mission_blocker_class: 'runner-failed',
        } });
        let dispatches = 0, guards = null;
        function changeRow() {
          if (changed === 'workspace') db.prepare('UPDATE tasks SET workspace_root = ? WHERE id = ?').run(path.join(dir, 'different'), item.id);
          else {
            const metadata = { ...tasks.getTask(db, item.id).metadata, mission_id: 'different-mission' };
            db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), item.id);
          }
        }
        const wrapped = { ...tasks, open: () => db,
          reopenTask(connection, input) {
            if (phase === 'reopen') { guards = input; changeRow(); }
            return tasks.reopenTask(connection, input);
          },
          claimTask(connection, input) {
            if (phase === 'claim') { guards = input; changeRow(); }
            return tasks.claimTask(connection, input);
          },
        };
        const result = handleMissionBlocker({
          mission: { id: 'race-mission', objective: 'Synthetic work', status: 'paused' },
          stopReason: 'runner-failed', workspaceRoot: ws,
        }, {
          taskDb: wrapped,
          resolveEngineForRole: () => ({ id: 'fixture' }),
          createAgentWorktree: () => { dispatches += 1; throw new Error('unexpected worker'); },
          dispatchToEngine: () => { dispatches += 1; throw new Error('unexpected worker'); },
          loadSwarloApiKey: () => null,
          httpPost: () => { throw new Error('unexpected network'); },
        });
        assert.equal(result.reason, 'reopen needs inspection');
        assert.equal(result.dispatched, false);
        assert.equal(dispatches, 0);
        assert.equal(guards.expectedWorkspace, ws);
        assert.match(guards.expectedSnapshot, /^[a-f0-9]{64}$/);
        const current = tasks.getTask(db, item.id);
        assert.equal(current.status, phase === 'reopen' ? 'done' : 'open');
        assert.equal(current.claimed_by, null);
        assert.equal(tasks.listTaskEvents(db, { taskId: item.id }).filter(event => event.event_type === 'reopened').length, phase === 'reopen' ? 0 : 1);
        assert.equal(tasks.listTasks(db, {}).length, 1);
      });
    }
  }

  test('two callers reopening a historical row without a source key create no duplicate', { timeout: 30000 }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-blocker-race-'));
    const file = path.join(dir, 'tasks.db'), workspacePath = path.join(dir, 'workspace'), go = path.join(dir, 'go');
    fs.mkdirSync(workspacePath);
    const ws = fs.realpathSync(workspacePath);
    const db = tasks.open(file);
    t.after(() => { tasks.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const item = tasks.addTask(db, { title: 'Historical blocker', workspaceRoot: ws, status: 'done', metadata: {
      mission_id: 'race-mission', mission_blocker_class: 'runner-failed',
    } });
    assert.equal(tasks.getTask(db, item.id).source_key, null);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    function launch() {
      const child = fork(__filename, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: {
        ...process.env, HOME: dir, NODE_NO_WARNINGS: '1', ATRIS_BLOCKER_RACE_WORKER: '1',
        ATRIS_BLOCKER_RACE_DB: file, ATRIS_BLOCKER_RACE_WORKSPACE: ws, ATRIS_BLOCKER_RACE_GO: go,
      } });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      const messages = [], pending = [];
      child.on('message', message => { if (pending.length) pending.shift()(message); else messages.push(message); });
      const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise(resolve => pending.push(resolve));
      const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal, stderr })));
      t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
      return { child, next, exited };
    }
    const workers = [launch(), launch()];
    await Promise.all(workers.map(async worker => assert.equal(await worker.next(), 'at-reopen')));
    fs.writeFileSync(go, 'go');
    const messages = await Promise.all(workers.map(worker => worker.next()));
    const exits = await Promise.all(workers.map(worker => worker.exited));
    for (const exit of exits) assert.equal(exit.code, 0, exit.stderr);
    assert.equal(messages.filter(message => message.result?.reason === 'existing blocker task').length, 1);
    assert.equal(messages.filter(message => message.result?.reason === 'reopen needs inspection').length, 1);
    assert.ok(messages.every(message => message.result?.dispatched === false));
    const rows = tasks.listTasks(db, { workspaceRoot: ws });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, item.id);
    assert.equal(rows[0].status, 'open');
    assert.ok(rows[0].metadata.tags.includes('needs-human'));
    assert.equal(tasks.listTaskEvents(db, { taskId: item.id }).filter(event => event.event_type === 'reopened').length, 1);
  });
}
