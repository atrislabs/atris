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

test('appendGmailVerdicts writes one json line per verdict', (t) => {
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
      reason: 'personal sender',
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
      reason: 'personal sender',
    },
  ]);
});

test('old verdict rows without a reason still read normally', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-gmail-verdicts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = gmailVerdictsPath(root);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{"ts":"2026-08-26T20:00:00.000Z","account":"work","verdict":"archive","message_id":"legacy"}\n');

  assert.deepEqual(readGmailVerdicts({ root }), [{
    ts: '2026-08-26T20:00:00.000Z',
    account: 'work',
    verdict: 'archive',
    message_id: 'legacy',
  }]);
});

test('verdict summary groups keep and archive counts by day and account', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-gmail-verdicts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  appendGmailVerdicts([
    { ts: '2026-08-26T20:00:00.000Z', account: 'work', verdict: 'keep', message_id: 'one' },
    { ts: '2026-08-26T21:00:00.000Z', account: 'work', verdict: 'archive', message_id: 'two' },
    { ts: '2026-08-26T22:00:00.000Z', account: 'personal', verdict: 'keep', message_id: 'three' },
    { ts: '2026-08-27T08:00:00.000Z', account: 'work', verdict: 'archive', message_id: 'four' },
  ], { root });

  const lines = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    printGmailVerdicts({ root, summary: true });
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(lines, [
    '2026-08-27 account work, keep 0, archive 1',
    '2026-08-26 account personal, keep 1, archive 0',
    '2026-08-26 account work, keep 1, archive 1',
  ]);

  lines.length = 0;
  console.log = (line) => lines.push(String(line));
  try {
    printGmailVerdicts({ root, account: 'personal', summary: true });
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(lines, ['2026-08-26 account personal, keep 1, archive 0']);
});

test('verdict listing filters by account and prints newest first', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-gmail-verdicts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  appendGmailVerdicts([
    { ts: '2026-08-26T20:00:00.000Z', account: 'work', message_id: 'old' },
    { ts: '2026-08-26T20:01:00.000Z', account: 'personal', message_id: 'other' },
    {
      ts: '2026-08-26T20:02:00.000Z',
      account: 'work',
      message_id: 'new',
      reason: 'noreply sender',
    },
  ], { root });

  assert.deepEqual(readGmailVerdicts({ root, account: 'work', limit: 1 }), [{
    ts: '2026-08-26T20:02:00.000Z',
    account: 'work',
    verdict: 'archive',
    message_id: 'new',
    reason: 'noreply sender',
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
    '2026-08-26T20:02:00.000Z archive new account work, reason noreply sender',
    '2026-08-26T20:00:00.000Z archive old account work',
  ]);
});
