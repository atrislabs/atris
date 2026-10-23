'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('scan prints the selected target URL with a separate competitor', async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aeo-scan-selection-'));
  const previousHome = process.env.HOME;
  process.env.HOME = scratch;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const { run } = require('../commands/aeo');
  const logs = [];
  const errors = [];
  const exit = new Error('command exited');
  t.mock.method(console, 'log', (line) => logs.push(line));
  t.mock.method(console, 'error', (line) => errors.push(line));
  t.mock.method(process, 'exit', () => { throw exit; });
  t.mock.method(AbortSignal, 'timeout', () => undefined);
  t.mock.method(globalThis, 'fetch', async (endpoint) => {
    const query = new URL(endpoint).searchParams;
    return {
      ok: true,
      json: async () => ({ url: query.get('url'), vs: query.get('vs') }),
    };
  });

  try {
    await run(['scan', 'target.example/page', '--vs', 'rival.example', '--json']);
  } catch (error) {
    if (error !== exit) throw error;
  }

  assert.deepEqual(logs, [
    '{\n  "url": "https://target.example/page",\n  "vs": "https://rival.example"\n}',
  ]);
  assert.deepEqual(errors, []);
});
