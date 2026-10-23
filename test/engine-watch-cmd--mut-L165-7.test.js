'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runEngineWatchCommand } = require('../commands/engine-watch');

const SENTINEL_STARTED = '2001-02-03T04:05:06.000Z';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-engine-watch-mut-'));
}

function writeReceipt(root, id, receiptData) {
  const runsDir = path.join(root, 'atris', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const liveLogRel = path.join('atris', 'runs', `${id}.live.log`);
  fs.writeFileSync(path.join(root, liveLogRel), 'working on it\n', 'utf8');
  fs.writeFileSync(
    path.join(runsDir, `${id}.json`),
    JSON.stringify({ live_log: liveLogRel, ...receiptData }),
    'utf8',
  );
}

// An fs that answers every call with the real fs except that receipt JSON
// reads report a sentinel started_at. If the roster lists the sentinel time,
// the injected fs is the one being read from.
function doctoringFs() {
  return new Proxy(fs, {
    get(target, prop) {
      if (prop === 'readFileSync') {
        return (filePath, ...rest) => {
          const raw = target.readFileSync(filePath, ...rest);
          if (!String(filePath).endsWith('.json')) return raw;
          const receipt = JSON.parse(raw.toString());
          receipt.started_at = SENTINEL_STARTED;
          const text = JSON.stringify(receipt);
          return Buffer.isBuffer(raw) ? Buffer.from(text) : text;
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

test('engine watch roster prints receipt fields read through the injected fs', async () => {
  const root = makeTempDir();
  const prevHome = process.env.HOME;
  process.env.HOME = root;
  const output = [];

  try {
    writeReceipt(root, 'run-live', {
      status: 'running',
      pid: 4242,
      engine: 'codex',
      started_at: '2026-10-22T10:00:00.000Z',
    });

    const exitCode = await runEngineWatchCommand([], root, {
      log: (line = '') => output.push(String(line)),
      fs: doctoringFs(),
      pidIsAlive: () => true,
      nowMs: Date.parse('2026-10-22T10:00:05.000Z'),
    });

    assert.equal(exitCode, 0);
    const row = output.find((line) => line.includes('run-live'));
    assert.ok(row, 'expected a roster row for run-live');
    assert.ok(
      row.includes(SENTINEL_STARTED),
      'roster row should show the started_at supplied by the injected fs',
    );
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
