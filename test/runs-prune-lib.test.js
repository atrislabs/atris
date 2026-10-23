'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pruneRuns, runsPruneLines, formatBytes } = require('../lib/runs-prune');

const nowMs = Date.UTC(2026, 9, 23);
const day = 86400000;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-prune-lib-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    write(relative, content, ageDays = 30) {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      const time = new Date(nowMs - ageDays * day);
      fs.utimesSync(file, time, time);
      return file;
    },
  };
}

test('preview preserves referenced siblings, recent files, newest files, and archives', (t) => {
  const { root, write } = fixture(t);
  const old = write('atris/runs/stale/log.txt', 'old');
  write('atris/runs/proof/receipt.json', '{}');
  write('atris/runs/proof/output.txt', 'proof');
  write('atris/runs/recent.txt', 'recent', 2);
  write('atris/runs/newest.txt', 'newest', 1);
  const archived = write('atris/runs/_archive/previous.json', '{}');
  write('.atris/state/task.json', JSON.stringify({ proof: 'atris/runs/proof/receipt.json' }));

  const result = pruneRuns(root, { nowMs, keepDays: 14, keepNewest: 1 });

  assert.strictEqual(result.action, 'runs_prune_preview');
  assert.strictEqual(result.applied, false);
  assert.strictEqual(result.total_files, 5);
  assert.strictEqual(result.referenced_files, 2);
  assert.strictEqual(result.recent_files, 2);
  assert.strictEqual(result.newest_files, 1);
  assert.deepStrictEqual(result.candidates, [
    { path: 'atris/runs/stale/log.txt', bytes: 3, age_days: 30, kind: 'txt' },
  ]);
  assert.strictEqual(result.prune_bytes, 3);
  assert.strictEqual(result.deleted_count, 0);
  assert.strictEqual(result.manifest_path, null);
  assert.strictEqual(fs.readFileSync(old, 'utf8'), 'old');
  assert.strictEqual(fs.existsSync(archived), true);
  assert.strictEqual(fs.existsSync(path.join(root, 'atris/runs/_archive/prune.json')), false);
});

test('apply deletes old files, removes empty directories, and saves compact receipts', (t) => {
  const { root, write } = fixture(t);
  const receipt = {
    schema: 'receipt.v1',
    mission: { id: 'example', objective: 'prove cleanup', owner: 'tester' },
    created_at: '2026-09-23T00:00:00.000Z',
    result: { verifier_result: { command: 'node --test', passed: true }, kind: 'check', tick: { summary: 'passed' } },
    extra: 'not retained',
  };
  const old = write('atris/runs/old/nested/receipt.json', JSON.stringify(receipt));
  const result = pruneRuns(root, { nowMs, apply: true, keepDays: 0, keepNewest: 0 });

  assert.strictEqual(result.action, 'runs_pruned');
  assert.strictEqual(result.deleted_count, 1);
  assert.deepStrictEqual(result.deleted, ['atris/runs/old/nested/receipt.json']);
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(fs.existsSync(old), false);
  assert.strictEqual(fs.existsSync(path.join(root, 'atris/runs/old')), false);
  assert.match(result.manifest_path, /^atris\/runs\/_archive\/prune-.*\.json$/);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, result.manifest_path), 'utf8'));
  assert.strictEqual(manifest.schema, 'atris.runs_prune_manifest.v1');
  assert.strictEqual(manifest.pruned_count, 1);
  assert.strictEqual(manifest.pruned_bytes, Buffer.byteLength(JSON.stringify(receipt)));
  assert.deepStrictEqual(manifest.entries[0].compact, {
    schema: 'receipt.v1', mission_id: 'example', objective: 'prove cleanup', owner: 'tester',
    at: receipt.created_at, verifier: 'node --test', passed: true, kind: 'check', summary: 'passed',
  });
  assert.strictEqual(pruneRuns(root, { nowMs }).total_files, 0);
});

test('archive can be disabled and output describes the resulting deletion', (t) => {
  const { root, write } = fixture(t);
  write('atris/runs/old.txt', 'discard');
  const result = pruneRuns(root, { nowMs, apply: true, archive: false, keepNewest: 0 });
  assert.strictEqual(result.deleted_count, 1);
  assert.strictEqual(result.manifest_path, null);
  assert.strictEqual(fs.existsSync(path.join(root, 'atris/runs/_archive')), false);
  assert.strictEqual(runsPruneLines(result)[1], '  Changed: Pruned 1 old run file(s).');
  assert.strictEqual(runsPruneLines(result)[3], '  Proof: No manifest was needed.');
  assert.strictEqual(formatBytes(1023), '1023 B');
  assert.strictEqual(formatBytes(1024), '1.0 KB');
  assert.strictEqual(formatBytes(1048576), '1.0 MB');
});
