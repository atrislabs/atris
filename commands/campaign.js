// atris campaign: long-running goals with a judge, a budget, and members in
// seats. Every verb appends events to the workspace campaign store; every
// screen is a fold of those events. Spec: atris/features/campaign/idea.md,
// contract: test/fixtures/campaign/README.md.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { readFlag } = require('../lib/arg-parser');
const { CAMPAIGN_ID, isHumanActor, validateCampaign } = require('../lib/campaign-schema');
const { decide } = require('../lib/campaign-core');
const { campaignDbPath, getCampaign, listCampaigns, newCampaignId, openCampaignStore } = require('../lib/campaign-store');
const { findHoldout, moveHoldoutBack, moveHoldoutIn, scrub } = require('../lib/campaign-holdout');
const { judgeRanData, judgeReading, outputTail } = require('../lib/campaign-reading');
const { cloudLink, sendPersonAction, syncCampaign } = require('../lib/campaign-sync');
const { campaignHome, changedProtected, checkoutTop, planProtect, readProtect, saveProtect } = require('../lib/campaign-protect');

const JUDGE_TIMEOUT_SECONDS = 15 * 60;
const STATE_ORDER = ['needs_you', 'running', 'queued', 'paused', 'resting', 'out_of_budget', 'done'];

function printHelp() {
  console.log('Usage:');
  console.log('  atris campaign                         every campaign: state, money, and the next move');
  console.log('  atris campaign new "<goal>" [--budget 20] [--owner <member>] [--yes]   draft a judge that fails today, then start');
  console.log('  atris campaign start "<title>" --judge "<cmd>" --budget <dollars>');
  console.log('        [--holdout <file>]   move held-out data out of the repo; the judge reads it from $ATRIS_CAMPAIGN_HOLDOUT');
  console.log('        [--owner <member>] [--seat <member>[:<role>]]... [--bet "<bet>" [--wrong-if "<what proves it wrong>"]]');
  console.log('        [--standing] [--parent <id>] [--id cmp-<name>] [--cloud] [--protect <path>]...');
  console.log('        --protect saves paths agents must not touch, and the commit they start from');
  console.log('  atris campaign show <id>               bet, judge, answer, budget, seats, missions, asks');
  console.log('  atris campaign judge <id> [--timeout <seconds>]   run the judge now and record the reading');
  console.log('  atris campaign guard <id>              exits 1 naming any protected path changed since start');
  console.log('  atris campaign set-judge <id> "<cmd>"   change the judge (owner or a person; must fail first)');
  console.log('  atris campaign seat <id> <member> [--role <role>]');
  console.log('  atris campaign bet <id> "<bet>" [--wrong-if "<what proves it wrong>"]');
  console.log('  atris campaign budget <id> --add <dollars>');
  console.log('  atris campaign ask <id> "<question>" [--mission <id>]   stop before anything that cannot be undone');
  console.log('  atris campaign answer <id> <ask-id> "<answer>"     a person answers; agents cannot');
  console.log('  atris campaign pause|resume|stop <id>');
  console.log('  atris campaign event <id> <type> [--data \'<json>\']   append any event by hand');
  console.log('  atris campaign run <id> [--parallel 3] [--max-steps 20] [--max-ticks 3] [--runner auto]');
  console.log('        the campaign runs itself: proposes missions, runs them at once, judges, repeats until done, broke, or needing you');
  console.log('        add --work 50m --break 10m [--rounds N] to work in rounds; each break judges and writes lessons the next round plans from');
  console.log('  atris campaign step <id>               one step of that loop');
  console.log('  atris campaign propose <id> [--count 3]   ask the owner\'s engine for the next missions');
  console.log('  atris campaign export <id> --trace [--out <file.jsonl>] [--full]   one row per mission for learning; redacted unless --full');
  console.log('  atris campaign sync <id>               trade events with the Atris cloud so web and iOS show it');
  console.log('        start --cloud syncs at once; run syncs before and after every step of a synced campaign');
  console.log('');
  console.log('Every verb takes --json. Writes are recorded as you (human:<login>); agents pass --as <member>.');
  console.log('A new campaign runs its judge first and is refused if it already passes: write a judge that fails first.');
}

function clip(text, max = 80) {
  const value = String(text);
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function money(value) {
  return `$${Number(value).toFixed(2)}`;
}

// The flags this command understands, so positional words are what is left.
const VALUE_FLAGS = ['--work', '--break', '--rounds', '--mission', '--parallel', '--max-steps', '--max-ticks', '--runner', '--count', '--judge', '--budget', '--owner', '--seat', '--bet', '--wrong-if', '--parent', '--id', '--role', '--add', '--data', '--timeout', '--as', '--holdout', '--protect'];

function positionals(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (VALUE_FLAGS.includes(arg)) { i++; continue; }
    if (arg.startsWith('--')) continue;
    out.push(arg);
  }
  return out;
}

function readAll(args, name) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1] !== undefined) values.push(String(args[++i]));
    else if (String(args[i]).startsWith(`${name}=`)) values.push(String(args[i]).slice(name.length + 1));
  }
  return values;
}

// Agents run in shells that say so; their writes are never recorded as a
// person. ATRIS_HUMAN=1 is how a person typing inside an agent session says
// it is really them.
const AGENT_ENV = ['ATRIS_AGENT_ID', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CURSOR_AGENT'];

function defaultActor(env = process.env) {
  if (env.ATRIS_HUMAN !== '1' && AGENT_ENV.some((name) => env[name])) return env.ATRIS_AGENT_ID || 'agent';
  try {
    return `human:${os.userInfo().username}`;
  } catch {
    return 'human:unknown';
  }
}

// The campaign store and the judge belong to the nearest checkout.
function moveToCheckoutRoot(asJson) {
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
  if (dir !== process.cwd()) {
    if (!asJson) console.error(`campaign: working in ${dir}`);
    process.chdir(dir);
  }
}

function nextMove(view) {
  const move = decide(view);
  switch (move.action) {
    case 'run_judge': return { move, text: `run the judge: atris campaign judge ${view.id}` };
    case 'start_mission': return { move, text: `start mission ${move.mission_id}: atris campaign run ${view.id}` };
    case 'wait': return { move, text: move.reason === 'open asks' ? `answer ${move.asks.length} open ask${move.asks.length === 1 ? '' : 's'}: atris campaign answer ${view.id} ${move.asks[0]} "<answer>"` : `wait: ${move.reason} (atris campaign show ${view.id})` };
    case 'propose': return { move, text: `plan and run the next missions: atris campaign run ${view.id}` };
    default: return { move, text: `nothing to do: ${move.reason}` };
  }
}

const JUDGE_OUTPUT_LIMIT = 256 * 1024;

// The summary is the line that says how it went: pass and fail counts when the
// output has them, else the last line with real words in it.
function judgeSummary(output) {
  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
  const counts = lines.filter((line) => /^(ℹ|#)\s*(pass|fail)\s+\d+$/i.test(line)).map((line) => line.replace(/^(ℹ|#)\s*/, ''));
  if (counts.length) return counts.slice(-2).join(', ');
  const tally = lines.filter((line) => /\d+\s+(passed|failed|passing|failing)\b|\b(passed|failed|passing|failing)\b.*\d+/i.test(line));
  if (tally.length) return tally[tally.length - 1].slice(0, 200);
  const telling = lines.filter((line) => /[a-z0-9]{2,}/i.test(line));
  return telling.length ? telling[telling.length - 1].slice(0, 200) : '';
}

// Runs in its own process group so a timeout stops everything it started;
// keeps only the last part of a huge output instead of failing on it.
function runJudgeCommand(command, cwd, timeoutSeconds, env = process.env) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    const keep = (chunk) => {
      output += chunk;
      if (output.length > JUDGE_OUTPUT_LIMIT * 2) output = output.slice(-JUDGE_OUTPUT_LIMIT);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }, timeoutSeconds * 1000);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ passed: false, exit: null, summary: error.message.slice(0, 200), seconds: Math.round((Date.now() - started) / 1000) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const seconds = Math.round((Date.now() - started) / 1000);
      if (timedOut) return resolve({ passed: false, exit: null, summary: `timed out after ${timeoutSeconds}s`, seconds });
      resolve({ passed: code === 0, exit: code, summary: judgeSummary(output), seconds, reading: judgeReading(output), output_tail: outputTail(output) });
    });
  });
}

function makeContext(args, deps) {
  const asJson = args.includes('--json');
  const store = deps.store || openCampaignStore(process.cwd());
  const actor = readFlag(args, '--as', '') || deps.actor || defaultActor();
  const forgedHuman = readFlag(args, '--as', '').startsWith('human:');
  const runJudge = deps.runJudge || ((command, timeout, env) => runJudgeCommand(command, process.cwd(), timeout, env));
  // Held-out files live beside the campaign store, outside every checkout.
  const holdoutRoot = deps.holdoutRoot || path.dirname(store.path || campaignDbPath());
  // A campaign with a held-out file hands its path to the judge, and nothing
  // the judge prints from it reaches the store.
  const judge = async (command, timeout, campaignId) => {
    const holdout = campaignId ? findHoldout(holdoutRoot, campaignId) : null;
    const reading = await runJudge(command, timeout, holdout ? { ...process.env, ATRIS_CAMPAIGN_HOLDOUT: holdout } : process.env);
    if (!holdout) return reading;
    return { ...reading, summary: scrub(reading.summary, holdout), output_tail: scrub(reading.output_tail, holdout) };
  };
  const out = (human, json) => {
    if (asJson) console.log(JSON.stringify(json));
    else console.log(human);
  };
  const fail = (message, code = 2) => {
    if (asJson) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(message);
    return code;
  };
  const append = (campaignId, type, data, as = actor) => store.append({ campaign_id: campaignId, type, actor: as, data });
  return { asJson, store, actor, judge, holdoutRoot, out, fail, append, forgedHuman, loopDeps: deps.loopDeps, cloud: deps.cloud || {} };
}

function requireCampaign(ctx, id) {
  if (!id) return { error: ctx.fail('name the campaign: atris campaign <verb> <id>') };
  const view = getCampaign(ctx.store, id);
  if (!view) return { error: ctx.fail(`no campaign ${id}. See them all with: atris campaign`, 1) };
  if (view.error) return { error: ctx.fail(`campaign ${id} cannot be read: ${view.error}`, 1) };
  return { view };
}

function renderList(views) {
  if (!views.length) {
    return 'No campaigns yet. Start one:\n  atris campaign start "<title>" --judge "<command that fails today>" --budget <dollars>';
  }
  const sorted = views.slice().sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state));
  const lines = [];
  for (const view of sorted) {
    const running = view.missions.filter((m) => m.status === 'running').length;
    lines.push(`${clip(view.title)}  (${view.id})`);
    lines.push(`  ${view.state.replace(/_/g, ' ')} · ${money(view.budget.spent)} of ${money(view.budget.total)} · ${running} mission${running === 1 ? '' : 's'} running · answer ${view.answer.confidence}`);
    lines.push(`  next: ${nextMove(view).text}`);
  }
  return lines.join('\n');
}

function renderShow(view) {
  const next = nextMove(view).text;
  const lines = [`${clip(view.title)}  (${view.id})`, ''];
  const row = (label, value) => lines.push(`${label.padEnd(9)} ${value}`);
  row('state', `${view.state.replace(/_/g, ' ')}${view.stop_reason ? ` (${view.stop_reason.replace(/_/g, ' ')})` : ''} · next: ${next}`);
  const last = view.last_judge;
  row('judge', `${view.judge}${last ? ` · last run ${last.passed ? 'passed' : 'failed'} at ${last.at}` : ' · never run'}${view.judge_due && last ? ' · due again' : ''}`);
  row('answer', `${view.answer.confidence}${view.answer.text ? `: ${view.answer.text}` : ''}`);
  row('budget', `${money(view.budget.spent)} spent of ${money(view.budget.total)} · ${money(view.budget.reserved)} reserved · ${money(view.budget.available)} left`);
  row('owner', view.owner + (view.standing ? ' · standing (a passing judge means healthy, not done)' : ''));
  if (view.bet) row('bet', `${view.bet.text}${view.bet.wrong_if ? ` · wrong if ${view.bet.wrong_if}` : ''}`);
  if (view.parent) row('parent', view.parent);
  row('seats', view.seats.length ? view.seats.map((s) => (s.role ? `${s.member} (${s.role})` : s.member)).join(', ') : 'none');
  row('missions', view.missions.length ? '' : 'none');
  for (const m of view.missions) {
    const cost = m.cost_usd === null ? '' : ` · ${money(m.cost_usd)}`;
    lines.push(`  ${m.id.padEnd(22)} ${m.status.padEnd(8)} ${m.member || '-'}${m.outcome ? ` · ${m.outcome}` : ''}${cost}`);
  }
  row('asks', view.asks.length ? '' : 'none');
  for (const ask of view.asks) lines.push(`  ${ask.id}: ${ask.question}`);
  if (view.warnings.length) {
    row('warnings', '');
    for (const w of view.warnings) lines.push(`  ${w.code.replace(/_/g, ' ')} (${w.event_id})`);
  }
  return lines.join('\n');
}

async function cmdStart(args, ctx) {
  const title = positionals(args)[1];
  const judge = readFlag(args, '--judge', '');
  const budgetText = readFlag(args, '--budget', '');
  const budget = Number(budgetText);
  const bet = readFlag(args, '--bet', '');
  const wrongIf = readFlag(args, '--wrong-if', '');
  const parent = readFlag(args, '--parent', '');
  const standing = args.includes('--standing');
  const owner = readFlag(args, '--owner', '');
  const seats = readAll(args, '--seat').map((seat) => {
    const [member, role] = seat.split(':');
    return role ? { member, role } : member;
  });
  const record = { title, judge, budget: budgetText ? budget : undefined };
  if (owner) record.owner = owner;
  if (seats.length) record.seats = seats;
  if (bet) record.bet = bet;
  if (standing) record.standing = true;
  if (parent) record.parent = parent;
  for (const key of Object.keys(record)) if (record[key] === undefined) delete record[key];

  const lookup = (id) => {
    const view = getCampaign(ctx.store, id);
    return view && !view.error ? { parent: view.parent } : null;
  };
  const check = validateCampaign(record, { lookup });
  if (!check.ok) {
    const words = {
      missing_title: 'a title in quotes', missing_judge: '--judge "<command>"', bad_budget: '--budget <dollars above 0>',
      nested_parent: 'a parent with no parent of its own (one level only)', unknown_parent: 'a --parent that exists', bad_seat: '--seat <member>[:<role>]',
    };
    return ctx.fail(`a campaign needs ${check.errors.map((e) => words[e] || e).join(', ')}`);
  }
  if (wrongIf && !bet) return ctx.fail('--wrong-if goes with --bet');

  const id = readFlag(args, '--id', '') || newCampaignId(title);
  if (!CAMPAIGN_ID.test(id)) return ctx.fail(`--id must look like cmp-<lowercase-words>, for example cmp-ship-billing`);
  if (getCampaign(ctx.store, id)) return ctx.fail(`campaign ${id} already exists`, 1);
  const protect = readAll(args, '--protect');
  const protectPlan = protect.length ? planProtect(process.cwd(), protect) : null;
  if (protectPlan && protectPlan.error) return ctx.fail(protectPlan.error);

  const holdoutFlag = readFlag(args, '--holdout', '');
  let held = null;
  if (holdoutFlag) {
    held = moveHoldoutIn(ctx.holdoutRoot, id, holdoutFlag);
    if (held.error) return ctx.fail(held.error);
    if (!ctx.asJson) console.error(`moved the held-out file out of the repo; the judge reads it from ATRIS_CAMPAIGN_HOLDOUT`);
  }

  const timeout = Number(readFlag(args, '--timeout', '')) || JUDGE_TIMEOUT_SECONDS;
  if (!ctx.asJson) console.error(`running the judge first: ${judge}`);
  const reading = await ctx.judge(judge, timeout, id);
  if (reading.passed && !standing) {
    moveHoldoutBack(held);
    return ctx.fail(`already done: the judge passes before any work (${reading.summary || 'exit 0'}). Write a judge that fails first.`, 1);
  }

  const startData = { title, judge, budget, owner: owner || 'mission-lead', created_from: `atris campaign start by ${ctx.actor}` };
  if (seats.length) startData.seats = seats;
  if (bet && !wrongIf) startData.bet = bet;
  if (standing) startData.standing = true;
  ctx.append(id, 'campaign_started', startData);
  if (bet && wrongIf) ctx.append(id, 'bet_set', { bet, wrong_if: wrongIf });
  if (parent) ctx.append(id, 'attached', { parent_id: parent });
  ctx.append(id, 'judge_ran', judgeRanData(reading), 'judge');
  if (protectPlan) saveProtect(ctx.campaignHome, id, protectPlan);

  let cloud = null;
  if (args.includes('--cloud')) {
    cloud = await syncCampaign(ctx.store, id, ctx.cloud);
    if (!cloud.ok && !ctx.asJson) console.error(`started here, not yet in the cloud: ${cloud.error}. Try again with: atris campaign sync ${id}`);
  }
  const view = getCampaign(ctx.store, id);
  const synced = cloud && cloud.ok ? `\nin the cloud: ${cloud.pushed} event${cloud.pushed === 1 ? '' : 's'} sent` : '';
  ctx.out(`started ${view.title} (${id})${synced}\n${renderShow(view)}`, { ok: true, action: 'campaign_started', campaign: view, next: decide(view), ...(cloud ? { cloud } : {}) });
  return 0;
}

function describeSync(result) {
  const parts = [`sent ${result.pushed}`, `received ${result.pulled}`];
  if (result.duplicates) parts.push(`${result.duplicates} already there`);
  if (result.held) parts.push(`${result.held} kept here (only a person's screen sends answers, budget, and done)`);
  return `synced with the cloud: ${parts.join(', ')}`;
}

async function cmdSync(args, ctx) {
  const { view, error } = requireCampaign(ctx, positionals(args)[1]);
  if (error !== undefined) return error;
  const result = await syncCampaign(ctx.store, view.id, ctx.cloud);
  if (!result.ok) {
    if (ctx.asJson) console.log(JSON.stringify(result));
    else console.error(`sync failed: ${result.error}`);
    return 1;
  }
  const after = getCampaign(ctx.store, view.id);
  ctx.out(`${describeSync(result)}\n${renderShow(after)}`, { ...result, campaign: after, next: decide(after) });
  return 0;
}

function cmdShow(args, ctx) {
  const { view, error } = requireCampaign(ctx, positionals(args)[1]);
  if (error !== undefined) return error;
  ctx.out(renderShow(view), { ok: true, campaign: view, next: decide(view) });
  return 0;
}

// Change the judge. Like a new campaign, the new judge must fail first
// (unless the campaign is standing), so nobody swaps in a judge that passes.
async function cmdSetJudge(args, ctx) {
  const words = positionals(args);
  const { view, error } = requireCampaign(ctx, words[1]);
  if (error !== undefined) return error;
  const judge = words[2];
  if (!judge) return ctx.fail('name the new judge: atris campaign set-judge <id> "<command that fails today>"');
  if (ctx.actor !== view.owner && !String(ctx.actor).startsWith('human:')) {
    return ctx.fail(`only the owner (${view.owner}) or a person can change the judge`);
  }
  const timeout = Number(readFlag(args, '--timeout', '')) || JUDGE_TIMEOUT_SECONDS;
  if (!ctx.asJson) console.error(`running the new judge first: ${judge}`);
  const reading = await ctx.judge(judge, timeout, view.id);
  if (reading.passed && !view.standing) {
    return ctx.fail(`the new judge already passes (${reading.summary || 'exit 0'}). Write a judge that fails first.`, 1);
  }
  ctx.append(view.id, 'judge_set', { judge, from: view.judge });
  ctx.append(view.id, 'judge_ran', { passed: reading.passed, summary: reading.summary || `exit ${reading.exit}`, seconds: reading.seconds }, 'judge');
  const after = getCampaign(ctx.store, view.id);
  ctx.out(`judge changed to: ${judge}\n${renderShow(after)}`, { ok: true, action: 'judge_set', campaign: after, next: decide(after) });
  return 0;
}

async function cmdJudge(args, ctx) {
  const { view, error } = requireCampaign(ctx, positionals(args)[1]);
  if (error !== undefined) return error;
  const timeout = Number(readFlag(args, '--timeout', '')) || JUDGE_TIMEOUT_SECONDS;
  if (!ctx.asJson) console.error(`running the judge: ${view.judge}`);
  const reading = await ctx.judge(view.judge, timeout, view.id);
  ctx.append(view.id, 'judge_ran', judgeRanData(reading), 'judge');
  const after = getCampaign(ctx.store, view.id);
  const verdict = reading.passed ? 'passed' : 'failed';
  ctx.out(`judge ${verdict} in ${reading.seconds}s: ${reading.summary || `exit ${reading.exit}`}\n${renderShow(after)}`,
    { ok: true, action: 'judge_ran', passed: reading.passed, reading, campaign: after, next: decide(after) });
  return reading.passed ? 0 : 1;
}

// Exit 1 when a protected path changed since start, naming each one.
function cmdGuard(args, ctx) {
  const { view, error } = requireCampaign(ctx, positionals(args)[1]);
  if (error !== undefined) return error;
  const saved = readProtect(ctx.campaignHome, view.id);
  if (!saved) {
    ctx.out(`${view.id} protects nothing`, { ok: true, campaign_id: view.id, paths: [], changed: [] });
    return 0;
  }
  const root = checkoutTop(process.cwd());
  if (!root) return ctx.fail('guard needs the git checkout the campaign started in');
  const result = changedProtected(root, saved);
  if (result.error) return ctx.fail(result.error);
  const body = { ok: result.changed.length === 0, campaign_id: view.id, base_commit: saved.base_commit, paths: saved.paths, changed: result.changed };
  const since = String(saved.base_commit).slice(0, 12);
  if (result.changed.length) {
    if (ctx.asJson) console.log(JSON.stringify(body));
    else console.error(`protected path${result.changed.length === 1 ? '' : 's'} changed since ${since}:\n${result.changed.map((p) => `  ${p}`).join('\n')}`);
    return 1;
  }
  ctx.out(`no protected path changed since ${since} (${saved.paths.join(', ')})`, body);
  return 0;
}

// toCloud(data) names the cloud person route for events only a person's
// screen may send (api.md): on a synced campaign a person's answer or budget
// goes there and comes back by pull. Offline, it is recorded here instead.
function simpleEvent(type, buildData, describe, toCloud = null) {
  return async (args, ctx) => {
    const words = positionals(args);
    const { view, error } = requireCampaign(ctx, words[1]);
    if (error !== undefined) return error;
    const built = buildData(args, words, view);
    if (built.error) return ctx.fail(built.error);
    let via = 'local';
    if (toCloud && isHumanActor(ctx.actor) && cloudLink(ctx.store, view.id)) {
      const sent = await sendPersonAction(ctx.store, view.id, toCloud(built.data), ctx.cloud);
      if (sent.ok) via = 'cloud';
      else if (!ctx.asJson) console.error(`recorded here only; the cloud did not take it: ${sent.error}`);
    }
    if (via === 'local') ctx.append(view.id, type, built.data);
    const after = getCampaign(ctx.store, view.id);
    ctx.out(`${describe(built.data, after)}\n${renderShow(after)}`, { ok: true, action: type, via, campaign: after, next: decide(after) });
    return 0;
  };
}

function seatRole(member) {
  const { autoJobForMember } = require('../lib/member-engine');
  return autoJobForMember(member);
}

const cmdSeat = simpleEvent('seat_filled', (args, words) => {
  const member = words[2];
  if (!member) return { error: 'name the member: atris campaign seat <id> <member> [--role <role>]' };
  return { data: { member, role: readFlag(args, '--role', '') || seatRole(member) } };
}, (d) => `seated ${d.member} as ${d.role}`);

const cmdBet = simpleEvent('bet_set', (args, words) => {
  const bet = words[2];
  if (!bet) return { error: 'write the bet: atris campaign bet <id> "<bet>" [--wrong-if "..."]' };
  const wrongIf = readFlag(args, '--wrong-if', '');
  return { data: wrongIf ? { bet, wrong_if: wrongIf } : { bet } };
}, (d) => `bet set: ${d.bet}`);

const cmdBudget = simpleEvent('budget_added', (args) => {
  const amount = Number(readFlag(args, '--add', ''));
  if (!(amount > 0)) return { error: 'say how much to add: atris campaign budget <id> --add <dollars>' };
  return { data: { amount_usd: amount } };
}, (d, view) => `added ${money(d.amount_usd)}; budget is now ${money(view.budget.total)}`, (d) => ({ action: 'add_budget', amount_usd: d.amount_usd }));

// The no-reload line: anything that cannot be undone waits here for a person.
const cmdAsk = simpleEvent('ask_opened', (args, words) => {
  const question = words[2];
  if (!question) return { error: 'write the question: atris campaign ask <id> "<question>" [--mission <mission-id>]' };
  const askId = `a-${require('crypto').randomBytes(3).toString('hex')}`;
  const mission = readFlag(args, '--mission', '');
  return { data: mission ? { ask_id: askId, question, mission_id: mission } : { ask_id: askId, question } };
}, (d) => `asked ${d.ask_id}: ${d.question}`);

const cmdAnswer = simpleEvent('ask_answered', (args, words) => {
  const askId = words[2];
  const answer = words[3];
  if (!askId || !answer) return { error: 'answer an ask: atris campaign answer <id> <ask-id> "<answer>"' };
  return { data: { ask_id: askId, answer } };
}, (d, view) => (view.asks.some((a) => a.id === d.ask_id) ? `not closed: only a person can answer ${d.ask_id}` : `answered ${d.ask_id}: ${d.answer}`), (d) => ({ ask_id: d.ask_id, answer: d.answer }));

const cmdPause = simpleEvent('paused', () => ({ data: {} }), () => 'paused');
const cmdResume = simpleEvent('resumed', () => ({ data: {} }), () => 'resumed');
const cmdStop = simpleEvent('stopped', () => ({ data: {} }), () => 'stopped');

const cmdEvent = (args, ctx) => {
  const words = positionals(args);
  const { view, error } = requireCampaign(ctx, words[1]);
  if (error !== undefined) return error;
  const type = words[2];
  if (!type) return ctx.fail('name the event type: atris campaign event <id> <type> [--data \'<json>\']');
  // Events that only the judge or a person may write have their own verbs.
  const guarded = { judge_ran: 'atris campaign judge', ask_answered: 'atris campaign answer', done: 'atris campaign stop, or a passing judge', budget_added: 'atris campaign budget --add', campaign_started: 'atris campaign start' };
  if (guarded[type]) return ctx.fail(`${type} cannot be written by hand; use ${guarded[type]}`);
  let data;
  try {
    data = JSON.parse(readFlag(args, '--data', '') || '{}');
  } catch {
    return ctx.fail('--data must be JSON, for example --data \'{"mission_id":"m1"}\'');
  }
  try {
    ctx.append(view.id, type, data);
  } catch (err) {
    if (err.code === 'invalid_event' || err.code === 'mission_in_other_campaign') return ctx.fail(err.message);
    throw err;
  }
  const after = getCampaign(ctx.store, view.id);
  ctx.out(`recorded ${type}\n${renderShow(after)}`, { ok: true, action: type, campaign: after, next: decide(after) });
  return 0;
};

async function cmdLoop(args, ctx, verb) {
  const { view, error } = requireCampaign(ctx, positionals(args)[1]);
  if (error !== undefined) return error;
  const { makeLoop } = require('../lib/campaign-loop');
  // A synced campaign trades events around every step. Failures warn and the
  // loop runs on offline; a refusal (403, 409) stops syncing for this run
  // instead of asking again every step.
  const syncWarnings = [];
  let refused = false;
  let failing = false;
  const sync = cloudLink(ctx.store, view.id) ? async (id) => {
    if (refused) return 0;
    const result = await syncCampaign(ctx.store, id, ctx.cloud);
    if (result.ok) {
      failing = false;
      return result.pulled;
    }
    if (result.status === 403 || result.status === 409) refused = true;
    // One warning per stretch of failures, not one per step.
    if (!failing || refused) {
      const warning = `sync: ${result.error}${refused ? '; not syncing again this run' : '; running on offline'}`;
      syncWarnings.push(warning);
      if (!ctx.asJson) console.error(warning);
    }
    failing = true;
    return 0;
  } : undefined;
  const loop = makeLoop(process.cwd(), {
    parallel: readFlag(args, '--parallel', '') || readFlag(args, '--count', ''),
    maxTicks: readFlag(args, '--max-ticks', ''),
    runner: readFlag(args, '--runner', ''),
    actor: ctx.actor,
  }, {
    store: ctx.store,
    log: ctx.asJson ? () => {} : (line) => console.log(line),
    judge: (command) => ctx.judge(command, JUDGE_TIMEOUT_SECONDS, view.id),
    lessons: (id) => require('../lib/campaign-cadence').readLessons(process.cwd(), id),
    ...(sync ? { sync } : {}),
    ...(ctx.loopDeps || {}),
  });
  if (verb === 'propose') {
    const proposals = await loop.propose(view.id);
    const after = getCampaign(ctx.store, view.id);
    ctx.out(proposals.length ? `${proposals.length} proposed and claimed\n${renderShow(after)}` : 'nothing usable was proposed', { ok: proposals.length > 0, proposals, campaign: after, next: decide(after) });
    return proposals.length ? 0 : 1;
  }
  if (verb === 'step') {
    const result = await loop.step(view.id);
    const after = getCampaign(ctx.store, view.id);
    ctx.out(`${result.stop ? `stopped: ${result.reason}` : `did: ${result.did}`}\n${renderShow(after)}`, { ok: true, ...result, campaign: after, next: decide(after), sync_warnings: syncWarnings });
    return 0;
  }
  const work = readFlag(args, '--work', '');
  const pause = readFlag(args, '--break', '');
  const rounds = readFlag(args, '--rounds', '');
  if (work || pause || rounds) {
    const { makeCadence } = require('../lib/campaign-cadence');
    const { askOwner } = require('../lib/campaign-loop');
    let cadence;
    try {
      cadence = makeCadence(process.cwd(), loop, { work, break: pause, rounds }, { store: ctx.store, log: ctx.asJson ? () => {} : (line) => console.log(line), ask: (ctx.loopDeps && ctx.loopDeps.ask) || askOwner });
    } catch (err) {
      return ctx.fail(err.message);
    }
    const result = await cadence.run(view.id);
    ctx.out(`stopped after ${result.rounds} round${result.rounds === 1 ? '' : 's'}: ${result.reason}\n${renderShow(result.campaign)}`, { ok: true, ...result, next: decide(result.campaign) });
    return 0;
  }
  const maxSteps = Number(readFlag(args, '--max-steps', '')) || 20;
  const result = await loop.run(view.id, maxSteps);
  ctx.out(`stopped after ${result.steps} step${result.steps === 1 ? '' : 's'}: ${result.reason}\n${renderShow(result.campaign)}`, { ok: true, ...result, next: decide(result.campaign), sync_warnings: syncWarnings });
  return 0;
}

const VERBS = {
  start: cmdStart, show: cmdShow, judge: cmdJudge, guard: cmdGuard, seat: cmdSeat, bet: cmdBet, budget: cmdBudget,
  pause: cmdPause, resume: cmdResume, stop: cmdStop, event: cmdEvent,
  ask: cmdAsk, answer: cmdAnswer, 'set-judge': cmdSetJudge, sync: cmdSync,
  run: (args, ctx) => cmdLoop(args, ctx, 'run'),
  step: (args, ctx) => cmdLoop(args, ctx, 'step'),
  propose: (args, ctx) => cmdLoop(args, ctx, 'propose'),
  // atris campaign new "<goal>": the owner's engine drafts a judge that fails today (lib/campaign-new.js).
  new: (args, ctx) => require('../lib/campaign-new').draftAndStart(args, ctx, { start: cmdStart, goal: positionals(args)[1], ask: ctx.loopDeps && ctx.loopDeps.ask }),
  export: (args, ctx) => require('../lib/campaign-trace').exportTrace(args, ctx),
};

function campaignCommand(args = [], deps = {}) {
  if (!deps.store) moveToCheckoutRoot(args.includes('--json'));
  const verb = positionals(args)[0];
  if (verb === 'help' || args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }
  const ctx = makeContext(args, deps);
  ctx.campaignHome = deps.campaignHome || campaignHome(ctx.store);
  if (ctx.forgedHuman) return ctx.fail('--as cannot name a person; a person runs atris in their own terminal (or sets ATRIS_HUMAN=1)');
  if (!verb || verb === 'list') {
    const all = listCampaigns(ctx.store);
    const views = all.filter((view) => !view.error);
    const unreadable = all.filter((view) => view.error);
    const notes = unreadable.map((view) => `${view.id}  cannot be read (${view.error})`);
    ctx.out([renderList(views), ...notes].filter(Boolean).join('\n'), { ok: true, campaigns: views.map((view) => ({ ...view, next: decide(view) })), unreadable });
    return 0;
  }
  const handler = VERBS[verb];
  if (!handler) return ctx.fail(`unknown verb ${verb}. Verbs: ${Object.keys(VERBS).join(', ')}`);
  return handler(args, ctx);
}

module.exports = { campaignCommand, renderShow, runJudgeCommand };
