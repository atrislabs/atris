'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-twin-mission-'));
const savedEnv = new Map();
for (const key of Object.keys(process.env)) {
  if (key === 'HOME' || key.startsWith('ATRIS_') || key.startsWith('GIT_')) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
}
process.env.HOME = sandbox;
// Prevent git from discovering a repository above the temporary fixtures.
process.env.GIT_CEILING_DIRECTORIES = sandbox;
after(() => {
  delete process.env.HOME;
  delete process.env.GIT_CEILING_DIRECTORIES;
  for (const [key, value] of savedEnv) process.env[key] = value;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const { findActiveTwinMission } = require('../commands/mission');

function fixture(rows = []) {
  const root = fs.mkdtempSync(path.join(sandbox, 'workspace-'));
  const state = path.join(root, '.atris', 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'missions.jsonl'), rows.map(JSON.stringify).join('\n'));
  return root;
}

function mission(id, overrides = {}) {
  return {
    id,
    objective: 'Ship the reply check',
    owner: 'alex',
    status: 'running',
    verifier: 'node --test',
    updated_at: '2025-01-01T12:00:00.000Z',
    ...overrides,
  };
}

test('matches normalized objective and owner for each active status', () => {
  for (const status of ['planning', 'ready', 'running']) {
    const expected = mission(`match-${status}`, {
      status,
      objective: '  SHIP\n the   reply check  ',
      owner: ' ALEX ',
    });
    const root = fixture([
      expected,
      mission('other-owner', { owner: 'sam', updated_at: '2025-01-03T12:00:00.000Z' }),
      mission('other-objective', { objective: 'Ship another check', updated_at: '2025-01-02T12:00:00.000Z' }),
    ]);
    assert.deepStrictEqual(findActiveTwinMission('ship the reply\tcheck', 'alex', root), expected);
  }
});

test('excludes inactive missions and uses the latest saved state per id', () => {
  const rows = ['paused', 'blocked', 'stopped', 'complete'].map(status => mission(status, { status }));
  rows.push(mission('changed'), mission('changed', { status: 'paused' }));
  const root = fixture(rows);
  assert.strictEqual(findActiveTwinMission('Ship the reply check', 'alex', root), null);
});

test('chooses the most recently updated matching local mission', () => {
  const newest = mission('newest', { updated_at: '2025-02-01T12:00:00.000Z' });
  const root = fixture([newest, mission('older')]);
  assert.deepStrictEqual(findActiveTwinMission('Ship the reply check', 'alex', root), newest);
});

test('returns null for empty objectives, absent state, and malformed ledger rows', () => {
  const root = fixture([mission('present')]);
  for (const objective of ['', ' \n\t ', null, undefined]) {
    assert.strictEqual(findActiveTwinMission(objective, 'alex', root), null);
  }
  const emptyRoot = fs.mkdtempSync(path.join(sandbox, 'empty-'));
  assert.strictEqual(findActiveTwinMission('Ship the reply check', 'alex', emptyRoot), null);
  const ledger = path.join(root, '.atris', 'state', 'missions.jsonl');
  fs.writeFileSync(ledger, 'not json\nnull\n{}\n');
  assert.strictEqual(findActiveTwinMission('Ship the reply check', 'alex', root), null);
});
