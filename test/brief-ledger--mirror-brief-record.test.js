'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mirrorBriefRecord } = require('../lib/brief-ledger');

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mirror-brief-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('mirrorBriefRecord creates the ledger and appends unchanged JSON records', (t) => {
  const root = temporaryRoot(t);
  const file = path.join(root, '.atris', 'state', 'briefs.jsonl');
  const first = {
    brief_id: 'brief-fixed',
    ts: '2024-01-02T03:04:05.000Z',
    prompt_text: 'first line\nsecond line with "quotes"',
    context: { worktree: root, base_ref: 'main' },
    outcome: null,
  };
  const second = { ...first, outcome: { result: 'pass', ts: '2024-01-02T04:04:05.000Z' } };

  assert.strictEqual(mirrorBriefRecord(root, first), true);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), `${JSON.stringify(first)}\n`);
  assert.strictEqual(mirrorBriefRecord(root, second), true);
  const contents = fs.readFileSync(file, 'utf8');
  assert.strictEqual(contents, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
  assert.deepStrictEqual(contents.trimEnd().split('\n').map(JSON.parse), [first, second]);
});

test('mirrorBriefRecord trims the destination and accepts an empty record', (t) => {
  const root = temporaryRoot(t);

  assert.strictEqual(mirrorBriefRecord(`  ${root}\n`, {}), true);
  assert.strictEqual(fs.readFileSync(path.join(root, '.atris', 'state', 'briefs.jsonl'), 'utf8'), '{}\n');
});

test('mirrorBriefRecord returns false for empty or nonexistent destinations', (t) => {
  const root = temporaryRoot(t);
  const missing = path.join(root, 'missing');

  for (const destination of [undefined, null, '', ' \t\n', missing]) {
    assert.strictEqual(mirrorBriefRecord(destination, {}), false);
  }
  assert.deepStrictEqual(fs.readdirSync(root), []);
});

test('mirrorBriefRecord returns false when a file blocks ledger creation', (t) => {
  const root = temporaryRoot(t);
  const blocker = path.join(root, '.atris');
  fs.writeFileSync(blocker, 'keep this file', 'utf8');

  assert.strictEqual(mirrorBriefRecord(root, { brief_id: 'blocked' }), false);
  assert.strictEqual(fs.readFileSync(blocker, 'utf8'), 'keep this file');
  assert.deepStrictEqual(fs.readdirSync(root), ['.atris']);
});
