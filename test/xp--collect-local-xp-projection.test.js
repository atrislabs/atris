'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolate home before loading xp, which captures home paths at module load.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-xp-projection-'));
const originalCwd = process.cwd();
const savedEnv = new Map();
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_') || key === 'HOME' || key === 'CODEX_STATE_DB') {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
}
process.env.HOME = root;
process.env.CODEX_STATE_DB = path.join(root, 'absent.sqlite');
// The default workspace resolver runs even with an explicit --workspace.
// Give it a local workspace marker so it never needs the caller's git setup.
fs.mkdirSync(path.join(root, 'atris'));
fs.writeFileSync(path.join(root, 'atris', 'atris.md'), 'temporary test workspace\n');
process.chdir(root);
const { collectLocalXpProjection } = require('../commands/xp');

after(() => {
  process.chdir(originalCwd);
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_') || key === 'HOME' || key === 'CODEX_STATE_DB') {
      delete process.env[key];
    }
  }
  for (const [key, value] of savedEnv) process.env[key] = value;
  fs.rmSync(root, { recursive: true, force: true });
});

function workspace(t) {
  const directory = fs.mkdtempSync(path.join(root, 'workspace-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = path.join(directory, '.atris', 'state');
  fs.mkdirSync(state, { recursive: true });
  return {
    state,
    episodes: path.join(state, 'task_episodes.jsonl'),
    collect: () => collectLocalXpProjection(['--workspace', directory]),
    directory,
  };
}

function episode(id, overrides = {}) {
  return {
    episode_id: id,
    task_id: `task-${id}`,
    created_at: '2020-02-03T12:00:00.000Z',
    state: { status: 'done', title: `Finished ${id}`, claimed_by: 'builder' },
    action: { actor: 'reviewer' },
    rl: { label: 'accepted' },
    reward: { value: 600 },
    proof: 'node --test passed',
    ...overrides,
  };
}

function jsonl(rows) {
  return rows.map(row => JSON.stringify(row)).join('\n') + '\n';
}

function receipts(state) {
  return fs.readFileSync(path.join(state, 'career_xp_receipts.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line));
}

test('collects accepted proof, persists a chain, and does not award duplicates on replay', (t) => {
  const w = workspace(t);
  fs.writeFileSync(w.episodes, jsonl([
    episode('first'),
    episode('second', { created_at: '2020-02-04T12:00:00.000Z' }),
    episode('first'),
  ]));
  const result = w.collect();
  assert.strictEqual(result.schema, 'atris.career_xp_projection.v1');
  assert.strictEqual(result.workspace_root, w.directory);
  assert.strictEqual(result.total_agent_xp, 1200);
  assert.strictEqual(result.receipts_count, 2);
  assert.strictEqual(result.collected_receipts, 2);
  assert.strictEqual(result.level, 2);
  assert.deepStrictEqual(result.next_level_progress, {
    level: 2, next_level: 3, current_xp: 200, required_xp: 1000,
    remaining_xp: 800, percent: 20,
  });
  assert.strictEqual(result.latest_accepted_proof.source_episode_id, 'second');
  assert.strictEqual(result.latest_accepted_proof.proof, 'node --test passed');
  assert.deepStrictEqual(result.sources, { 'atris-cli': 2 });
  assert.strictEqual(result.integrity_status, 'verified');
  const ledger = receipts(w.state);
  assert.deepStrictEqual(ledger.map(row => row.receipt_id), ['task_review:first', 'task_review:second']);
  assert.strictEqual(ledger[0].previous_receipt_hash, null);
  assert.strictEqual(ledger[1].previous_receipt_hash, ledger[0].receipt_hash);
  assert.strictEqual(result.integrity.head_hash, ledger[1].receipt_hash);
  assert.strictEqual(ledger[0].builder, 'builder');
  const persisted = JSON.parse(fs.readFileSync(result.ledger.projection_path, 'utf8'));
  assert.strictEqual(persisted.total_xp, 1200);

  fs.appendFileSync(w.episodes, jsonl([episode('first')]));
  const repeated = w.collect();
  assert.strictEqual(repeated.collected_receipts, 0);
  assert.strictEqual(repeated.total_xp, 1200);
  assert.deepStrictEqual(receipts(w.state), ledger);
  // generated_at, today_xp and contribution_graph intentionally have no assertions.
});

test('filters ineligible episodes and resumes an incomplete final JSON line', (t) => {
  const w = workspace(t);
  const pending = JSON.stringify(episode('later'));
  fs.writeFileSync(w.episodes, jsonl([
    episode('valid'),
    episode('no-proof', { proof: '  ' }),
    episode('no-reward', { reward: { value: 0 } }),
    episode('review', { state: { status: 'review' } }),
    episode('opt-out', { career_xp: { eligible: false } }),
    episode('rejected', { rl: { label: 'rejected' } }),
  ]) + pending.slice(0, -1));
  const first = w.collect();
  assert.strictEqual(first.total_xp, 600);
  assert.strictEqual(first.receipts_count, 1);
  assert.strictEqual(first.collected_receipts, 2);
  assert.strictEqual(first.integrity.cursor.skipped_partial_tail, true);
  assert.deepStrictEqual(receipts(w.state).map(row => [row.outcome, row.xp]), [
    ['accepted', 600], ['rejected', 0],
  ]);
  fs.appendFileSync(w.episodes, '}\n');
  const second = w.collect();
  assert.strictEqual(second.collected_receipts, 1);
  assert.strictEqual(second.total_xp, 1200);
  assert.strictEqual(second.integrity.cursor.bytes_read, fs.statSync(w.episodes).size);
  assert.strictEqual(second.integrity_status, 'verified');
});

test('returns an empty verified projection when no episode file exists', (t) => {
  const w = workspace(t);
  const result = w.collect();
  assert.strictEqual(result.total_xp, 0);
  assert.strictEqual(result.receipts_count, 0);
  assert.strictEqual(result.collected_receipts, 0);
  assert.strictEqual(result.level, 1);
  assert.strictEqual(result.latest_accepted_proof, null);
  assert.strictEqual(result.integrity_status, 'verified');
  assert.strictEqual(result.integrity.head_hash, null);
  assert.deepStrictEqual(result.local_activity.detected_providers, []);
  assert.strictEqual(result.integrity.cursor.bytes_read, 0);
  assert.ok(fs.existsSync(result.ledger.projection_path));
});

test('rejects malformed complete episode JSON without writing a projection', (t) => {
  const w = workspace(t);
  fs.writeFileSync(w.episodes, '{broken json}\n');
  assert.throws(() => w.collect(), SyntaxError);
  assert.strictEqual(fs.existsSync(path.join(w.state, 'career_xp.projection.json')), false);
  assert.strictEqual(fs.existsSync(path.join(w.state, 'career_xp_receipts.jsonl')), false);
});
