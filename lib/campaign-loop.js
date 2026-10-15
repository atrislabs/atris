// The campaign loop: a campaign runs itself until its judge passes, its money
// runs out, or it needs a person. Each step asks decide what to do, then does
// it: run the judge, start claimed missions (several at once), or ask the
// owner's engine to propose the next missions. Campaigns decide, missions do.

'use strict';

const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { decide } = require('./campaign-core');
const { getCampaign, openCampaignStore } = require('./campaign-store');
const { defaultReserve, reconcileCampaign } = require('./campaign-missions');
const { judgeRanData, judgeMessage, latestJudgeOutput } = require('./campaign-reading');

const TERMINAL = new Set(['stopped', 'complete']);

const CLI = path.join(__dirname, '..', 'bin', 'atris.js');
const PROPOSE_TIMEOUT_MS = 5 * 60 * 1000;

function claimKey(objective) {
  return String(objective).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 160);
}

function proposalId(objective) {
  const slug = String(objective).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return `m-${slug || 'mission'}-${crypto.randomBytes(3).toString('hex')}`;
}

// What the owner's engine reads before proposing: the goal, how it is judged,
// what has been tried, and how it went.
function proposalPrompt(view, count, judgeOutput = null) {
  const tried = view.missions.slice(-12).map((m) => `- ${m.id}: ${m.status}${m.outcome ? ` (${m.outcome})` : ''}${m.cost_usd !== null ? `, $${m.cost_usd}` : ''}`).join('\n') || '- none yet';
  const seats = view.seats.map((s) => s.member).filter(Boolean);
  const members = [...new Set([view.owner, ...seats])];
  return [
    `You plan the next missions for an Atris campaign. Answer with JSON only.`,
    ``,
    `Campaign: ${view.title}`,
    `Judge (the campaign is done when this command exits 0): ${view.judge}`,
    `Last judge reading: ${view.last_judge ? `${view.last_judge.passed ? 'passed' : 'failed'}${typeof view.last_judge.reading === 'number' ? ` (${view.last_judge.reading} of 1)` : ''}: ${view.answer.text || ''}` : 'never run'}`,
    judgeOutput ? `Last judge output:\n\`\`\`\n${judgeOutput.replace(/```/g, "'''")}\n\`\`\`` : '',
    view.bet ? `Current bet: ${view.bet.text}${view.bet.wrong_if ? ` (wrong if ${view.bet.wrong_if})` : ''}` : '',
    `Money left: $${view.budget.available.toFixed(2)} of $${view.budget.total.toFixed(2)}`,
    `Members who can take a mission: ${members.join(', ')}`,
    `Missions so far:`,
    tried,
    ``,
    `Propose at most ${count} missions that move the judge toward passing. Each is one member, one run, one checkable result.`,
    `Do not repeat a mission that was already kept. Prefer small, independent missions that can run at the same time.`,
    `Reply with a JSON array and nothing else:`,
    `[{"objective": "<one sentence, imperative>", "member": "<one of the members above>", "verify": "<shell command that exits 0 when this mission's result is real>", "estimate_usd": <dollars, small>}]`,
  ].filter((line) => line !== '').join('\n');
}

function parseProposals(text, view, count) {
  const match = String(text || '').match(/\[[\s\S]*\]/);
  if (!match) return [];
  let rows;
  try {
    rows = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const members = new Set([view.owner, ...view.seats.map((s) => s.member)]);
  return rows.slice(0, count)
    .filter((row) => row && typeof row.objective === 'string' && row.objective.trim())
    .map((row) => ({
      objective: row.objective.trim().slice(0, 300),
      member: members.has(row.member) ? row.member : view.owner,
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
function runCli(args, { cwd, env = process.env, onLine = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...env, ATRIS_SKIP_UPDATE_CHECK: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (onLine) String(chunk).split('\n').filter(Boolean).forEach(onLine);
    });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

function makeLoop(root, options = {}, deps = {}) {
  const store = deps.store || openCampaignStore(root);
  const log = deps.log || ((line) => console.log(line));
  const parallel = Math.max(1, Number(options.parallel) || 3);
  const maxTicks = Math.max(1, Number(options.maxTicks) || 3);
  const runner = options.runner || 'auto';
  const actor = options.actor || 'mission-lead';
  const ask = deps.ask || askOwner;
  const cli = deps.cli || ((args) => runCli(args, { cwd: root }));
  const judge = deps.judge;

  const view = (id) => getCampaign(store, id);
  const append = (id, type, data, as = actor) => store.append({ campaign_id: id, type, actor: as, data });

  async function propose(id, count = parallel) {
    const current = view(id);
    const prompt = proposalPrompt(current, count, latestJudgeOutput(store.read(id)));
    const answer = await ask(root, current, prompt);
    const proposals = parseProposals(answer.text, current, count);
    // Planning costs money too. It rides on the first mission it produced as a
    // step, so it is counted when that mission ends without making the judge
    // due. A plan that produced nothing becomes its own ended mission.
    const plan = { kind: 'plan', engine: answer.engine };
    if (typeof answer.cost_usd === 'number') plan.cost_usd = answer.cost_usd;
    proposals.forEach((proposal, index) => {
      const missionId = proposalId(proposal.objective);
      append(id, 'mission_proposed', { mission_id: missionId, member: proposal.member, objective: proposal.objective, verify: proposal.verify, estimate_usd: proposal.estimate_usd || undefined }, proposal.member);
      append(id, 'mission_claimed', { mission_id: missionId, claim_key: claimKey(proposal.objective) }, proposal.member);
      if (index === 0) append(id, 'step', { mission_id: missionId, ...plan }, current.owner);
    });
    if (!proposals.length) {
      const planId = `plan-${crypto.randomBytes(3).toString('hex')}`;
      append(id, 'mission_started', { mission_id: planId, member: current.owner, kind: 'plan' }, current.owner);
      append(id, 'mission_ended', { mission_id: planId, outcome: 'failed', cost_usd: plan.cost_usd || 0, uncosted_runs: plan.cost_usd === undefined ? 1 : 0, engine: answer.engine }, current.owner);
    }
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
      '--runner', runner, '--verify', work.verify || current.judge, '--campaign', id, '--reserve', String(reserve), '--json',
    ]);
    if (started.code !== 0) {
      const why = (started.out + started.err).trim().split('\n').pop();
      log(`  ${work.mission_id} did not start: ${why}`);
      append(id, 'mission_vetoed', { mission_id: work.mission_id, reason: why.slice(0, 200) }, current.owner);
      return { mission_id: work.mission_id, started: false };
    }
    log(`  ${work.mission_id} started for ${work.member}: ${work.objective}`);
    const ran = await cli(['mission', 'run', work.mission_id, '--max-ticks', String(maxTicks), '--complete-on-pass']);
    const after = view(id).missions.find((m) => m.id === work.mission_id);
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
    if (move.action === 'wait' && move.reason === 'open asks') return { stop: true, reason: `needs you: ${move.asks.length} open ask${move.asks.length === 1 ? '' : 's'}` };
    if (move.action === 'run_judge') {
      const reading = await judge(current.judge);
      append(id, 'judge_ran', judgeRanData(reading), 'judge');
      log(`judge ${reading.passed ? 'passed' : 'not yet'}: ${judgeMessage(reading, store.read(id), current.judge)}`);
      return { stop: false, did: 'judge' };
    }
    if (move.action === 'start_mission' || (move.action === 'wait' && move.reason === 'budget')) {
      const work = claimedWork(id).slice(0, parallel);
      if (!work.length) return { stop: true, reason: 'claimed missions have no objective to run; start them by hand or veto them' };
      log(`starting ${work.length} mission${work.length === 1 ? '' : 's'} at once`);
      const results = await Promise.all(work.map((w) => startAndRun(id, w)));
      if (!results.some((r) => r.started)) return { stop: true, reason: 'no claimed mission could start' };
      return { stop: false, did: 'missions' };
    }
    if (move.action === 'wait') return { stop: true, reason: `waiting: ${move.reason} (started elsewhere)` };
    log(`asking ${current.owner} to propose up to ${parallel} missions`);
    const proposals = await propose(id, parallel);
    if (!proposals.length) return { stop: true, reason: `${current.owner} proposed nothing usable` };
    for (const p of proposals) log(`  proposed for ${p.member}: ${p.objective}`);
    return { stop: false, did: 'propose' };
  }

  async function run(id, maxSteps = 20) {
    await sync(id);
    for (let i = 0; i < maxSteps; i++) {
      const result = await stepOnce(id);
      // An answer pulled just now can unblock a step that stopped for a person.
      const pulled = await sync(id);
      if (result.stop && pulled > 0) continue;
      if (result.stop) return { steps: i, reason: result.reason, campaign: view(id) };
    }
    return { steps: maxSteps, reason: `stopped after ${maxSteps} steps`, campaign: view(id) };
  }

  return { step, run, propose };
}

module.exports = { makeLoop, parseProposals, proposalPrompt };
