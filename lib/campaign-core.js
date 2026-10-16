// Campaign core: fold(events) -> view, decide(view) -> next move.
// Pure: no I/O, no clock, no network. The rules are the cross-surface
// contract in test/fixtures/campaign/README.md; every surface's fold must
// match the golden files there.

'use strict';

const { TIMESTAMP, validateEvent, isHumanActor } = require('./campaign-schema');

function cents(amount) {
  return Math.floor(amount * 100 + 0.5);
}

function dollars(value) {
  return value / 100;
}

// An instant at full precision: whole seconds since the epoch plus nine
// fraction digits, so two events a microsecond apart never tie.
function instant(at) {
  const [, date, time, fraction = '', zone] = TIMESTAMP.exec(at);
  return { seconds: Date.parse(`${date}T${time}${zone}`) / 1000, nanos: fraction.padEnd(9, '0') };
}

function compareEvents(a, b) {
  const x = instant(a.at);
  const y = instant(b.at);
  if (x.seconds !== y.seconds) return x.seconds - y.seconds;
  if (x.nanos !== y.nanos) return x.nanos < y.nanos ? -1 : 1;
  if (a.origin !== b.origin) return a.origin < b.origin ? -1 : 1;
  if (a.seq !== b.seq) return a.seq - b.seq;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

function seatFrom(seat) {
  if (typeof seat === 'string') return { member: seat, role: null };
  return { member: seat.member, role: seat.role === undefined ? null : seat.role };
}

function addSeat(seats, seat) {
  if (seats.some((s) => s.member === seat.member && s.role === seat.role)) return;
  seats.push(seat);
}

// Statuses only move forward; dropped and vetoed are final.
const STATUS_RANK = { proposed: 0, claimed: 1, running: 2, ended: 3 };

function moveTo(m, status) {
  const from = STATUS_RANK[m.status];
  if (from === undefined || from >= STATUS_RANK[status]) return;
  m.status = status;
}

function newMission(id) {
  return {
    id, member: null, status: 'proposed', outcome: null, costCents: null,
    estimate_usd: null, steps: 0, kept: 0, reverted: 0,
  };
}

// Returns the folded view, or { error } when the events must be refused.
function fold(events) {
  if (!Array.isArray(events)) return { error: 'invalid_event' };
  for (const event of events) {
    if (!validateEvent(event).ok) return { error: 'invalid_event' };
  }
  const campaignIds = new Set(events.map((e) => e.campaign_id));
  if (campaignIds.size > 1) return { error: 'mixed_campaigns' };

  const seen = new Set();
  const unique = [];
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    unique.push(event);
  }
  const ordered = unique.slice().sort(compareEvents);
  const start = ordered.find((e) => e.type === 'campaign_started');
  if (!start) return { error: 'no_start' };

  const s = {
    finished: null,
    paused: false,
    seats: [],
    bet: null,
    parent: null,
    home: start.origin,
    missions: new Map(),
    claims: new Map(),
    reservations: new Map(),
    totalCents: cents(start.data.budget),
    spentCents: 0,
    asks: new Map(),
    judgeRuns: [],
    lastEndedPos: -1,
    judgeSetPos: -1,
    judge: start.data.judge,
    lastJudgePos: -1,
    warnings: [],
  };
  const d = start.data;
  const owner = typeof d.owner === 'string' && d.owner ? d.owner : 'mission-lead';
  for (const seat of d.seats || []) addSeat(s.seats, seatFrom(seat));
  if (d.bet) s.bet = { text: d.bet, wrong_if: null };

  const warn = (event, code) => s.warnings.push({ event_id: event.id, code });
  const mission = (id) => {
    if (!s.missions.has(id)) s.missions.set(id, newMission(id));
    return s.missions.get(id);
  };

  const sequence = [start, ...ordered.filter((e) => e !== start)];
  sequence.forEach((event, pos) => {
    const data = event.data;
    switch (event.type) {
      case 'campaign_started':
        if (event !== start) warn(event, 'duplicate_start');
        break;
      case 'seat_filled':
        addSeat(s.seats, { member: data.member, role: data.role });
        break;
      case 'bet_set':
        s.bet = { text: data.bet, wrong_if: data.wrong_if || null };
        break;
      case 'judge_set':
        if (event.actor !== owner && !isHumanActor(event.actor)) {
          warn(event, 'judge_set_not_owner');
        } else {
          s.judge = data.judge;
          s.judgeSetPos = pos;
        }
        break;
      case 'attached':
        s.parent = data.parent_id;
        break;
      case 'mission_proposed':
        if (!s.missions.has(data.mission_id)) {
          const m = mission(data.mission_id);
          m.member = data.member || null;
          m.estimate_usd = typeof data.estimate_usd === 'number' ? dollars(cents(data.estimate_usd)) : null;
        }
        break;
      case 'mission_claimed': {
        const holder = s.claims.get(data.claim_key);
        const m = mission(data.mission_id);
        if (holder !== undefined && holder !== data.mission_id) {
          warn(event, 'duplicate_claim');
          if (m.status === 'proposed') m.status = 'dropped';
        } else {
          s.claims.set(data.claim_key, data.mission_id);
          moveTo(m, 'claimed');
        }
        break;
      }
      case 'mission_vetoed': {
        if (event.actor !== owner && !isHumanActor(event.actor)) {
          warn(event, 'veto_not_owner');
          break;
        }
        const m = mission(data.mission_id);
        if (m.status === 'proposed' || m.status === 'claimed') m.status = 'vetoed';
        break;
      }
      case 'mission_started': {
        const m = mission(data.mission_id);
        moveTo(m, 'running');
        if (m.member === null) m.member = data.member;
        else if (m.member !== data.member) warn(event, 'second_assignee');
        break;
      }
      case 'step':
      case 'kept':
      case 'reverted': {
        const m = mission(data.mission_id);
        const key = event.type === 'step' ? 'steps' : event.type;
        m[key] += 1;
        break;
      }
      case 'mission_ended': {
        const m = mission(data.mission_id);
        m.status = 'ended';
        m.outcome = data.outcome;
        m.costCents = cents(data.cost_usd);
        s.spentCents += m.costCents;
        s.reservations.delete(data.mission_id);
        s.lastEndedPos = pos;
        break;
      }
      case 'budget_reserved': {
        const m = s.missions.get(data.mission_id);
        if (!m || m.status !== 'ended') s.reservations.set(data.mission_id, cents(data.amount_usd));
        break;
      }
      case 'budget_released':
        s.reservations.delete(data.mission_id);
        break;
      case 'budget_added':
        s.totalCents += cents(data.amount_usd);
        break;
      case 'judge_ran':
        s.judgeRuns.push({
          passed: data.passed,
          reading: typeof data.reading === 'number' ? data.reading : null,
          summary: typeof data.summary === 'string' ? data.summary : null,
          confidence: data.confidence || null,
          at: event.at,
        });
        s.lastJudgePos = pos;
        if (data.passed && !d.standing && !s.finished) s.finished = 'judge_passed';
        break;
      case 'ask_opened':
        if (!s.asks.has(data.ask_id)) s.asks.set(data.ask_id, { id: data.ask_id, question: data.question, mission_id: data.mission_id || null });
        break;
      case 'ask_answered':
        if (!isHumanActor(event.actor)) warn(event, 'ask_answered_by_agent');
        else if (!s.asks.has(data.ask_id)) warn(event, 'unknown_ask');
        else s.asks.delete(data.ask_id);
        break;
      case 'paused':
        s.paused = true;
        break;
      case 'resumed':
        s.paused = false;
        break;
      case 'stopped':
        if (!s.finished) s.finished = 'stopped';
        break;
      case 'home_moved':
        s.home = data.to;
        break;
      case 'done':
        if (!isHumanActor(event.actor)) warn(event, 'done_without_judge');
        else if (!s.finished) s.finished = 'done_by_human';
        break;
      default:
        break;
    }
  });

  const missions = [...s.missions.values()];
  let state;
  let stopReason = null;
  if (s.finished) {
    state = 'done';
    stopReason = s.finished;
  } else if (s.spentCents >= s.totalCents) {
    state = 'out_of_budget';
    stopReason = 'budget_spent';
  } else if (s.paused) {
    state = 'paused';
  } else if (s.asks.size > 0) {
    state = 'needs_you';
  } else if (missions.some((m) => m.status === 'running')) {
    state = 'running';
  } else if (missions.some((m) => m.status === 'proposed' || m.status === 'claimed')) {
    state = 'queued';
  } else {
    state = 'resting';
  }

  const runs = s.judgeRuns;
  const latest = runs.length ? runs[runs.length - 1] : null;
  let confidence = 'open';
  if (latest && s.finished === 'judge_passed') {
    confidence = 'answered';
  } else if (latest && latest.passed) {
    let streak = 0;
    for (let i = runs.length - 1; i >= 0 && runs[i].passed; i--) streak++;
    confidence = streak >= 3 ? 'stronger' : 'leaning';
  } else if (latest) {
    confidence = latest.confidence || 'open';
  }

  const reservedCents = [...s.reservations.values()].reduce((sum, value) => sum + value, 0);
  return {
    id: start.campaign_id,
    title: d.title,
    judge: s.judge,
    owner,
    standing: d.standing === true,
    bet: s.bet,
    parent: s.parent,
    home: s.home,
    // Only when the start event names one, so the shared golden views stay as
    // pinned; no basis means the person's own engines.
    ...(d.basis === 'atris_cloud' || d.basis === 'own_engines' ? { basis: d.basis } : {}),
    created_from: d.created_from === undefined ? null : d.created_from,
    seats: s.seats,
    state,
    stop_reason: stopReason,
    answer: { text: latest ? latest.summary : null, confidence },
    budget: {
      total: dollars(s.totalCents),
      spent: dollars(s.spentCents),
      reserved: dollars(reservedCents),
      available: dollars(s.totalCents - s.spentCents - reservedCents),
    },
    asks: [...s.asks.values()],
    missions: missions.map((m) => ({
      id: m.id,
      member: m.member,
      status: m.status,
      outcome: m.outcome,
      cost_usd: m.costCents === null ? null : dollars(m.costCents),
      estimate_usd: m.estimate_usd,
      steps: m.steps,
      kept: m.kept,
      reverted: m.reverted,
    })),
    judge_runs: runs.length,
    judge_due: runs.length === 0 || Math.max(s.lastEndedPos, s.judgeSetPos) > s.lastJudgePos,
    last_judge: latest ? { passed: latest.passed, reading: latest.reading, at: latest.at } : null,
    warnings: s.warnings,
  };
}

function decide(view) {
  if (view.state === 'done') return { action: 'none', reason: 'finished' };
  if (view.state === 'out_of_budget') return { action: 'none', reason: 'budget spent' };
  if (view.state === 'paused') return { action: 'none', reason: 'paused' };
  if (view.asks.length > 0) return { action: 'wait', reason: 'open asks', asks: view.asks.map((a) => a.id) };
  if (view.judge_due) return { action: 'run_judge' };
  const claimed = view.missions.filter((m) => m.status === 'claimed');
  const available = cents(view.budget.available);
  const fits = claimed.find((m) => cents(m.estimate_usd || 0) <= available);
  if (fits) return { action: 'start_mission', mission_id: fits.id };
  if (claimed.length > 0) return { action: 'wait', reason: 'budget' };
  if (view.missions.some((m) => m.status === 'running')) return { action: 'wait', reason: 'missions running' };
  return { action: 'propose', reason: 'no missions queued' };
}

// Spend is real dollars only when billing is API or Atris runs the campaign on
// its own engines (basis atris_cloud). Otherwise the work ran on the person's own
// subscriptions: they paid nothing, and cost_usd stays as the API-price budget meter.
function paysDollars(view) {
  if (process.env.ATRIS_BILLING === 'api') return true;
  return Boolean(view && view.basis === 'atris_cloud');
}

module.exports = { cents, compareEvents, decide, fold, paysDollars };
