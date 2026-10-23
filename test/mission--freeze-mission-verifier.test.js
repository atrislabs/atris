'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { freezeMissionVerifier } = require('../commands/mission');

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-freeze-verifier-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mission = {
    id: 'fixture-mission',
    n: 1,
    status: 'running',
    runner: 'manual',
    objective: 'check the local fixture',
    verifier: 'node --test test/example.test.js',
    created_at: '2025-01-02T03:04:05.000Z',
    updated_at: '2025-01-02T03:04:05.000Z',
    ...overrides,
  };
  const state = path.join(root, '.atris', 'state');
  fs.mkdirSync(state, { recursive: true });
  const ledger = path.join(state, 'missions.jsonl');
  const original = `${JSON.stringify(mission)}\n`;
  fs.writeFileSync(ledger, original);
  return { root, mission, state, ledger, original };
}

function assertUnchanged(f) {
  assert.strictEqual(fs.readFileSync(f.ledger, 'utf8'), f.original);
  assert.deepStrictEqual(fs.readdirSync(f.state), ['missions.jsonl']);
}

test('returns an already frozen mission and trims input without appending history', (t) => {
  const f = fixture(t);
  assert.deepStrictEqual(freezeMissionVerifier(f.mission.id, f.mission.verifier, f.root), f.mission);
  assert.deepStrictEqual(
    freezeMissionVerifier(`  ${f.mission.id}  `, `\n${f.mission.verifier}  `, f.root),
    f.mission,
  );
  assertUnchanged(f);
});

test('rejects a different command and releases the lock for a subsequent call', (t) => {
  const f = fixture(t);
  assert.throws(
    () => freezeMissionVerifier(f.mission.id, 'node --test test/other.test.js', f.root),
    { message: 'mission verifier is already frozen to another command' },
  );
  assertUnchanged(f);
  assert.deepStrictEqual(freezeMissionVerifier(f.mission.id, f.mission.verifier, f.root), f.mission);
  assertUnchanged(f);
});

test('rejects missing missions and terminal missions without changing their history', (t) => {
  for (const status of ['complete', 'stopped']) {
    const f = fixture(t, { status, next_action: `mission ${status}` });
    assert.throws(
      () => freezeMissionVerifier(f.mission.id, f.mission.verifier, f.root),
      { message: `mission is already ${status}: ${f.mission.id}` },
    );
    assert.throws(
      () => freezeMissionVerifier('missing', f.mission.verifier, f.root),
      { message: 'mission not found: missing' },
    );
    assertUnchanged(f);
  }
});

test('rejects empty inputs and static numeric checks before creating state', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-freeze-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [id, command] of [[undefined, 'node --test'], ['  ', 'node --test'], ['fixture', ''], ['fixture', null]]) {
    assert.throws(() => freezeMissionVerifier(id, command, root), {
      message: 'mission verifier freeze requires mission and verifier',
    });
  }
  for (const command of ['test 1 -eq 1', '[ 2 -ge 1 ]']) {
    assert.throws(
      () => freezeMissionVerifier('fixture', command, root),
      /invalid mission verifier: looks like shell substitution expanded/,
    );
  }
  assert.deepStrictEqual(fs.readdirSync(root), []);
});
