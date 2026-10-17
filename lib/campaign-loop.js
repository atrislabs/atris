// The campaign loop: a campaign runs itself until its judge passes, its money
// runs out, or it needs a person. Each step asks decide what to do, then does
// it: run the judge, start claimed missions (several at once), or ask the
// owner's engine to propose the next missions. Campaigns decide, missions do.

'use strict';

const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { compareEvents, decide, fold } = require('./campaign-core');
const { validateEvent } = require('./campaign-schema');
const { getCampaign, openCampaignStore } = require('./campaign-store');
const { defaultReserve, missionCost, reconcileCampaign } = require('./campaign-missions');
const { judgeRanData, latestJudgeOutput } = require('./campaign-reading');
const { LANE_ASK_KIND, pausedLane, laneAskOpen, laneQuestion, openLaneAsks } = require('./campaign-lanes');

const TERMINAL = new Set(['stopped', 'complete']);

const CLI = path.join(__dirname, '..', 'bin', 'atris.js');
const PROPOSE_TIMEOUT_MS = 5 * 60 * 1000;
// A campaign only the outside world can move checks its judge again after 10
// minutes, doubling while the reading stays the same, up to an hour.
const WAIT_FIRST_MS = 10 * 60 * 1000;
const WAIT_MAX_MS = 60 * 60 * 1000;

// Two readings are the same when they pass or fail alike and say the same thing.
const readingKey = (passed, reading, summary) => JSON.stringify([Boolean(passed), typeof reading === 'number' ? reading : null, summary || null]);
const clockTime = (ms) => new Date(ms).toISOString().slice(11, 16) + ' UTC';

function claimKey(objective) {
  return String(objective).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 160);
}

function proposalId(objective) {
  const slug = String(objective).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return `m-${slug || 'mission'}-${crypto.randomBytes(3).toString('hex')}`;
}

function rankCampaignMembers(view, rsiSummary = null, events = null) {
  const seats = Array.isArray(view && view.seats) ? view.seats.map((s) => s.member).filter(Boolean) : [];
  const candidates = [...new Set([view && view.owner, ...seats].filter(Boolean))];
  const rsiMap = new Map();
  if (rsiSummary && Array.isArray(rsiSummary.members)) {
    for (const row of rsiSummary.members) {
      if (row && row.member) rsiMap.set(row.member, row);
    }
  }
  const missions = completionOrderedMissions(view, events);
  const raw = candidates.map((member) => {
    const info = rsiMap.get(member) || null;
    const overall = info && typeof info.overall === 'number' ? info.overall : 75;
    const overallLabel = (info && (info.overallLabel || info.note)) || 'unproven';
    const repeatFailures = info && typeof info.repeatFailures === 'number'
      ? info.repeatFailures
      : (info && typeof info.repeat_failures === 'number' ? info.repeat_failures : 0);
    const mine = missions.filter((m) => m && m.member === member && m.status === 'ended');
    let streak = 0;
    for (let i = mine.length - 1; i >= 0; i -= 1) {
      const outcome = String(mine[i].outcome || '');
      if (outcome && outcome !== 'kept' && !mine[i].credited) streak += 1;
      else break;
    }
    const cold = streak >= 2 || (overall < 60 && repeatFailures >= 3);
    return { member, overall, overallLabel, consecutiveFailures: streak, cold, benched: false };
  });
  const hasWarmAlternative = raw.some((r) => !r.cold);
  for (const row of raw) {
    if (row.cold && hasWarmAlternative && raw.length > 1) row.benched = true;
  }
  return raw.sort((a, b) => {
    if (a.benched !== b.benched) return a.benched ? 1 : -1;
    if (b.overall !== a.overall) return b.overall - a.overall;
    return a.consecutiveFailures - b.consecutiveFailures;
  });
}

// Callers supply the complete history behind this view. Coverage checks can
// reject a mismatch, but cannot prove that a partial history is complete.
function completionOrderedMissions(view, events) {
  const missions = Array.isArray(view && view.missions) ? view.missions : [];
  if (!Array.isArray(events)) return missions;
  const seen = new Set();
  const ends = new Map();
  let started = false;
  for (const event of events) {
    if (!validateEvent(event).ok || event.campaign_id !== (view && view.id)) return missions;
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    if (event.type === 'campaign_started') started = true;
    if (event.type !== 'mission_ended') continue;
    const previous = ends.get(event.data.mission_id);
    if (!previous || compareEvents(previous, event) < 0) ends.set(event.data.mission_id, event);
  }
  const ended = missions.filter((m) => m && m.status === 'ended');
  if (!started || ends.size !== ended.length || ended.some((m) => !ends.has(m.id) || ends.get(m.id).data.outcome !== m.outcome)) return missions;
  return ended.sort((a, b) => compareEvents(ends.get(a.id), ends.get(b.id)));
}

// What the owner's engine reads before proposing: the goal, how it is judged,
// what has been tried, and how it went.
function proposalPrompt(view, count, judgeOutput = null, lessons = '', rsiSummary = null, events = null) {
  const tried = view.missions.slice(-12).map((m) => `- ${m.id}: ${m.status}${m.outcome ? ` (${m.outcome})` : ''}${m.cost_usd !== null ? `, $${m.cost_usd}` : ''}${typeof m.reward === 'number' ? `, reward ${m.reward >= 0 ? '+' : ''}${m.reward}` : ''}`).join('\n') || '- none yet';
  const ranked = rankCampaignMembers(view, rsiSummary, events);
  const memberLine = ranked.map((r) => {
    if (r.benched) return `${r.member} (${r.overall} ovr, benched after ${r.consecutiveFailures || 'repeat'} misses)`;
    return rsiSummary ? `${r.member} (${r.overall} ovr, ${r.overallLabel})` : r.member;
  }).join(', ');
  const watchouts = ranked
    .filter((r) => r.benched || r.consecutiveFailures > 0 || /repeat miss/i.test(r.overallLabel || ''))
    .map((r) => `${r.member}: ${r.overallLabel}${r.benched ? ' (benched)' : ''}`);
  return [
    `You plan the next missions for an Atris campaign. Answer with JSON only.`,
    ``,
    `Campaign: ${view.title}`,
    `Judge (the campaign is done when this command exits 0): ${view.judge}`,
    `Last judge reading: ${view.last_judge ? `${view.last_judge.passed ? 'passed' : 'failed'}${typeof view.last_judge.reading === 'number' ? ` (${view.last_judge.reading} of 1)` : ''}: ${view.answer.text || ''}` : 'never run'}`,
    judgeOutput ? `Last judge output:\n\`\`\`\n${judgeOutput.replace(/```/g, "'''")}\n\`\`\`` : '',
    view.bet ? `Current bet: ${view.bet.text}${view.bet.wrong_if ? ` (wrong if ${view.bet.wrong_if})` : ''}` : '',
    `Money left: $${view.budget.available.toFixed(2)} of $${view.budget.total.toFixed(2)}`,
    `Members who can take a mission: ${memberLine}`,
    watchouts.length ? `Seat watchouts: ${watchouts.join('; ')}` : '',
    `Missions so far:`,
    tried,
    lessons ? `Lessons from earlier rounds (follow them):\n${lessons}` : '',
    ``,
    `Propose at most ${count} missions that move the judge toward passing. Each is one member, one run, one checkable result.`,
    `Do not repeat a mission that was already kept. Prefer small, independent missions that can run at the same time.`,
    `Reply with a JSON array and nothing else:`,
    `[{"objective": "<one sentence, imperative>", "member": "<one of the members above>", "verify": "<shell command that exits 0 when this mission's result is real>", "estimate_usd": <dollars, small>}]`,
  ].filter((line) => line !== '').join('\n');
}

function parseProposals(text, view, count, rsiSummary = null, events = null) {
  const match = String(text || '').match(/\[[\s\S]*\]/);
  if (!match) return [];
  let rows;
  try {
    rows = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const ranked = rankCampaignMembers(view, rsiSummary, events);
  const activeMembers = new Set(ranked.filter((r) => !r.benched).map((r) => r.member));
  const fallbackMember = (ranked.find((r) => !r.benched) || ranked[0] || { member: view.owner }).member;
  return rows.slice(0, count)
    .filter((row) => row && typeof row.objective === 'string' && row.objective.trim())
    .map((row) => ({
      objective: row.objective.trim().slice(0, 300),
      member: activeMembers.has(row.member) ? row.member : fallbackMember,
      verify: typeof row.verify === 'string' && row.verify.trim() ? row.verify.trim() : view.judge,
      estimate_usd: typeof row.estimate_usd === 'number' && row.estimate_usd > 0 ? Math.min(row.estimate_usd, view.budget.available) : null,
    }));
}

// Ask the owner's engine for proposals through the read-only ask runner.
async function askOwner(root, view, prompt) {
  const { resolveEngineForMember } = require('./member-engine');
  const { runEngineAskJobs } = require('./engine-ask');
  const pick = resolveEngineForMember(view.owner, root) || {};
  const engine = (pick.engine && pick.engine.id) || 'claude';
  const [answer] = await runEngineAskJobs([{ engine, model: pick.model || '', prompt, label: `campaign ${view.id} plan` }], { root, timeoutMs: PROPOSE_TIMEOUT_MS });
  return { text: (answer && answer.stdout) || '', engine, ok: Boolean(answer && answer.ok) };
}

// Run one atris command and resolve with its exit code and output.
// A live step an engine prints while a mission runs: "<member> <hh:mm>  <what it is doing>".
const ACTIVITY_LINE = /^\s*[a-z0-9][a-z0-9-]*\s+\d{1,2}:\d{2}\s{2,}\S/i;

function runCli(args, { cwd, env = process.env, onLine = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...env, ATRIS_SKIP_UPDATE_CHECK: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    // Whole lines only: a chunk can end mid-line. Live engine steps arrive on
    // stderr (member-progress reportProgress), so both streams are read.
    const reader = () => {
      let partial = '';
      return {
        push(chunk) {
          if (!onLine) return;
          const lines = (partial + String(chunk)).split('\n');
          partial = lines.pop();
          lines.filter(Boolean).forEach(onLine);
        },
        end() { if (onLine && partial) onLine(partial); },
      };
    };
    const stdout = reader();
    const stderr = reader();
    child.stdout.on('data', (chunk) => { out += chunk; stdout.push(chunk); });
    child.stderr.on('data', (chunk) => { err += chunk; stderr.push(chunk); });
    child.on('close', (code) => {
      stdout.end();
      stderr.end();
      resolve({ code, out, err });
    });
  });
}

function makeLoop(root, options = {}, deps = {}) {
  const store = deps.store || openCampaignStore(root);
  const log = deps.log || ((line) => console.log(line));
  const parallel = Math.max(1, Number(options.parallel) || 3);
  const maxTicks = Math.max(1, Number(options.maxTicks) || 3);
  // Every mission gets an explicit time limit. Without one, a number in the
  // objective ("437 tests, 475s") was read as the mission's time budget.
  const missionMinutes = Math.max(1, Number(options.missionMinutes) || 40);
  const runner = options.runner || 'auto';
  const actor = options.actor || 'mission-lead';
  const ask = deps.ask || askOwner;
  const cli = deps.cli || ((args, extra = {}) => runCli(args, { cwd: root, ...extra }));
  const judge = deps.judge;
  const now = deps.now || Date.now;

  const view = (id) => getCampaign(store, id);
  const append = (id, type, data, as = actor) => store.append({ campaign_id: id, type, actor: as, data });

  async function propose(id, count = parallel) {
    const events = store.read(id);
    const current = events.length ? fold(events) : null;
    let rsiSummary = null;
    try {
      const { missionRewardMap, summarizeStoreRsi } = require('./campaign-rsi');
      const rewards = missionRewardMap(events);
      current.missions = current.missions.map((m) => {
        const raw = rewards && typeof rewards.get === 'function' ? rewards.get(m.id) : (rewards && rewards[m.id]);
        const reward = typeof raw === 'number' ? raw : (raw && typeof raw.reward === 'number' ? raw.reward : undefined);
        return typeof reward === 'number' ? { ...m, reward } : m;
      });
      rsiSummary = summarizeStoreRsi(store);
    } catch {}
    const prompt = proposalPrompt(current, count, latestJudgeOutput(events), deps.lessons ? deps.lessons(id) : '', rsiSummary, events);
    const answer = await ask(root, current, prompt);
    const proposals = parseProposals(answer.text, current, count, rsiSummary, events);
    // Planning costs money too. It rides on the first mission it produced as a
    // step, so it is counted when that mission ends without making the judge
    // due. A plan that produced nothing is not failed work: the step saves a
    // wait instead (the owner's engine reports no dollar cost to carry).
    const plan = { kind: 'plan', engine: answer.engine };
    if (typeof answer.cost_usd === 'number') plan.cost_usd = answer.cost_usd;
    proposals.forEach((proposal, index) => {
      const missionId = proposalId(proposal.objective);
      append(id, 'mission_proposed', { mission_id: missionId, member: proposal.member, objective: proposal.objective, verify: proposal.verify, estimate_usd: proposal.estimate_usd || undefined }, proposal.member);
      append(id, 'mission_claimed', { mission_id: missionId, claim_key: claimKey(proposal.objective) }, proposal.member);
      if (index === 0) append(id, 'step', { mission_id: missionId, ...plan }, current.owner);
    });
    return proposals;
  }

  // The proposal data behind each claimed mission (the fold keeps only ids).
  function claimedWork(id) {
    const current = view(id);
    const proposals = new Map();
    for (const event of store.read(id)) {
      if (event.type === 'mission_proposed' && event.data.objective) proposals.set(event.data.mission_id, event.data);
    }
    return current.missions
      .filter((m) => m.status === 'claimed' && proposals.has(m.id))
      .map((m) => ({ ...proposals.get(m.id), mission_id: m.id, member: m.member || proposals.get(m.id).member || current.owner }));
  }

  async function startAndRun(id, work) {
    const current = view(id);
    const reserve = work.estimate_usd || defaultReserve(current);
    const started = await cli([
      'mission', 'start', work.objective, '--mission-id', work.mission_id, '--owner', work.member,
      '--runner', runner, '--verify', work.verify || current.judge, '--campaign', id, '--reserve', String(reserve),
      '--max-wall', String(missionMinutes * 60), '--json',
    ]);
    if (started.code !== 0) {
      let why = (started.out + started.err).trim().split('\n').pop();
      try {
        const error = JSON.parse(started.out);
        const detail = [error?.detail, error?.error].find(value => typeof value === 'string' && value.trim());
        if (detail) why = detail.trim();
      } catch {}
      log(`  ${work.mission_id} did not start: ${why}`);
      append(id, 'mission_vetoed', { mission_id: work.mission_id, reason: why.slice(0, 200) }, current.owner);
      return { mission_id: work.mission_id, started: false };
    }
    log(`  ${work.mission_id} started for ${work.member}: ${work.objective}`);
    // The engine's live steps ("researcher 06:47  editing stable.mjs") pass through to
    // the campaign's own output, so a screen watching the run can show the work.
    const stepsBefore = (view(id).missions.find((m) => m.id === work.mission_id) || {}).steps || 0;
    const ran = await cli(['mission', 'run', work.mission_id, '--max-ticks', String(maxTicks), '--complete-on-pass'], { onLine: (line) => { if (ACTIVITY_LINE.test(line)) log(`    ${line.trim()}`); } });
    const after = view(id).missions.find((m) => m.id === work.mission_id);
    // A mission in a protected lane (billing, security, deploy, customer) pauses
    // before its first tick. Ask a person once per lane instead of failing quietly.
    const lane = after && after.status !== 'ended' ? pausedLane(`${ran.out || ''}\n${ran.err || ''}`) : null;
    if (lane) {
      if (!laneAskOpen(store.read(id), lane)) {
        const askId = `a-${crypto.randomBytes(3).toString('hex')}`;
        append(id, 'ask_opened', { ask_id: askId, question: laneQuestion(lane, work.member, work.objective), mission_id: work.mission_id, kind: LANE_ASK_KIND, lane }, current.owner);
      }
      await cli(['mission', 'stop', work.mission_id, '--reason', `campaign loop: waiting for a person to allow the ${lane} lane`]);
      log(`  ${work.mission_id} needs you: it touches ${lane}`);
      return { mission_id: work.mission_id, started: true, outcome: null, needs: lane };
    }
    if (after && after.status !== 'ended' && after.steps === stepsBefore) {
      // The run left no step behind: the job never ran. Score it as a fault
      // with the run's own words, not as failed work by the member.
      const why = `${ran.err || ''}\n${ran.out || ''}`.trim().split('\n').filter(Boolean).pop() || `exit ${ran.code}`;
      append(id, 'mission_ended', { mission_id: work.mission_id, outcome: 'fault', reason: why.slice(0, 200), cost_usd: missionCost(root, work.mission_id, { store }).cost_usd }, work.member);
      log(`  ${work.mission_id} never ran: ${why}`);
    }
    if (after && after.status !== 'ended') {
      // The run stopped without finishing (tick cap, error): close it so its
      // reserve comes back and its cost is counted.
      await cli(['mission', 'stop', work.mission_id, '--reason', `campaign loop: run ended without finishing (exit ${ran.code})`]);
    }
    const final = view(id).missions.find((m) => m.id === work.mission_id) || {};
    log(`  ${work.mission_id} ${final.outcome || 'ended'} · $${(final.cost_usd || 0).toFixed(2)}`);
    return { mission_id: work.mission_id, started: true, outcome: final.outcome || null };
  }

  // A campaign linked to the cloud trades events before and after every step,
  // so a person's answer from a phone reaches this loop. A failed sync never
  // stops the loop; deps.sync warns, keeps running offline, and resolves with
  // how many events it pulled.
  const sync = deps.sync || (async () => 0);

  // Run the judge and record its reading. waitFor(data) returns how long to
  // wait before the next check (0 for no wait); a passing reading never waits.
  async function readJudge(id, current, waitFor = () => 0) {
    const reading = await judge(current.judge);
    const data = judgeRanData(reading);
    const waitMs = data.passed ? 0 : waitFor(data);
    if (waitMs > 0) data.wait = { wake_at: now() + waitMs, wait_ms: waitMs };
    append(id, 'judge_ran', data, 'judge');
    if (!deps.skipReconcile) {
      try { require('./campaign-rsi').writeRsiSnapshot(root, store, id); } catch {}
    }
    log(`judge ${reading.passed ? 'passed' : 'failed'}: ${reading.summary || `exit ${reading.exit}`}`);
    return data;
  }

  // One step, with a sync on each side.
  async function step(id) {
    await sync(id);
    const result = await stepOnce(id);
    await sync(id);
    return result;
  }

  // One step. Returns { stop, reason } or { stop: false, did }.
  async function stepOnce(id) {
    // Missions that ended without telling the campaign give their reserve back first.
    if (!deps.skipReconcile) {
      try { reconcileCampaign(root, id, TERMINAL, { store }); } catch {}
    }
    const current = view(id);
    if (!current) return { stop: true, reason: `no campaign ${id}` };
    if (current.error) return { stop: true, reason: `campaign cannot be read: ${current.error}` };
    const move = decide(current);
    if (move.action === 'none') return { stop: true, reason: move.reason };
    const needsYou = (n) => ({ stop: true, reason: `needs you: ${n} open ask${n === 1 ? '' : 's'}` });
    if (move.action === 'wait' && move.reason === 'open asks') return needsYou(move.asks.length);
    // A protected lane waiting on a person holds the whole campaign: the loop
    // cannot tell which next plan would touch that lane again.
    if (openLaneAsks(store.read(id)).size) return needsYou(current.asks.length);
    // A saved wait is a promise: nothing runs before it is due, even in a new
    // process. When it is due, only the judge runs. The same reading waits
    // twice as long; a changed one lets the next step plan again.
    const saved = current.next_move;
    if (saved && saved.action === 'wait') {
      if (now() < saved.wake_at) return { stop: true, reason: `waiting on the world: next check at ${clockTime(saved.wake_at)}` };
      const before = current.last_judge ? readingKey(current.last_judge.passed, current.last_judge.reading, current.answer.text) : null;
      const data = await readJudge(id, current, (d) => readingKey(d.passed, d.reading, d.summary) === before ? Math.min(saved.wait_ms * 2, WAIT_MAX_MS) : 0);
      if (data.wait) return { stop: true, reason: `nothing changed: next check at ${clockTime(data.wait.wake_at)}` };
      return { stop: false, did: 'judge' };
    }
    if (move.action === 'run_judge') {
      await readJudge(id, current);
      return { stop: false, did: 'judge' };
    }
    if (move.action === 'start_mission' || (move.action === 'wait' && move.reason === 'budget')) {
      const work = claimedWork(id).slice(0, parallel);
      if (!work.length) return { ok: false, stop: true, reason: 'claimed missions have no objective to run; start them by hand or veto them' };
      log(`starting ${work.length} mission${work.length === 1 ? '' : 's'} at once`);
      const results = await Promise.all(work.map((w) => startAndRun(id, w)));
      if (!results.some((r) => r.started)) return { ok: false, stop: true, reason: 'no claimed mission could start' };
      return { stop: false, did: 'missions' };
    }
    if (move.action === 'wait') return { stop: true, reason: `waiting: ${move.reason} (started elsewhere)` };
    log(`asking ${current.owner} to propose up to ${parallel} missions`);
    const proposals = await propose(id, parallel);
    if (!proposals.length) {
      const data = await readJudge(id, current, () => WAIT_FIRST_MS);
      if (data.passed) return { stop: false, did: 'judge' };
      const next = data.wait ? `; next check at ${clockTime(data.wait.wake_at)}` : '';
      return { ok: false, stop: true, reason: `${current.owner} proposed nothing usable${next}` };
    }
    for (const p of proposals) log(`  proposed for ${p.member}: ${p.objective}`);
    return { stop: false, did: 'propose' };
  }

  // One tick: the one step that is due now, with a sync on each side. A timer
  // or a woken process calls this; run() is for a person watching.
  async function tick(id) {
    return step(id);
  }

  async function run(id, maxSteps = 20) {
    await sync(id);
    for (let i = 0; i < maxSteps; i++) {
      const result = await stepOnce(id);
      // An answer pulled just now can unblock a step that stopped for a person.
      const pulled = await sync(id);
      if (result.stop && pulled > 0) continue;
      if (result.stop) return { ...(result.ok === false ? { ok: false } : {}), steps: i, reason: result.reason, campaign: view(id) };
    }
    return { steps: maxSteps, reason: `stopped after ${maxSteps} steps`, campaign: view(id) };
  }

  return { step, tick, run, propose };
}

module.exports = { ACTIVITY_LINE, askOwner, makeLoop, parseProposals, proposalPrompt, rankCampaignMembers, readingKey, runCli };
