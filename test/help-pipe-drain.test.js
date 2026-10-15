const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cli = path.join(__dirname, '..', 'bin', 'atris.js');

// A busy CI box can hand out small pipes, so stdout writes go async and sit
// in a queue. This shim makes every write wait in that queue, the same way.
const SLOW_STDOUT = `
const fs = require('node:fs');
const out = process.stdout;
const queue = [];
let timer = null;
Object.defineProperty(out, 'writableLength', {
  configurable: true,
  get: () => queue.reduce((n, item) => n + item.chunk.length, 0),
});
out.write = function write(chunk, encoding, cb) {
  if (typeof encoding === 'function') cb = encoding;
  queue.push({ chunk: Buffer.from(String(chunk)), cb });
  if (!timer) timer = setTimeout(flush, 20);
  return false;
};
// A full pipe answers EAGAIN or takes part of a chunk. Keep the rest queued
// and try again later, the way a real slow stream would.
function flush() {
  timer = null;
  while (queue.length) {
    const item = queue[0];
    let written;
    try {
      written = fs.writeSync(1, item.chunk);
    } catch (err) {
      if (err.code !== 'EAGAIN') throw err;
      timer = setTimeout(flush, 5);
      return;
    }
    if (written < item.chunk.length) {
      item.chunk = item.chunk.subarray(written);
      continue;
    }
    queue.shift();
    if (typeof item.cb === 'function') item.cb();
  }
}
`;

test('help --all prints every line even when stdout drains slowly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-help-drain-'));
  try {
    const shim = path.join(dir, 'slow-stdout.js');
    fs.writeFileSync(shim, SLOW_STDOUT);
    const run = spawnSync(process.execPath, ['--require', shim, cli, 'help', '--all'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', HOME: path.join(dir, 'home') },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /balance\s+- Show credit balance in dollars/);
    assert.match(run.stdout, /topup\s+- Buy credits and print a Stripe checkout URL/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
