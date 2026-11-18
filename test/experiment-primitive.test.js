'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const prim = require('../lib/experiment-primitive');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-exp-test-'));
}

test('propose, score, sample gate, compare, and decide roundtrip', () => {
  const root = tempDir();
  try {
    const a = prim.propose({
      root,
      scopeType: 'loop',
      scopeId: 'conversion',
      loop: 'conversion',
      guess: 'One-line orb pitch lifts clicks',
      minN: 5,
      ref: 'exp-a',
    });
    assert.equal(a.replayed, false);
    assert.equal(a.experiment.status, 'running');
    assert.equal(a.experiment.ready_to_decide, false);

    // Ref replay returns the same experiment id.
    const replay = prim.propose({ root, scopeType: 'loop', scopeId: 'conversion', guess: 'ignored', ref: 'exp-a' });
    assert.equal(replay.replayed, true);
    assert.equal(replay.experiment.id, a.experiment.id);

    const b = prim.propose({
      root,
      scopeType: 'member_goal',
      scopeId: 'goal-2',
      guess: 'Two-line pitch lifts clicks',
      minN: 5,
    });

    // Premature decision below min_n=5 throws unless forced.
    prim.score({ root, id: a.experiment.id, sample: 3, rate: 0.33 });
    assert.throws(() => prim.decide({ root, id: a.experiment.id, decision: 'accepted' }), /Need at least 5 samples/);

    // Pass min_n=5 on both and compare.
    prim.score({ root, id: a.experiment.id, sample: 6, rate: 0.5 });
    prim.score({ root, id: b.experiment.id, sample: 5, rate: 0.2 });

    const compared = prim.compare({ root, ids: [a.experiment.id.slice(0, 8), b.experiment.id] });
    assert.equal(compared.best, a.experiment.id);

    const closed = prim.decide({
      root,
      id: a.experiment.id.slice(0, 8),
      decision: 'accepted',
      learned: 'One-line pitch won 50% vs 20%',
      value: 5,
    });
    assert.equal(closed.experiment.status, 'accepted');
    assert.equal(closed.experiment.learned, 'One-line pitch won 50% vs 20%');
    assert.equal(closed.experiment.value, 5);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('atris experiment CLI works end-to-end with --json', () => {
  const root = tempDir();
  const bin = path.resolve(__dirname, '..', 'bin', 'atris.js');
  try {
    const out = execFileSync(
      process.execPath,
      [bin, 'experiment', 'propose', 'Short CTA wins', '--scope', 'page:follow-up', '--loop', 'conversion', '--json'],
      { cwd: root, encoding: 'utf8' }
    );
    const created = JSON.parse(out);
    assert.equal(created.experiment.scope_type, 'page');
    assert.equal(created.experiment.scope_id, 'follow-up');
    assert.equal(created.experiment.loop, 'conversion');

    const listed = JSON.parse(execFileSync(process.execPath, [bin, 'experiment', 'list', '--json'], { cwd: root, encoding: 'utf8' }));
    assert.equal(listed.experiments.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('syncByRef creates and updates member_goal experiments idempotently', () => {
  const root = tempDir();
  try {
    const first = prim.syncByRef({
      root,
      ref: 'member:g1:e1',
      scopeType: 'member_goal',
      scopeId: 'g1',
      guess: 'Ship daily digest',
      status: 'proposed',
    });
    assert.equal(first.status, 'proposed');
    const updated = prim.syncByRef({
      root,
      ref: 'member:g1:e1',
      scopeType: 'member_goal',
      scopeId: 'g1',
      guess: 'Ship daily digest',
      status: 'accepted',
      learned: 'Digest ran clean',
      value: 5,
    });
    assert.equal(updated.id, first.id);
    assert.equal(updated.status, 'accepted');
    assert.equal(updated.learned, 'Digest ran clean');
    assert.equal(updated.value, 5);
    assert.equal(prim.list({ root, scopeType: 'member_goal' }).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('syncCloud pushes local experiments, preserves remote refs on pull, merges open tests, and respects dry-run', async () => {
  const root = tempDir();
  try {
    // 1. Local closed experiment + open shared experiment (no ref prefix collision).
    const localClosed = prim.propose({
      root,
      scopeType: 'raise',
      scopeId: 'raise-1',
      guess: 'Short teaser wins intros',
      minN: 5,
    }).experiment;
    prim.score({ root, id: localClosed.id, sample: 6, rate: 0.5 });
    prim.decide({ root, id: localClosed.id, decision: 'accepted', learned: '6 reached, 3 meetings' });

    const localSharedOpen = prim.propose({
      root,
      scopeType: 'nexus_list',
      scopeId: 'list-1',
      guess: 'Direct founder note beats formal pitch',
      ref: 'web:list-1',
    }).experiment;

    const remoteStore = [
      {
        id: 'cloud-shared-1',
        scope_type: 'nexus_list',
        scope_id: 'list-1',
        guess: 'Direct founder note beats formal pitch',
        status: 'accepted',
        verifier: 'nexus_list',
        min_n: 5,
        sample: 7,
        counts: { reached: 7, replied: 4 },
        rates: { primary_rate: 0.57 },
        learned: 'Web scored 57%',
        ref: 'web:list-1',
      },
      {
        id: 'cloud-only-1',
        scope_type: 'raise',
        scope_id: 'raise-2',
        guess: 'Partner warm intro before cold deck',
        status: 'running',
        verifier: 'rainmaker',
        min_n: 5,
        sample: 2,
        counts: { reached: 2, meetings: 1 },
        rates: { primary_rate: 0.5 },
        ref: null,
      },
    ];

    const calls = [];
    const mockRequest = async (pathname, options = {}) => {
      calls.push([options.method || 'GET', pathname]);
      if (pathname.startsWith('/experiments') && options.method === 'POST' && pathname === '/experiments') {
        const body = options.body;
        const found = remoteStore.find((r) => r.ref && r.ref === body.ref);
        if (found) return { ok: true, status: 200, data: { experiment: found, replayed: true } };
        const created = { id: 'cloud-new-1', status: body.status || 'running', counts: {}, rates: {}, ...body };
        remoteStore.push(created);
        return { ok: true, status: 200, data: { experiment: created, replayed: false } };
      }
      if (pathname.endsWith('/score') && options.method === 'POST') {
        const id = pathname.split('/')[2];
        const row = remoteStore.find((r) => r.id === id);
        Object.assign(row, { counts: options.body.counts, rates: options.body.rates });
        return { ok: true, status: 200, data: { experiment: row } };
      }
      if (pathname.endsWith('/decide') && options.method === 'POST') {
        const id = pathname.split('/')[2];
        const row = remoteStore.find((r) => r.id === id);
        Object.assign(row, { status: options.body.decision, learned: options.body.learned });
        return { ok: true, status: 200, data: { experiment: row } };
      }
      if (pathname === '/experiments' && (options.method || 'GET') === 'GET') {
        return { ok: true, status: 200, data: { experiments: remoteStore } };
      }
      return { ok: false, status: 404, data: { detail: 'not found' } };
    };

    // Dry-run makes zero POST requests and writes nothing locally.
    const dry = await prim.syncCloud({ root, dryRun: true, request: mockRequest, token: 't' });
    assert.equal(dry.dry_run, true);
    assert.equal(dry.pushed, 2);
    assert.equal(dry.pulled, 1);
    assert.equal(dry.updated, 1);
    assert.equal(calls.some(([m]) => m === 'POST'), false);
    assert.equal(prim.list({ root }).length, 2);

    calls.length = 0;
    const synced = await prim.syncCloud({ root, request: mockRequest, token: 't' });
    assert.equal(synced.pushed, 1);
    assert.equal(synced.scored, 1);
    assert.equal(synced.decided, 1);
    assert.equal(synced.pulled, 1);
    assert.equal(synced.updated, 1);

    const all = prim.list({ root });
    assert.equal(all.length, 3);
    const mergedOpen = all.find((r) => r.id === localSharedOpen.id);
    assert.equal(mergedOpen.status, 'accepted');
    assert.equal(mergedOpen.learned, 'Web scored 57%');
    assert.equal(mergedOpen.ref, 'web:list-1');

    const pulledOnly = all.find((r) => r.id === 'cloud-only-1');
    assert.equal(pulledOnly.ref, null); // Never invented a cli: prefix on pulled rows.
    assert.equal(pulledOnly.cloud_id, 'cloud-only-1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
