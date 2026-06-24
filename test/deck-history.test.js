const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { recordBuild, readHistory, historyFor, specHash } = require('../lib/deck-history');

function tmpLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-hist-'));
  return path.join(dir, 'deck-history.jsonl');
}

const SPEC = { theme: 'ink', slides: [{ type: 'statement', text: 'a' }, { type: 'close' }] };

test('specHash is stable for the same spec and differs for changed specs', () => {
  assert.equal(specHash(SPEC), specHash(JSON.parse(JSON.stringify(SPEC))));
  assert.notEqual(specHash(SPEC), specHash({ ...SPEC, theme: 'noir' }));
});

test('recordBuild appends a line and readHistory parses it', () => {
  const ledger = tmpLedger();
  const entry = recordBuild({ spec: SPEC, specPath: 'decks/a.json', presentationId: 'P1', mode: 'create', at: '2026-06-24T10:00:00Z' }, ledger);
  assert.equal(entry.slideCount, 2);
  assert.equal(entry.theme, 'ink');
  assert.equal(entry.url, 'https://docs.google.com/presentation/d/P1/edit');
  const all = readHistory(ledger);
  assert.equal(all.length, 1);
  assert.equal(all[0].presentationId, 'P1');
});

test('historyFor filters by spec path, basename, hash, and presentation id', () => {
  const ledger = tmpLedger();
  recordBuild({ spec: SPEC, specPath: 'decks/a.json', presentationId: 'P1', mode: 'create', at: '2026-06-24T10:00:00Z' }, ledger);
  recordBuild({ spec: SPEC, specPath: 'decks/a.json', presentationId: 'P1', mode: 'update', at: '2026-06-24T11:00:00Z' }, ledger);
  recordBuild({ spec: { theme: 'noir', slides: [] }, specPath: 'decks/b.json', presentationId: 'P2', mode: 'create', at: '2026-06-24T12:00:00Z' }, ledger);
  assert.equal(historyFor(undefined, ledger).length, 3);
  assert.equal(historyFor('decks/a.json', ledger).length, 2);
  assert.equal(historyFor('a.json', ledger).length, 2);
  assert.equal(historyFor('P2', ledger).length, 1);
  assert.equal(historyFor(specHash(SPEC), ledger).length, 2);
});

test('readHistory tolerates a corrupt line', () => {
  const ledger = tmpLedger();
  recordBuild({ spec: SPEC, presentationId: 'P1' }, ledger);
  fs.appendFileSync(ledger, 'not json\n');
  recordBuild({ spec: SPEC, presentationId: 'P3' }, ledger);
  const all = readHistory(ledger);
  assert.equal(all.length, 2);
});

test('readHistory on a missing ledger returns an empty list', () => {
  assert.deepEqual(readHistory(path.join(os.tmpdir(), 'nope-' + process.pid, 'x.jsonl')), []);
});
