const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { upsertSourceFlag } = require('../commands/close');

const now = '2026-02-03T12:00:00.000Z';

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-upsert-source-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

function ledger(cwd) {
  return path.join(cwd, '.atris', 'state', 'closure.jsonl');
}

function events(cwd) {
  return fs.readFileSync(ledger(cwd), 'utf8').trim().split('\n').map(JSON.parse);
}

test('files a normalized source and persists the returned event with candidate fields', (t) => {
  const cwd = fixture(t);
  const result = upsertSourceFlag({
    source: '  watch:notes\n draft  ',
    what: 'review the draft',
    owner: '  sam  ',
    lane: 'life',
    ttlDays: 5,
    closeCondition: '  draft is\n approved  ',
    probe: '  node   check.js  ',
  }, cwd, { now });

  assert.strictEqual(result.filed, true);
  assert.strictEqual(result.refreshed, false);
  assert.match(result.event.id, /^close-watch-notes-draft-[a-f0-9]{7}$/);
  assert.deepStrictEqual(result.event, {
    kind: 'opened',
    at: now,
    id: result.event.id,
    what: 'review the draft',
    owner: 'sam',
    lane: 'life',
    opened_at: now,
    ttl_days: 5,
    close_condition: 'draft is approved',
    source: 'watch:notes draft',
    probe: 'node check.js',
  });
  assert.deepStrictEqual(events(cwd), [result.event]);
});

test('refuses a new source at capacity but refreshes an existing source', (t) => {
  const cwd = fixture(t);
  const original = [];
  for (let i = 0; i < 10; i += 1) {
    original.push(upsertSourceFlag({ source: `task:${i}`, what: `review ${i}` }, cwd, { now }).event);
  }
  const before = fs.readFileSync(ledger(cwd), 'utf8');
  assert.deepStrictEqual(upsertSourceFlag({ source: 'task:extra', what: 'extra' }, cwd, { now }), {
    filed: false, refreshed: false, reason: 'full',
  });
  assert.strictEqual(fs.readFileSync(ledger(cwd), 'utf8'), before);

  const later = '2026-02-04T12:00:00.000Z';
  const refreshed = upsertSourceFlag({ source: '  task:0  ', what: 'review updated', lane: 'unknown' }, cwd, { now: later });
  assert.strictEqual(refreshed.filed, true);
  assert.strictEqual(refreshed.refreshed, true);
  assert.deepStrictEqual(refreshed.event, {
    kind: 'opened', at: later, id: original[0].id,
    what: 'review updated', owner: 'operator', lane: 'code',
    opened_at: later, ttl_days: 3,
    close_condition: 'the source store resolves it', source: 'task:0',
  });
  assert.deepStrictEqual(events(cwd), [...original, refreshed.event]);
});

test('rejects absent or blank sources without creating a ledger', (t) => {
  const cwd = fixture(t);
  for (const candidate of [undefined, null, {}, { source: '' }, { source: ' \n\t ' }]) {
    assert.throws(() => upsertSourceFlag(candidate, cwd, { now }), {
      name: 'Error', message: 'source is required',
    });
  }
  assert.strictEqual(fs.existsSync(ledger(cwd)), false);
  assert.deepStrictEqual(fs.readdirSync(cwd), []);
});
