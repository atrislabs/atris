'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const modulePath = path.resolve(__dirname, '../lib/engine-ask.js');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  assert.fail(message);
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

for (const mode of ['explicit exit', 'uncaught exception']) {
 test(`${mode} kills each owned process group, leaving unrelated work alone`, { skip: process.platform === 'win32' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ask-exit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pidsFile = path.join(root, 'pids');
  const childCode = `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    const grandchild = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.appendFileSync(${JSON.stringify(pidsFile)}, process.pid + ' ' + grandchild.pid + '\\n');
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `;
  const runner = `
    const fs = require('node:fs');
    const { runAskProcess } = require(${JSON.stringify(modulePath)});
    for (let i = 0; i < 2; i++) runAskProcess({ bin: process.execPath, args: ['-e', ${JSON.stringify(childCode)}] }, { timeoutMs: 60000 });
    setTimeout(() => process.exit(18), 10000).unref();
    const timer = setInterval(() => {
      try { if (fs.readFileSync(${JSON.stringify(pidsFile)}, 'utf8').trim().split('\\n').length === 2) { clearInterval(timer); ${mode === 'explicit exit' ? 'process.exit(17)' : "setImmediate(() => { throw new Error('unexpected failure'); })"}; } } catch {}
    }, 20);
  `;
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  const parent = spawn(process.execPath, ['-e', runner], { stdio: 'ignore' });
  let ids = [];
  try {
    const exit = await new Promise((resolve, reject) => {
      parent.once('error', reject);
      parent.once('close', (code, signal) => resolve({ code, signal }));
    });
    assert.deepEqual(exit, { code: mode === 'explicit exit' ? 17 : 1, signal: null });
    ids = fs.readFileSync(pidsFile, 'utf8').trim().split('\n').map((line) => line.split(' ').map(Number));
    assert.equal(ids.length, 2);
    assert.ok(ids.flat().every((pid) => Number.isInteger(pid) && pid > 0));
    await waitFor(() => ids.flat().every((pid) => !alive(pid)), 'owned process groups survived parent exit');
    assert.equal(alive(unrelated.pid), true);
  } finally {
    if (!ids.length) {
      try { ids = fs.readFileSync(pidsFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => line.split(' ').map(Number)); } catch {}
    }
    for (const [pid] of ids) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
    try { process.kill(-unrelated.pid, 'SIGKILL'); } catch {}
    if (parent.exitCode === null) { try { parent.kill('SIGKILL'); } catch {} }
  }
 });
}

test('completed asks remove their parent-exit listener', async () => {
  const { runAskProcess } = require(modulePath);
  const before = process.listenerCount('exit');
  const result = await runAskProcess({ bin: process.execPath, args: ['-e', 'console.log("done")'] }, { timeoutMs: 15000 });
  assert.equal(result.ok, true);
  assert.equal(process.listenerCount('exit'), before);
});
