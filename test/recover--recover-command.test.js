'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function workspace(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-recover-command-'));
  const saved = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => key === 'HOME' || key.startsWith('ATRIS_')));
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  process.env.HOME = root;
  const originalLog = console.log;
  try {
    const { recoverCommand } = require('../commands/recover');
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    const file = path.join(state, 'missions.jsonl');
    run({
      seed(missions) {
        fs.writeFileSync(file, missions.map((mission) => JSON.stringify({
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          ...mission,
        })).join('\n') + '\n');
      },
      invoke(args = []) {
        const lines = [];
        console.log = (...values) => lines.push(values.join(' '));
        try {
          return { code: recoverCommand(args, { root }), output: lines.join('\n') };
        } finally {
          console.log = originalLog;
        }
      },
      file,
      root,
    });
  } finally {
    console.log = originalLog;
    delete process.env.HOME;
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    Object.assign(process.env, saved);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('reports paused missions and filters by a partial mission reference without writing', () => {
  workspace(({ seed, invoke, file, root }) => {
    seed([
      { id: 'pause-alpha', objective: 'finish alpha', status: 'paused', stop_reason: 'max-ticks-reached' },
      { id: 'blocked-beta', status: 'blocked', stop_reason: 'auth-required' },
      { id: 'finished-alpha', status: 'completed', stop_reason: 'max-ticks-reached' },
    ]);
    const before = fs.readFileSync(file, 'utf8');
    const result = invoke(['alpha', '--json']);
    assert.strictEqual(result.code, 0);
    const report = JSON.parse(result.output);
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.action, 'recovery_report');
    assert.strictEqual(report.report_only, true);
    assert.strictEqual(report.receipt_path, null);
    assert.strictEqual(report.results.length, 1);
    const row = report.results[0];
    assert.strictEqual(row.mission_id, 'pause-alpha');
    assert.strictEqual(row.mission, 'finish alpha');
    assert.strictEqual(row.catalog_entry, 'max-ticks-reached');
    assert.strictEqual(row.apply, 'resume');
    assert.strictEqual(row.disposition, 'safe');
    assert.strictEqual(row.recovery_command, 'atris recover pause-alpha --apply');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
    assert.strictEqual(fs.existsSync(path.join(root, 'atris', 'runs')), false);
  });
});

test('a failed verifier without a configured command requires operator action', () => {
  workspace(({ seed, invoke }) => {
    seed([{ id: 'missing-verifier', status: 'blocked', verifier_result: { passed: false } }]);
    const result = invoke(['--json']);
    assert.strictEqual(result.code, 0);
    const rows = JSON.parse(result.output).results;
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].catalog_entry, 'verifier-failed');
    assert.strictEqual(rows[0].operator_required, true);
    assert.strictEqual(rows[0].apply, null);
    assert.strictEqual(rows[0].verifier, null);
    assert.strictEqual(rows[0].disposition, 'needs operator');
    assert.strictEqual(rows[0].happened, 'the mission verifier failed, but no verifier command is configured');
    assert.strictEqual(rows[0].recovery_command, 'atris mission status missing-verifier --json');
  });
});

test('empty workspaces and unmatched references produce empty reports', () => {
  workspace(({ seed, invoke }) => {
    assert.deepStrictEqual(invoke(), {
      code: 0,
      output: 'recovery report\nno blocked or paused missions found',
    });
    seed([{ id: 'paused-one', status: 'paused', stop_reason: 'aborted' }]);
    const result = invoke(['nonexistent', '--json']);
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(JSON.parse(result.output), {
      ok: true,
      action: 'recovery_report',
      report_only: true,
      results: [],
      receipt_path: null,
    });
  });
});
