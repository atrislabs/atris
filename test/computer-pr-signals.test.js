const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const store = require('../lib/task-db');

if (process.argv[2] === 'child') {
  const { computerPr } = require('../commands/computer');
  const originalExit = process.exit;
  process.exit = code => { if (process.argv[3] === 'SIGINT') process.send({ exit: code }); else originalExit(code); };
  computerPr('token', ['a/b', 'Fix this.', '--no-think'], { businessId: 'b', workspaceId: 'w' }, {}, {
    ensureBusinessAwake: async () => true,
    apiRequestJson: async () => ({ ok: true, data: { execution_id: 'x' } }),
    streamBusinessChatResult: async () => new Promise(resolve => {
      process.once('SIGINT', () => setTimeout(() => { process.send({ cancelled: true }); resolve({ ok: false, status: 'cancelled' }); }, 100));
      process.send({ ready: true });
    }),
  }).then(() => { process.send({ returned: true }); process.disconnect(); });
} else {
  for (const signal of ['SIGINT', 'SIGTERM']) test(`computer PR saves stopped card on ${signal}`, { timeout: 10000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-signal-'));
    fs.mkdirSync(path.join(root, 'atris/team/executor'), { recursive: true });
    const dbPath = path.join(root, 'tasks.db');
    const child = fork(__filename, ['child', signal], { cwd: root, env: { ...process.env, ATRIS_TASKS_DB: dbPath }, silent: true });
    const messages = [];
    const result = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('message', message => { messages.push(message); if (message.ready) child.kill(signal); });
      child.on('exit', (code, sig) => resolve({ code, sig }));
    });
    if (signal === 'SIGINT') {
      assert.equal(messages.some(m => 'exit' in m), false, 'SIGINT must not call process.exit');
      assert.ok(messages.some(m => m.cancelled));
      assert.ok(messages.some(m => m.returned));
    } else assert.deepEqual(result, { code: 143, sig: null });
    const db = store.open(dbPath);
    try {
      const rows = store.listTasks(db, { workspaceRoot: store.workspaceRoot(root) });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'failed');
      assert.equal(rows[0].metadata.result, 'Stopped: Fix this. No pull request yet.');
    } finally { db.close(); }
  });
}
