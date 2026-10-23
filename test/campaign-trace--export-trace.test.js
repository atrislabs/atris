'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { exportTrace, SCHEMA } = require('../lib/campaign-trace');

const CAMPAIGN = 'cmp-ship-billing';

let seq = 0;
function ev(type, minute, data, actor = 'builder') {
  seq += 1;
  return {
    id: `evt-${String(seq).padStart(4, '0')}`, campaign_id: CAMPAIGN, type,
    at: `2026-10-15T10:${String(minute).padStart(2, '0')}:00Z`, origin: 'laptop', seq, actor, data,
  };
}

// One mission that ran between a failing judge reading and a passing one.
function oneMissionLog() {
  seq = 0;
  return [
    ev('campaign_started', 0, { title: 'Ship billing', judge: 'node --test test/billing.test.js', budget: 5, owner: 'mission-lead', seats: ['builder'] }, 'human:keshav'),
    ev('judge_ran', 1, { passed: false, reading: 0.2 }, 'judge'),
    ev('mission_started', 2, { mission_id: 'm1', member: 'builder', objective: 'rewrite the billing parser' }),
    ev('step', 3, { mission_id: 'm1', cost_usd: 0.5 }),
    ev('mission_ended', 4, { mission_id: 'm1', outcome: 'kept', cost_usd: 0.5, runs: 1, uncosted_runs: 0 }),
    ev('judge_ran', 5, { passed: true, reading: 1 }, 'judge'),
  ];
}

// A fake ctx: a store that holds the given logs by campaign id, and
// recorders for the fail and out callbacks the command uses.
function fakeCtx(logs = {}) {
  const failures = [];
  const outs = [];
  const ctx = {
    store: { read: (id) => logs[id] || [] },
    fail: (message, code = 2) => { failures.push({ message, code }); return code; },
    out: (human, json) => { outs.push({ human, json }); },
  };
  return { ctx, failures, outs };
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-trace-export-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

test('exporting a finished campaign writes a redacted header and one row to --out', (t) => {
  const dir = tempDir(t);
  const out = path.join(dir, 'trace.jsonl');
  const { ctx, failures, outs } = fakeCtx({ [CAMPAIGN]: oneMissionLog() });

  const code = exportTrace(['export', CAMPAIGN, '--trace', '--out', out], ctx);

  assert.strictEqual(code, 0);
  assert.deepStrictEqual(failures, []);
  assert.deepStrictEqual(outs, [{
    human: `wrote 1 row and a header to ${out} (redacted)`,
    json: { ok: true, action: 'export', path: out, rows: 1, redacted: true },
  }]);

  const [header, row] = readJsonl(out);
  assert.strictEqual(header.kind, 'header');
  assert.strictEqual(header.schema, SCHEMA);
  assert.strictEqual(header.redacted, true);
  assert.strictEqual(header.rows, 1);
  assert.strictEqual(header.final.state, 'done');
  assert.strictEqual(header.final.reading, 1);
  assert.strictEqual(header.judge.runner, 'node');
  assert.match(header.campaign_id, /^cmp-[0-9a-f]{12}$/);
  assert.strictEqual(header.title, undefined, 'the title is dropped when redacted');

  assert.strictEqual(row.kind, 'step');
  assert.strictEqual(row.step, 1);
  assert.strictEqual(row.outcome, 'kept');
  assert.strictEqual(row.reading_before, 0.2);
  assert.strictEqual(row.reading_after, 1);
  assert.strictEqual(row.reward, 0.8);
  assert.strictEqual(row.cost_usd, 0.5);
  assert.strictEqual(row.done, true);
  assert.match(row.action.mission_id, /^m-[0-9a-f]{12}$/);
  assert.strictEqual(row.action.member, 'builder');
  assert.strictEqual(row.action.objective, undefined, 'objectives are dropped when redacted');
  assert.strictEqual(row.judge_summary, undefined);
});

test('the redacted file leaks no titles or objectives, and --full keeps them', (t) => {
  const dir = tempDir(t);
  const redacted = path.join(dir, 'redacted.jsonl');
  const full = path.join(dir, 'full.jsonl');
  const { ctx, failures } = fakeCtx({ [CAMPAIGN]: oneMissionLog() });

  assert.strictEqual(exportTrace(['export', CAMPAIGN, '--trace', '--out', redacted], ctx), 0);
  assert.strictEqual(exportTrace(['export', CAMPAIGN, '--trace', '--full', '--out', full], ctx), 0);
  assert.deepStrictEqual(failures, []);

  const redactedText = fs.readFileSync(redacted, 'utf8');
  assert.doesNotMatch(redactedText, /Ship billing/);
  assert.doesNotMatch(redactedText, /rewrite the billing parser/);
  assert.doesNotMatch(redactedText, /test\/billing\.test\.js/);

  const [header, row] = readJsonl(full);
  assert.strictEqual(header.redacted, false);
  assert.strictEqual(header.title, 'Ship billing');
  assert.strictEqual(header.judge.command, 'node --test test/billing.test.js');
  assert.strictEqual(header.campaign_id, CAMPAIGN);
  assert.strictEqual(row.action.mission_id, 'm1');
  assert.strictEqual(row.action.objective, 'rewrite the billing parser');
  assert.strictEqual(row.judge_summary, null);
});

test('the --out path can come before the campaign id', (t) => {
  const dir = tempDir(t);
  const out = path.join(dir, 'order.jsonl');
  const { ctx, failures } = fakeCtx({ [CAMPAIGN]: oneMissionLog() });

  assert.strictEqual(exportTrace(['export', '--out', out, CAMPAIGN, '--trace'], ctx), 0);
  assert.deepStrictEqual(failures, []);
  const [header, row] = readJsonl(out);
  assert.strictEqual(header.rows, 1);
  assert.strictEqual(row.action.member, 'builder');
});

test('without --out the trace goes to stdout and nothing is written to disk', () => {
  const { ctx, failures, outs } = fakeCtx({ [CAMPAIGN]: oneMissionLog() });
  const realWrite = process.stdout.write;
  let captured = '';
  process.stdout.write = (chunk) => { captured += chunk; return true; };
  let code;
  try {
    code = exportTrace(['export', CAMPAIGN, '--trace'], ctx);
  } finally {
    process.stdout.write = realWrite;
  }

  assert.strictEqual(code, 0);
  assert.deepStrictEqual(failures, []);
  assert.deepStrictEqual(outs, [], 'no status note when printing to stdout');
  const lines = captured.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepStrictEqual(lines.map((line) => line.kind), ['header', 'step']);
  assert.strictEqual(lines[0].schema, SCHEMA);
  assert.ok(captured.endsWith('\n'), 'the output ends with a newline');
});

test('an empty command with no campaign id fails with code 2 and writes nothing', (t) => {
  const dir = tempDir(t);
  const out = path.join(dir, 'never.jsonl');
  const { ctx, failures, outs } = fakeCtx({ [CAMPAIGN]: oneMissionLog() });

  const code = exportTrace(['export', '--trace', '--out', out], ctx);

  assert.strictEqual(code, 2);
  assert.strictEqual(failures.length, 1);
  assert.match(failures[0].message, /^name the campaign: atris campaign export <id> --trace/);
  assert.deepStrictEqual(outs, []);
  assert.strictEqual(fs.existsSync(out), false);
});

test('an unknown campaign id fails with code 1', (t) => {
  const dir = tempDir(t);
  const out = path.join(dir, 'missing.jsonl');
  const { ctx, failures } = fakeCtx({ [CAMPAIGN]: oneMissionLog() });

  const code = exportTrace(['export', 'cmp-nope', '--trace', '--out', out], ctx);

  assert.strictEqual(code, 1);
  assert.deepStrictEqual(failures, [{ message: 'no campaign cmp-nope. See them all with: atris campaign', code: 1 }]);
  assert.strictEqual(fs.existsSync(out), false);
});

test('asking for both --redact and --full fails with code 2 before any file is written', (t) => {
  const dir = tempDir(t);
  const out = path.join(dir, 'both.jsonl');
  const { ctx, failures } = fakeCtx({ [CAMPAIGN]: oneMissionLog() });

  const code = exportTrace(['export', CAMPAIGN, '--trace', '--full', '--redact', '--out', out], ctx);

  assert.strictEqual(code, 2);
  assert.deepStrictEqual(failures, [{ message: 'pick one: --redact (the default) or --full', code: 2 }]);
  assert.strictEqual(fs.existsSync(out), false);
});

test('a log with no campaign_started fails as unreadable with code 1', (t) => {
  const dir = tempDir(t);
  const out = path.join(dir, 'broken.jsonl');
  seq = 0;
  const orphan = [ev('judge_ran', 1, { passed: false, reading: 0 }, 'judge')];
  const { ctx, failures } = fakeCtx({ [CAMPAIGN]: orphan });

  const code = exportTrace(['export', CAMPAIGN, '--trace', '--out', out], ctx);

  assert.strictEqual(code, 1);
  assert.deepStrictEqual(failures, [{ message: `campaign ${CAMPAIGN} cannot be read: no_start`, code: 1 }]);
  assert.strictEqual(fs.existsSync(out), false);
});
