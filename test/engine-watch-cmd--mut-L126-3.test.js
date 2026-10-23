'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runEngineWatchCommand } = require('../commands/engine-watch');

test('following an emptied, rotated log resets the offset before its replacement arrives', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-watch-rotation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runs = path.join(root, 'atris', 'runs');
  fs.mkdirSync(runs, { recursive: true });
  const logPath = path.join(runs, 'rotation.live.log');
  const receiptPath = path.join(runs, 'rotation.json');
  const receipt = {
    engine: 'fixture',
    status: 'running',
    started_at: '2000-01-01T00:00:00.000Z',
    live_log: logPath,
  };
  fs.writeFileSync(logPath, 'old\n');
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));

  let poll;
  const timer = {};
  t.mock.method(global, 'setInterval', (callback) => {
    poll = callback;
    return timer;
  });
  t.mock.method(global, 'clearInterval', (handle) => assert.equal(handle, timer));

  let rotating = false;
  const rotatingFs = Object.create(fs);
  rotatingFs.statSync = (file) => {
    const stat = fs.statSync(file);
    // Model rotation between stat and open: the empty old file disappears.
    if (rotating && file === logPath && stat.size === 0) fs.unlinkSync(logPath);
    return stat;
  };
  rotatingFs.readFileSync = (file, encoding) => {
    if (rotating && file === receiptPath) {
      fs.writeFileSync(logPath, 'new\n');
      return JSON.stringify({ ...receipt, status: 'completed' });
    }
    return fs.readFileSync(file, encoding);
  };

  const messages = [];
  const output = [];
  const completion = runEngineWatchCommand(['rotation'], root, {
    fs: rotatingFs,
    pidIsAlive: () => true,
    log: (message) => messages.push(message),
    write: (chunk) => output.push(chunk),
  });
  assert.equal(typeof poll, 'function');
  fs.truncateSync(logPath, 0);
  rotating = true;
  poll();

  assert.equal(await completion, 0);
  assert.deepEqual(messages, [
    'rotation  fixture  running  started 2000-01-01T00:00:00.000Z',
    'old',
  ]);
  assert.deepEqual(output, ['new\n']);
});
