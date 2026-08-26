const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  appendGmailVerdicts,
  gmailVerdictsPath,
  printGmailVerdicts,
  readGmailVerdicts,
} = require('../commands/integrations');

test('appendGmailVerdicts writes one json line per archive decision', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-gmail-verdicts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  appendGmailVerdicts([
    { ts: '2026-08-26T20:00:00.000Z', account: 'work', message_id: 'msg-1' },
    {
      ts: '2026-08-26T20:01:00.000Z',
      account: 'personal',
      message_id: 'msg-2',
      from: 'friend@example.com',
      subject: 'hello',
    },
  ], { root });

  const lines = fs.readFileSync(gmailVerdictsPath(root), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines, [
    {
      ts: '2026-08-26T20:00:00.000Z',
      account: 'work',
      verdict: 'archive',
      message_id: 'msg-1',
    },
    {
      ts: '2026-08-26T20:01:00.000Z',
      account: 'personal',
      verdict: 'archive',
      message_id: 'msg-2',
      from: 'friend@example.com',
      subject: 'hello',
    },
  ]);
});

test('verdict listing filters by account and prints newest first', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-gmail-verdicts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  appendGmailVerdicts([
    { ts: '2026-08-26T20:00:00.000Z', account: 'work', message_id: 'old' },
    { ts: '2026-08-26T20:01:00.000Z', account: 'personal', message_id: 'other' },
    { ts: '2026-08-26T20:02:00.000Z', account: 'work', message_id: 'new' },
  ], { root });

  assert.deepEqual(readGmailVerdicts({ root, account: 'work', limit: 1 }), [{
    ts: '2026-08-26T20:02:00.000Z',
    account: 'work',
    verdict: 'archive',
    message_id: 'new',
  }]);

  const lines = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    printGmailVerdicts({ root, account: 'work', limit: 2 });
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(lines, [
    '2026-08-26T20:02:00.000Z archive new account work',
    '2026-08-26T20:00:00.000Z archive old account work',
  ]);
});
