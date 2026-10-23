'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { printWishStats } = require('../lib/wish-stats');

test('updating an older wish does not count it as newly captured this week', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wish-capture-week-'));
  const previousHome = process.env.HOME;
  const previousLog = console.log;
  const lines = [];
  process.env.HOME = root;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    const events = [
      { id: 'wish-counter', ts: '2026-06-05T12:00:00Z', text: 'ship the counter', status: 'captured' },
      { id: 'wish-counter', ts: '2026-06-14T12:00:00Z', text: 'ship the counter', status: 'complete' },
    ];
    fs.writeFileSync(path.join(state, 'wishes.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n');
    printWishStats(root, { now: Date.parse('2026-06-15T12:00:00Z') });
    const counts = lines.find(line => /wishes this week:/i.test(line));
    assert.match(counts, /wishes this week:\s*0,\s*prior week\s+1/i);
  } finally {
    console.log = previousLog;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
