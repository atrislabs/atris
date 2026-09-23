'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { taskReviewLanding } = require('../commands/task');

function setEnv(t, key, value) {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

function missionTask(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-receipt-unreadable-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'atris/runs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris/runs/broken-receipt.json'), '{"result": {"landing": ');
  return {
    title: 'ship the invoice export',
    status: 'review',
    workspace_root: root,
    metadata: {
      mission_id: 'mission-1',
      latest_agent_proof: 'receipt: atris/runs/broken-receipt.json',
    },
  };
}

test('a malformed mission receipt is named under ATRIS_DEBUG instead of vanishing', t => {
  setEnv(t, 'ATRIS_DEBUG', '1');
  const lines = [];
  t.mock.method(console, 'error', (...args) => { lines.push(args.join(' ')); });

  const landing = taskReviewLanding(missionTask(t));

  assert.equal(landing.happened.toLowerCase().includes('invoice export'), true);
  assert.ok(lines.some(line => line.includes('broken-receipt.json')), `debug lines: ${JSON.stringify(lines)}`);
});

test('without ATRIS_DEBUG a malformed receipt stays quiet', t => {
  setEnv(t, 'ATRIS_DEBUG', undefined);
  const lines = [];
  t.mock.method(console, 'error', (...args) => { lines.push(args.join(' ')); });
  taskReviewLanding(missionTask(t));
  assert.deepEqual(lines.filter(line => line.includes('broken-receipt.json')), []);
});
