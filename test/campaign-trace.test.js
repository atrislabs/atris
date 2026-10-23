'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildTrace, readingOf, traceLines, SCHEMA } = require('../lib/campaign-trace');
const { campaignCommand } = require('../commands/campaign');
const { createMemoryStore } = require('../lib/campaign-store');

const FIXTURES = path.join(__dirname, 'fixtures', 'campaign');

let seq = 0;
function ev(type, minute, data, actor = 'builder') {
  seq += 1;
  return {
    id: `evt-${String(seq).padStart(4, '0')}`, campaign_id: 'cmp-trace', type,
    at: `2026-10-15T10:${String(minute).padStart(2, '0')}:00Z`, origin: 'laptop', seq, actor, data,
  };
}

// Two batches: m1 and m2 end between the first two judge runs, m3 ends alone
// before the run that passes. m4 is still running when the log ends.
function multiBatchLog() {
  seq = 0;
  return [
    ev('campaign_started', 0, { title: 'Ship the secret thing', judge: 'node --test test/secret.test.js', budget: 10, owner: 'mission-lead', seats: ['builder', 'validator'] }, 'human:keshav'),
    ev('judge_ran', 1, { passed: false, summary: 'pass 1, fail 4', reading: 0.2 }, 'judge'),
    ev('mission_started', 2, { mission_id: 'm1', member: 'builder', objective: 'rewrite the secret parser' }),
    ev('mission_started', 2, { mission_id: 'm2', member: 'validator', objective: 'probe secret edge cases' }, 'validator'),
    ev('step', 3, { mission_id: 'm1', cost_usd: 0.5 }),
    ev('step', 3, { mission_id: 'm2', tokens: 900 }, 'validator'),
    ev('mission_ended', 4, { mission_id: 'm1', outcome: 'kept', cost_usd: 0.5, runs: 1, uncosted_runs: 0 }),
    ev('mission_ended', 5, { mission_id: 'm2', outcome: 'failed', cost_usd: 0 }, 'validator'),
    ev('judge_ran', 6, { passed: false, summary: 'pass 3, fail 2', output_tail: 'ℹ pass 3\nℹ fail 2\nsecret stack trace' }, 'judge'),
    ev('mission_proposed', 7, { mission_id: 'm3', member: 'builder', objective: 'fix the secret date bug', verify: 'node --test test/secret-date.test.js', estimate_usd: 1 }),
    ev('mission_claimed', 7, { mission_id: 'm3', claim_key: 'fix the secret date bug' }),
    ev('step', 7, { mission_id: 'm3', kind: 'plan', engine: 'claude' }, 'mission-lead'),
    ev('mission_started', 8, { mission_id: 'm3', member: 'builder' }),
    ev('ask_opened', 9, { ask_id: 'a1', question: 'may I push the secret branch?', mission_id: 'm3' }),
    ev('ask_answered', 10, { ask_id: 'a1', answer: 'yes, secret ok' }, 'human:keshav'),
    ev('step', 11, { mission_id: 'm3', cost_usd: 1.25 }),
    ev('mission_ended', 12, { mission_id: 'm3', outcome: 'kept', cost_usd: 1.25, runs: 2, uncosted_runs: 1 }),
    ev('judge_ran', 13, { passed: true, summary: 'pass 5, fail 0', reading: 1 }, 'judge'),
    ev('mission_started', 14, { mission_id: 'm4', member: 'validator' }, 'validator'),
  ];
}

test('a multi-batch log becomes one row per mission with batch credit', () => {
  const { header, rows } = buildTrace(multiBatchLog(), { redact: false });
  assert.equal(header.kind, 'header');
  assert.equal(header.schema, SCHEMA);
  assert.equal(header.rows, 3);
  assert.equal(header.batches, 2);
  assert.equal(header.pending_missions, 1);
  assert.deepEqual(header.final, { state: 'done', stop_reason: 'judge_passed', confidence: 'answered', reading: 1, standing: false, budget: { total: 10, spent: 1.75, reserved: 0, available: 8.25 } });
  assert.equal(header.judge.command, 'node --test test/secret.test.js');

  assert.deepEqual(rows.map((r) => [r.step, r.action.mission_id, r.batch.index, r.batch.size]), [[1, 'm1', 1, 2], [2, 'm2', 1, 2], [3, 'm3', 2, 1]]);
  // Batch 1: 0.2 to 0.6 (read from the summary counts), split across two missions.
  assert.equal(rows[0].reading_before, 0.2);
  assert.equal(rows[0].reading_after, 0.6);
  assert.equal(rows[0].reading_source, 'summary');
  assert.equal(rows[0].reward, 0.2);
  assert.equal(rows[1].reward, 0.2);
  assert.match(rows[0].credit_note, /one of 2 missions/);
  assert.equal(rows[0].done, false);
  assert.equal(rows[0].judge_passed, false);
  assert.equal(rows[1].uncosted_ticks, 1, 'a tick with no dollar figure is counted');
  assert.equal(rows[1].outcome, 'failed');
  // Batch 2: 0.6 to 1, all credit to m3, and the run that passed ends the campaign.
  const m3 = rows[2];
  assert.equal(m3.reward, 0.4);
  assert.equal(m3.credit_note, null);
  assert.equal(m3.reading_source, 'graded');
  assert.equal(m3.done, true);
  assert.equal(m3.judge_passed, true);
  assert.equal(m3.cost_usd, 1.25);
  assert.equal(m3.ticks, 2);
  assert.equal(m3.uncosted_ticks, 1);
  assert.equal(m3.human_asks, 1);
  assert.deepEqual(m3.asks, [{ question: 'may I push the secret branch?', answer: 'yes, secret ok' }]);
  assert.deepEqual(m3.action, { mission_id: 'm3', kind: 'mission', member: 'builder', engine: null, estimate_usd: 1, objective: 'fix the secret date bug', verify: 'node --test test/secret-date.test.js' });
  // State is the view just before the mission's first event.
  assert.equal(m3.state_before.reading, 0.6);
  assert.equal(m3.state_before.judge_runs, 2);
  assert.deepEqual(m3.state_before.budget, { total: 10, spent: 0.5, reserved: 0, available: 9.5 });
  assert.deepEqual(m3.state_before.missions, { proposed: 0, claimed: 0, running: 0, ended: 2, vetoed: 0, dropped: 0 });
  assert.equal(rows[1].state_before.missions.running, 1, 'm1 was already running when m2 started');
});

test('redacted by default: no free text, pseudonymous ids, people hidden', () => {
  const events = multiBatchLog();
  events.push(ev('mission_started', 15, { mission_id: 'm5', member: 'human:keshav' }, 'human:keshav'));
  events.push(ev('mission_ended', 16, { mission_id: 'm5', outcome: 'kept', cost_usd: 0 }, 'human:keshav'));
  const trace = buildTrace(events);
  const text = traceLines(trace);
  assert.equal(trace.header.redacted, true);
  assert.doesNotMatch(text, /secret|keshav/i, 'titles, objectives, judge, answers, output, and people stay out');
  assert.match(trace.header.campaign_id, /^cmp-[0-9a-f]{12}$/);
  assert.match(trace.rows[0].action.mission_id, /^m-[0-9a-f]{12}$/);
  assert.equal(trace.rows[3].action.member, 'human');
  assert.equal(trace.rows[3].credit_note, 'no judge run after this mission yet, so it has no reward');
  assert.equal(trace.rows[3].reward, null);
  assert.equal(trace.rows[3].done, true, 'the campaign had already finished');
  assert.equal(trace.rows[2].action.objective, undefined);
  assert.equal(trace.rows[2].judge_output_tail, undefined);
  assert.equal(trace.header.judge.runner, 'node');
  // Numbers survive redaction unchanged.
  const full = buildTrace(events, { redact: false });
  assert.deepEqual(trace.rows.map((r) => [r.reward, r.cost_usd, r.outcome]), full.rows.map((r) => [r.reward, r.cost_usd, r.outcome]));
  assert.equal(full.rows[1].judge_output_tail, 'ℹ pass 3\nℹ fail 2\nsecret stack trace');
});

test('actual work engines override the requested runner and receipt paths stay private by default', () => {
  seq = 0;
  const events = [
    ev('campaign_started', 0, { title: 'Execute', judge: 'false', budget: 10 }),
    ev('mission_started', 1, { mission_id: 'm-work', member: 'builder', engine: 'codex_goal' }),
    ev('step', 2, { mission_id: 'm-work', kind: 'plan', engine: 'codex' }),
    ev('step', 3, { mission_id: 'm-work', engine: 'claude', cost_usd: 0 }),
    ev('mission_ended', 4, { mission_id: 'm-work', outcome: 'kept', cost_usd: 0, receipt_path: 'atris/runs/private-job.json' }),
  ];
  const full = buildTrace(events, { redact: false });
  assert.equal(full.rows[0].action.engine, 'claude');
  assert.deepEqual(full.rows[0].execution_engines, ['claude']);
  assert.equal(full.rows[0].receipt_path, 'atris/runs/private-job.json');
  const redacted = buildTrace(events);
  assert.equal(redacted.rows[0].receipt_path, undefined);
  assert.equal(redacted.rows[0].execution_engines, undefined);
  assert.doesNotMatch(traceLines(redacted), /private-job/);
});

test('the same events in any order give the same trace', () => {
  const events = multiBatchLog();
  const shuffled = events.slice().reverse();
  shuffled.push(events[4]);
  assert.equal(traceLines(buildTrace(shuffled)), traceLines(buildTrace(events)));
});

test('a reading falls back from graded to summary counts to pass or fail', () => {
  assert.deepEqual(readingOf({ passed: false, reading: 0.4 }), { value: 0.4, source: 'graded' });
  assert.deepEqual(readingOf({ passed: false, summary: 'pass 1, fail 3' }), { value: 0.25, source: 'summary' });
  assert.deepEqual(readingOf({ passed: true, summary: 'ℹ duration_ms 80' }), { value: 1, source: 'pass_fail' });
  assert.deepEqual(readingOf({ passed: false, summary: "diff: 'simple'" }), { value: 0, source: 'pass_fail' });
  assert.deepEqual(readingOf(null), { value: null, source: null });
});

test('every golden file folds into a trace that agrees with its expected view', () => {
  const files = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.json') && f !== 'MANIFEST.json' && f !== 'decide-cases.json');
  assert.ok(files.length >= 15);
  for (const file of files) {
    const golden = JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8'));
    const trace = buildTrace(golden.events, { redact: false });
    if (golden.expected.error) {
      assert.deepEqual(trace, { error: golden.expected.error }, file);
      continue;
    }
    const view = golden.expected;
    assert.equal(trace.header.final.state, view.state, file);
    assert.deepEqual(trace.header.final.budget, view.budget, file);
    const ended = view.missions.filter((m) => m.status === 'ended');
    assert.deepEqual(trace.rows.map((r) => r.action.mission_id).sort(), ended.map((m) => m.id).sort(), file);
    for (const row of trace.rows) {
      const mission = ended.find((m) => m.id === row.action.mission_id);
      assert.equal(row.cost_usd, mission.cost_usd, `${file} ${mission.id}`);
      assert.equal(row.outcome, mission.outcome, `${file} ${mission.id}`);
      if (row.reward !== null) assert.ok(row.reward >= -1 && row.reward <= 1, file);
    }
    assert.equal(trace.header.judge.runs, view.judge_runs, file);
    // The first copy of a duplicate id wins, so only logs without duplicates can be reordered freely.
    if (new Set(golden.events.map((e) => e.id)).size === golden.events.length) {
      assert.equal(traceLines(buildTrace(golden.events)), traceLines(buildTrace(golden.events.slice().reverse())), `${file} is order-independent`);
    }
  }
});

async function exportVia(store, args) {
  const chunks = [];
  const logs = [];
  const saved = { write: process.stdout.write, log: console.log, error: console.error };
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  console.log = (line) => logs.push(String(line));
  console.error = (line) => logs.push(String(line));
  let code;
  try {
    code = await campaignCommand(args, { store, actor: 'human:keshav' });
  } finally {
    process.stdout.write = saved.write;
    console.log = saved.log;
    console.error = saved.error;
  }
  return { code, stdout: chunks.join(''), logs: logs.join('\n') };
}

test('atris campaign export writes JSONL, redacted unless --full', async () => {
  const store = createMemoryStore({ origin: 'laptop' });
  for (const event of multiBatchLog()) store.ingest(event);
  const plain = await exportVia(store, ['export', 'cmp-trace', '--trace']);
  assert.equal(plain.code, 0, plain.logs);
  const rows = plain.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows.length, 4);
  assert.equal(rows[0].kind, 'header');
  assert.equal(rows[0].redacted, true);
  assert.doesNotMatch(plain.stdout, /secret/);

  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'trace-'));
  const out = path.join(dir, 'trace.jsonl');
  const full = await exportVia(store, ['export', '--out', out, 'cmp-trace', '--trace', '--full']);
  assert.equal(full.code, 0, full.logs);
  assert.match(full.logs, /wrote 3 rows and a header/);
  assert.match(fs.readFileSync(out, 'utf8'), /fix the secret date bug/);

  assert.equal((await exportVia(store, ['export', 'cmp-nope', '--trace'])).code, 1);
  assert.equal((await exportVia(store, ['export', 'cmp-trace', '--full', '--redact'])).code, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
