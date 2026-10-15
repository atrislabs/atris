// Campaign traces: a campaign's event log as reinforcement-learning rows.
// State is the folded view, an action is one mission, the reward is the
// change in the judge's reading, and cost is the dollars the mission spent.
// buildTrace is pure and deterministic: the same events give the same rows.
// Doc: atris/features/campaign/traces.md.

'use strict';

const crypto = require('crypto');
const { compareEvents, fold } = require('./campaign-core');
const { judgeReading } = require('./campaign-reading');

const SCHEMA = 'atris.campaign.trace';
const VERSION = 1;

const PRIVACY = {
  redacted: 'Redacted: titles, objectives, verify commands, the judge command, judge summaries and output, and ask text are dropped. Campaign and mission ids are replaced by stable pseudonyms (Atris ids carry words from the title), and people show as "human". Numbers, members, engines, and outcomes stay.',
  full: 'Full: includes titles, objectives, verify commands, the judge command, judge summaries and output tails, and ask text. Export this only for your own data, or with the written consent of everyone in the campaign.',
};

const REWARD = 'reward = reading_after - reading_before, where a reading is the judge score in [0, 1] from the judge runs on either side of the mission. Missions that ended between the same two judge runs form a batch and split the change equally.';

function round(value, places = 6) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function pseudonym(prefix, ...parts) {
  return `${prefix}-${crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 12)}`;
}

// A judge run's reading: what the judge reported, else counts in its summary,
// else 1 for a pass and 0 for a fail.
function readingOf(run) {
  if (!run) return { value: null, source: null };
  if (typeof run.reading === 'number' && Number.isFinite(run.reading)) return { value: round(Math.min(1, Math.max(0, run.reading)), 4), source: 'graded' };
  const parsed = run.summary ? judgeReading(String(run.summary)) : null;
  if (parsed !== null) return { value: parsed, source: 'summary' };
  return { value: run.passed ? 1 : 0, source: 'pass_fail' };
}

// The order the fold applies events in: duplicates dropped, sorted, the first
// start moved to the front.
function foldOrder(events) {
  const seen = new Set();
  const unique = [];
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    unique.push(event);
  }
  const ordered = unique.sort(compareEvents);
  const start = ordered.find((e) => e.type === 'campaign_started');
  return [start, ...ordered.filter((e) => e !== start)];
}

function compactState(view, run) {
  const missions = { proposed: 0, claimed: 0, running: 0, ended: 0, vetoed: 0, dropped: 0 };
  for (const m of view.missions) missions[m.status] = (missions[m.status] || 0) + 1;
  return {
    state: view.state,
    reading: readingOf(run).value,
    confidence: view.answer.confidence,
    judge_runs: view.judge_runs,
    budget: view.budget,
    missions,
    open_asks: view.asks.length,
  };
}

function judgeRunner(command) {
  const first = String(command || '').trim().split(/\s+/)[0] || '';
  return first.split('/').pop() || null;
}

// events: one campaign's events in any order. options.redact defaults to true.
// Returns { header, rows } or { error }.
function buildTrace(events, options = {}) {
  const redact = options.redact !== false;
  const final = fold(events);
  if (final.error) return { error: final.error };
  const sequence = foldOrder(events);
  const campaignId = final.id;

  const missions = new Map();
  const judgeRuns = [];
  const asks = new Map();
  const info = (id) => {
    if (!missions.has(id)) missions.set(id, { id, firstPos: null, endPos: null, objective: null, verify: null, member: null, engine: null, kind: 'mission', estimate: null, ticks: 0, uncostedTicks: 0, endData: null, asks: [] });
    return missions.get(id);
  };

  sequence.forEach((event, pos) => {
    const d = event.data;
    if (event.type === 'judge_ran') {
      judgeRuns.push({ pos, at: event.at, passed: d.passed, reading: d.reading, summary: d.summary || null, outputTail: d.output_tail || null });
      return;
    }
    if (event.type === 'ask_opened') {
      if (!asks.has(d.ask_id)) asks.set(d.ask_id, { mission_id: d.mission_id || null, question: d.question, answer: null });
      return;
    }
    if (event.type === 'ask_answered') {
      const ask = asks.get(d.ask_id);
      if (ask && ask.answer === null && String(event.actor).startsWith('human:')) ask.answer = d.answer;
      return;
    }
    const missionId = typeof d.mission_id === 'string' && d.mission_id ? d.mission_id : null;
    if (!missionId || event.type === 'budget_reserved' || event.type === 'budget_released') return;
    const m = info(missionId);
    if (m.firstPos === null) m.firstPos = pos;
    if (typeof d.objective === 'string' && (m.objective === null || event.type === 'mission_proposed')) m.objective = d.objective;
    if (typeof d.verify === 'string' && m.verify === null) m.verify = d.verify;
    if (typeof d.member === 'string' && m.member === null) m.member = d.member;
    // A planning step names the planner's engine, not the one that did the work.
    if (typeof d.engine === 'string' && m.engine === null && d.kind !== 'plan') m.engine = d.engine;
    if (typeof d.engine === 'string' && event.type === 'mission_started' && d.kind === 'plan') m.engine = d.engine;
    if (typeof d.estimate_usd === 'number' && m.estimate === null) m.estimate = d.estimate_usd;
    if (event.type === 'mission_started' && d.kind === 'plan') m.kind = 'plan';
    if (event.type === 'step') {
      m.ticks += 1;
      if (!(typeof d.cost_usd === 'number' && Number.isFinite(d.cost_usd) && d.cost_usd >= 0)) m.uncostedTicks += 1;
    }
    if (event.type === 'mission_ended' && m.endPos === null) {
      m.endPos = pos;
      m.endData = d;
      m.endAt = event.at;
    }
  });
  for (const ask of asks.values()) if (ask.mission_id && missions.has(ask.mission_id)) missions.get(ask.mission_id).asks.push(ask);

  // The view as it stood just before a position, folded once per position.
  const prefixViews = new Map();
  const viewBefore = (pos) => {
    if (!prefixViews.has(pos)) prefixViews.set(pos, fold(sequence.slice(0, Math.max(1, pos))));
    return prefixViews.get(pos);
  };
  const lastRunBefore = (pos) => {
    let found = null;
    for (const run of judgeRuns) if (run.pos < pos) found = run;
    return found;
  };
  const firstRunAfter = (pos) => judgeRuns.find((run) => run.pos > pos) || null;

  // Where the campaign finished, if it did: the first position whose prefix is done.
  let finishPos = null;
  if (final.state === 'done') {
    let lo = 0;
    let hi = sequence.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (fold(sequence.slice(0, mid + 1)).state === 'done') hi = mid;
      else lo = mid + 1;
    }
    finishPos = lo;
  }

  const finalMissions = new Map(final.missions.map((m) => [m.id, m]));
  const ended = [...missions.values()].filter((m) => m.endPos !== null).sort((a, b) => a.endPos - b.endPos);

  // A batch: missions that ended between the same two judge runs.
  const batches = new Map();
  for (const m of ended) {
    const before = lastRunBefore(m.endPos);
    const after = firstRunAfter(m.endPos);
    const key = `${before ? before.pos : -1}:${after ? after.pos : 'open'}`;
    if (!batches.has(key)) batches.set(key, { index: batches.size + 1, before, after, missions: [] });
    batches.get(key).missions.push(m);
  }

  const memberFor = (member) => (redact && typeof member === 'string' && member.startsWith('human:') ? 'human' : member);
  const idFor = (missionId) => (redact ? pseudonym('m', campaignId, missionId) : missionId);
  const outCampaign = redact ? pseudonym('cmp', campaignId) : campaignId;
  const lastPos = sequence.length - 1;

  const rows = ended.map((m, i) => {
    const before = lastRunBefore(m.endPos);
    const after = firstRunAfter(m.endPos);
    const batch = batches.get(`${before ? before.pos : -1}:${after ? after.pos : 'open'}`);
    const size = batch.missions.length;
    const readBefore = readingOf(before);
    const readAfter = readingOf(after);
    const delta = readBefore.value !== null && readAfter.value !== null ? readAfter.value - readBefore.value : null;
    const startPos = m.firstPos === null ? m.endPos : m.firstPos;
    const view = viewBefore(startPos);
    const folded = finalMissions.get(m.id) || {};
    const uncosted = typeof m.endData.uncosted_runs === 'number' ? m.endData.uncosted_runs : m.uncostedTicks;
    let creditNote = null;
    if (!after) creditNote = 'no judge run after this mission yet, so it has no reward';
    else if (!before) creditNote = 'no judge run before this mission, so it has no reward';
    else if (size > 1) creditNote = `one of ${size} missions that ended between the same two judge runs; the reading change is split equally`;

    const action = {
      mission_id: idFor(m.id),
      kind: m.kind,
      member: memberFor(folded.member || m.member),
      engine: m.engine || (typeof m.endData.engine === 'string' ? m.endData.engine : null),
      estimate_usd: m.estimate,
    };
    if (!redact) {
      action.objective = m.objective;
      action.verify = m.verify;
    }
    const row = {
      kind: 'step',
      campaign_id: outCampaign,
      step: i + 1,
      at: m.endAt,
      batch: { index: batch.index, size },
      state_before: compactState(view, lastRunBefore(startPos)),
      action,
      outcome: folded.outcome || m.endData.outcome,
      cost_usd: folded.cost_usd === undefined || folded.cost_usd === null ? m.endData.cost_usd : folded.cost_usd,
      ticks: m.ticks,
      uncosted_ticks: uncosted,
      human_asks: m.asks.length,
      reading_before: readBefore.value,
      reading_after: readAfter.value,
      reading_source: readAfter.source,
      reward: delta === null ? null : round(delta / size),
      credit_note: creditNote,
      done: finishPos !== null && finishPos <= (after ? after.pos : lastPos),
      judge_passed: after ? after.passed : null,
    };
    if (!redact) {
      row.judge_summary = after ? after.summary : null;
      row.judge_output_tail = after ? after.outputTail : null;
      row.asks = m.asks.map((ask) => ({ question: ask.question, answer: ask.answer }));
    }
    return row;
  });

  const lastRun = judgeRuns[judgeRuns.length - 1] || null;
  const header = {
    kind: 'header',
    schema: SCHEMA,
    version: VERSION,
    campaign_id: outCampaign,
    redacted: redact,
    privacy: redact ? PRIVACY.redacted : PRIVACY.full,
    judge: { runner: judgeRunner(final.judge), outside: true, runs: judgeRuns.length },
    reward: REWARD,
    rows: rows.length,
    batches: batches.size,
    pending_missions: final.missions.filter((m) => ['proposed', 'claimed', 'running'].includes(m.status)).length,
    missions_not_run: final.missions.filter((m) => m.status === 'vetoed' || m.status === 'dropped').length,
    campaign_asks: [...asks.values()].filter((ask) => !ask.mission_id).length,
    events: sequence.length,
    first_at: sequence[0].at,
    last_at: sequence[lastPos].at,
    final: {
      state: final.state,
      stop_reason: final.stop_reason,
      confidence: final.answer.confidence,
      reading: readingOf(lastRun).value,
      standing: final.standing,
      budget: final.budget,
    },
  };
  if (!redact) {
    header.title = final.title;
    header.judge.command = final.judge;
  }
  return { header, rows };
}

function traceLines(trace) {
  return [trace.header, ...trace.rows].map((row) => JSON.stringify(row)).join('\n') + '\n';
}

// atris campaign export <id> --trace [--out <file>] [--full]
function exportTrace(args, ctx) {
  const words = [];
  for (let i = 1; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg === '--out' || arg === '--as') { i++; continue; }
    if (!arg.startsWith('--')) words.push(arg);
  }
  const { readFlag } = require('./arg-parser');
  const id = words[0];
  if (!id) return ctx.fail('name the campaign: atris campaign export <id> --trace [--out <file.jsonl>] [--full]');
  const events = ctx.store.read(id);
  if (!events.length) return ctx.fail(`no campaign ${id}. See them all with: atris campaign`, 1);
  const full = args.includes('--full');
  if (full && args.includes('--redact')) return ctx.fail('pick one: --redact (the default) or --full');
  const trace = buildTrace(events, { redact: !full });
  if (trace.error) return ctx.fail(`campaign ${id} cannot be read: ${trace.error}`, 1);
  const text = traceLines(trace);
  const out = readFlag(args, '--out', '');
  if (!out) {
    process.stdout.write(text);
    return 0;
  }
  require('fs').writeFileSync(out, text);
  const note = `wrote ${trace.rows.length} row${trace.rows.length === 1 ? '' : 's'} and a header to ${out}${full ? ' (full: includes objectives and judge output)' : ' (redacted)'}`;
  ctx.out(note, { ok: true, action: 'export', path: out, rows: trace.rows.length, redacted: !full });
  return 0;
}

module.exports = { SCHEMA, VERSION, buildTrace, exportTrace, readingOf, traceLines };
