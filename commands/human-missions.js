'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { knownCommands } = require('../lib/known-commands');
const {
  enqueueCloudMission,
  fetchCloudMissionStatus,
  fetchCurrentCloudMission,
  updateCloudMission,
  fetchCloudMissionChecks,
} = require('../lib/cloud-mission');
const { apiRequestJson } = require('../utils/api');
const { decodeJwtClaims, loadCredentials } = require('../utils/auth');

const PACKAGE_PATH = path.join(__dirname, '..', 'package.json');
const HUMAN_STATES = Object.freeze({
  ready: 'Ready',
  working: 'Working',
  your_turn: 'Your turn',
  checking: 'Checking',
  done: 'Done',
  stopped: 'Stopped',
});

class HumanCommandError extends Error {
  constructor(message, next, exitCode = 1) {
    super(message);
    this.name = 'HumanCommandError';
    this.next = next;
    this.exitCode = exitCode;
  }
}

function normalizeWant(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function stableMissionKey(userId, businessId, want) {
  return crypto
    .createHash('sha256')
    .update(`${String(userId)}\n${String(businessId)}\n${normalizeWant(want)}`)
    .digest('hex');
}

function valueFlag(args, name) {
  const prefix = `${name}=`;
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index]);
    if (value.startsWith(prefix)) return { present: true, value: value.slice(prefix.length), index };
    if (value === name) {
      const next = args[index + 1];
      return {
        present: true,
        value: next && !String(next).startsWith('--') ? String(next) : '',
        index,
      };
    }
  }
  return { present: false, value: '', index: -1 };
}

function parseAskArgs(args) {
  const budgetFlag = valueFlag(args, '--budget');
  if (budgetFlag.present && !budgetFlag.value) {
    throw new HumanCommandError(
      'Atris needs a dollar amount after --budget.',
      'Try again with: atris ask "what you want" --budget 2',
      2,
    );
  }
  let budgetUsd = null;
  if (budgetFlag.present) {
    budgetUsd = Number(budgetFlag.value);
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
      throw new HumanCommandError(
        'Atris could not use that budget because it is not a positive dollar amount.',
        'Try again with: atris ask "what you want" --budget 2',
        2,
      );
    }
  }

  const textParts = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index]);
    if (value === '--json') continue;
    if (value === '--budget') {
      index += 1;
      continue;
    }
    if (value.startsWith('--budget=')) continue;
    if (value.startsWith('--')) {
      throw new HumanCommandError(
        `Atris does not know the option ${value}.`,
        'Run: atris ask --help',
        2,
      );
    }
    textParts.push(value);
  }
  const text = textParts.join(' ').trim();
  if (!text) {
    throw new HumanCommandError(
      'Atris needs to know what you want.',
      'Try: atris ask "make the home page clearer"',
      2,
    );
  }
  return { text, budgetUsd, asJson: args.includes('--json') };
}

function findWorkspaceFile(root, relativePath) {
  let current = path.resolve(root || process.cwd());
  while (true) {
    const candidate = path.join(current, relativePath);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function readBusinessBinding(root) {
  const file = findWorkspaceFile(root, path.join('.atris', 'business.json'));
  if (!file) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const businessId = String(parsed.business_id || parsed.id || '').trim();
    return businessId || null;
  } catch {
    return null;
  }
}

function credentialUserId(credentials) {
  const claims = decodeJwtClaims(credentials && credentials.token);
  return String(
    credentials && (credentials.user_id || credentials.email)
    || claims && (claims.sub || claims.user_id || claims.email)
    || '',
  ).trim();
}

async function resolveBusinessId(credentials, options = {}) {
  const bound = options.businessId
    || process.env.ATRIS_BUSINESS_ID
    || credentials && credentials.business_id
    || readBusinessBinding(options.root || process.cwd());
  if (bound) return String(bound);

  const request = options.apiRequestJson || apiRequestJson;
  const response = await request('/business/', {
    method: 'GET',
    token: credentials.token,
  });
  if (!response || !response.ok || !Array.isArray(response.data)) {
    throw new HumanCommandError(
      'Atris could not find the business for this work.',
      'Open a business workspace, then try again.',
    );
  }
  const businesses = response.data.filter((business) => business && (business.id || business.business_id));
  if (businesses.length === 1) return String(businesses[0].id || businesses[0].business_id);
  if (businesses.length > 1) {
    throw new HumanCommandError(
      'Atris found more than one business and could not safely choose one.',
      'Open the business workspace you want, then try again.',
    );
  }
  throw new HumanCommandError(
    'Atris could not find a business to do this work for.',
    'Create or join a business, then try again.',
  );
}

function wireState(value, needs = null) {
  const state = String(value || '').trim().toLowerCase().replace(/[ -]+/g, '_');
  if (needs && (!state || ['paused', 'blocked', 'waiting'].includes(state))) return 'your_turn';
  if (['ready', 'pending', 'queued', 'planning', 'created'].includes(state)) return 'ready';
  if (['working', 'running', 'active', 'in_progress', 'started'].includes(state)) return 'working';
  if (['your_turn', 'waiting_for_human', 'needs_input', 'paused', 'blocked'].includes(state)) return 'your_turn';
  if (['checking', 'verifying', 'reviewing', 'review'].includes(state)) return 'checking';
  if (['done', 'complete', 'completed', 'passed', 'success', 'succeeded'].includes(state)) return 'done';
  if (['stopped', 'cancelled', 'canceled', 'failed', 'error'].includes(state)) return 'stopped';
  return 'ready';
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function secondsBetween(start, end) {
  const startMs = Date.parse(start || '');
  const endMs = Date.parse(end || '');
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return Math.max(0, Math.round((endMs - startMs) / 1000));
}

function defaultProgress(state) {
  return {
    ready: 0,
    working: 35,
    your_turn: 50,
    checking: 90,
    done: 100,
    stopped: 0,
  }[state];
}

function defaultWorkingOn(state) {
  return {
    ready: 'Waiting to start',
    working: 'Working through your request',
    your_turn: 'Waiting for your answer',
    checking: 'Checking the finished work',
    done: 'Work finished',
    stopped: 'Work stopped',
  }[state];
}

function defaultNext(state) {
  return {
    ready: 'Start the work',
    working: 'Finish and check the work',
    your_turn: 'Answer or approve the request',
    checking: 'Finish the checks',
    done: 'Review the proof',
    stopped: 'Start a new mission when ready',
  }[state];
}

function missionCard(payload, fallback = {}, now = Date.now()) {
  const outer = payload && typeof payload === 'object' ? payload : {};
  const source = outer.card || outer.mission || outer;
  const result = source.result && typeof source.result === 'object' ? source.result : {};
  const needs = source.needs || result.needs || null;
  const state = wireState(source.state || source.status || result.state || result.status, needs);
  const progress = numberOrNull(source.progress_pct ?? result.progress_pct);
  const startedAt = source.started_at || outer.started_at || source.created_at || outer.created_at;
  const endedAt = source.completed_at || outer.completed_at || source.stopped_at || outer.stopped_at;
  const elapsed = numberOrNull(source.elapsed_s ?? result.elapsed_s)
    ?? secondsBetween(startedAt, endedAt || new Date(now).toISOString())
    ?? 0;
  const content = source.content && typeof source.content === 'object' ? source.content : {};
  const rawTitle = source.title || result.title || fallback.title || content.text || source.text || 'Current mission';
  const title = String(rawTitle).split('\n\nWhen you finish,')[0].trim() || 'Current mission';
  return {
    mission_id: String(source.mission_id || source.task_id || source.id || outer.mission_id || outer.task_id || outer.id || fallback.mission_id || ''),
    title,
    state,
    progress_pct: Math.max(0, Math.min(100, Math.round(progress ?? defaultProgress(state)))),
    working_on: String(source.working_on || result.working_on || result.current_step || defaultWorkingOn(state)),
    next: String(source.next || source.next_action || result.next || result.next_action || defaultNext(state)),
    elapsed_s: Math.max(0, Math.round(elapsed)),
    cost_usd: numberOrNull(source.cost_usd ?? result.cost_usd) ?? 0,
    budget_usd: numberOrNull(source.budget_usd ?? result.budget_usd ?? fallback.budget_usd),
    needs: needs && typeof needs === 'object'
      ? {
        question: String(needs.question || needs.text || ''),
        options: Array.isArray(needs.options) ? needs.options : [],
      }
      : null,
  };
}

function statusPhrase(state) {
  return {
    ready: 'Ready to begin your work',
    working: 'Working on your request now',
    your_turn: 'Waiting for your answer now',
    checking: 'Checking the finished work now',
    done: 'Your work is finished now',
    stopped: 'This work has been stopped',
  }[state];
}

function formatSeconds(value) {
  const seconds = Math.max(0, Math.round(Number(value) || 0));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function progressBar(progressPct) {
  const width = 20;
  const filled = Math.round((progressPct / 100) * width);
  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}] ${progressPct}%`;
}

function renderMissionCard(card) {
  const humanState = HUMAN_STATES[card.state] || HUMAN_STATES.ready;
  const cost = `$${card.cost_usd.toFixed(2)}`;
  const budget = card.budget_usd === null ? cost : `${cost} of $${card.budget_usd.toFixed(2)}`;
  const lines = [
    card.title,
    `${humanState}: ${statusPhrase(card.state)}`,
    progressBar(card.progress_pct),
    `Working on: ${card.working_on}`,
    `Next: ${card.next}`,
    `Time: ${formatSeconds(card.elapsed_s)}`,
    `Cost: ${budget}`,
  ];
  if (card.needs && card.needs.question) lines.push(`Needs you: ${card.needs.question}`);
  return lines;
}

function outputCard(card, asJson, log = console.log) {
  if (asJson) {
    log(JSON.stringify(card, null, 2));
    return;
  }
  for (const line of renderMissionCard(card)) log(line);
}

function latestCloudReceipt(root) {
  const file = findWorkspaceFile(root || process.cwd(), path.join('.atris', 'state', 'missions.jsonl'));
  if (!file) return null;
  try {
    const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      let row = null;
      try { row = JSON.parse(rows[index]); } catch { continue; }
      if (row && row.cloud === true && row.task_id) return row;
    }
  } catch {
    return null;
  }
  return null;
}

function errorCopy(caught, action) {
  if (caught instanceof HumanCommandError) {
    return { message: caught.message, next: caught.next, exitCode: caught.exitCode };
  }
  const status = Number(caught && caught.status) || 0;
  if (status === 401 || /not logged in/i.test(String(caught && caught.message || ''))) {
    return {
      message: `Atris could not ${action} because you are not signed in.`,
      next: 'Run: atris login',
      exitCode: 1,
    };
  }
  if (status === 404 && action === 'show the current mission') {
    return {
      message: 'There is no current mission.',
      next: 'Start one with: atris ask "what you want"',
      exitCode: 1,
    };
  }
  if (status === 0) {
    return {
      message: `Atris could not ${action} because its service could not be reached.`,
      next: 'Check your connection, then try again.',
      exitCode: 1,
    };
  }
  return {
    message: `Atris could not ${action}.`,
    next: 'Nothing changed. Check atris mission, then try again.',
    exitCode: caught && caught.exitCode || 1,
  };
}

function reportError(caught, action, asJson, options = {}) {
  const copy = errorCopy(caught, action);
  const logError = options.error || console.error;
  const log = options.log || console.log;
  if (asJson) {
    log(JSON.stringify({
      ok: false,
      error: copy.message,
      did: 'Nothing changed.',
      next: copy.next,
    }, null, 2));
  } else {
    logError(copy.message);
    logError('Atris left your work unchanged.');
    logError(copy.next);
  }
  if (options.setProcessExitCode !== false) process.exitCode = copy.exitCode;
  return copy.exitCode;
}

function credentialsOrThrow(options = {}) {
  const load = options.loadCredentials || loadCredentials;
  const credentials = load();
  if (!credentials || !String(credentials.token || '').trim()) {
    throw new HumanCommandError(
      'Atris could not continue because you are not signed in.',
      'Run: atris login',
    );
  }
  return credentials;
}

async function askCommand(args, options = {}) {
  const asJson = args.includes('--json');
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    (options.log || console.log)('Usage: atris ask "what you want" [--budget <usd>] [--json]');
    return 0;
  }
  try {
    const parsed = parseAskArgs(args);
    const credentials = credentialsOrThrow(options);
    const userId = credentialUserId(credentials);
    if (!userId) {
      throw new HumanCommandError(
        'Atris could not safely identify who is starting this work.',
        'Sign in again with: atris login',
      );
    }
    const businessId = await resolveBusinessId(credentials, options);
    const idempotencyKey = stableMissionKey(userId, businessId, parsed.text);
    const mission = await enqueueCloudMission({
      text: parsed.text,
      businessId,
      idempotencyKey,
      budgetUsd: parsed.budgetUsd,
    }, options);
    const receipt = {
      cloud: true,
      task_id: mission.mission_id || mission.task_id || mission.id,
      lane: mission.lane || 'fast',
      text: parsed.text,
      business_id: businessId,
      budget_usd: parsed.budgetUsd,
    };
    const append = options.appendCloudMissionReceipt
      || require('../lib/cloud-mission').appendCloudMissionReceipt;
    append(options.root || process.cwd(), receipt);
    const card = missionCard(mission, {
      mission_id: receipt.task_id,
      title: parsed.text,
      budget_usd: parsed.budgetUsd,
    }, options.now ? options.now() : Date.now());
    const log = options.log || console.log;
    if (!parsed.asJson) {
      const separator = /[.!?]$/.test(parsed.text) ? ' ' : '. ';
      log(`I understood: ${parsed.text}${separator}I'm starting now.`);
      log('');
    }
    outputCard(card, parsed.asJson, log);
    return 0;
  } catch (caught) {
    return reportError(caught, 'start that mission', asJson, options);
  }
}

async function loadCurrentMission(options = {}) {
  try {
    return await fetchCurrentCloudMission(options);
  } catch (caught) {
    if (Number(caught && caught.status) !== 404) throw caught;
    const receipt = latestCloudReceipt(options.root || process.cwd());
    if (!receipt) throw caught;
    const mission = await fetchCloudMissionStatus(receipt.task_id, options);
    return {
      ...mission,
      title: mission.title || receipt.text,
      budget_usd: mission.budget_usd ?? receipt.budget_usd,
    };
  }
}

async function currentMissionCommand(args = [], options = {}) {
  const asJson = args.includes('--json');
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    (options.log || console.log)('Usage: atris mission [--json]');
    return 0;
  }
  try {
    credentialsOrThrow(options);
    const mission = await loadCurrentMission(options);
    const card = missionCard(mission, {}, options.now ? options.now() : Date.now());
    outputCard(card, asJson, options.log || console.log);
    return 0;
  } catch (caught) {
    return reportError(caught, 'show the current mission', asJson, options);
  }
}

async function changeCurrentMission(action, body, args, options = {}) {
  const asJson = args.includes('--json');
  try {
    credentialsOrThrow(options);
    const current = await loadCurrentMission(options);
    const currentCard = missionCard(current, {}, options.now ? options.now() : Date.now());
    if (!currentCard.mission_id) {
      throw new HumanCommandError(
        'Atris could not identify the current mission.',
        'Run: atris mission',
      );
    }
    if (['approve', 'answer'].includes(action) && currentCard.state !== 'your_turn') {
      throw new HumanCommandError(
        action === 'approve'
          ? 'Nothing is waiting for your approval.'
          : 'The current mission is not waiting for an answer.',
        'Check it with: atris mission',
      );
    }
    const changed = await updateCloudMission(currentCard.mission_id, action, body, options);
    const card = missionCard(changed, currentCard, options.now ? options.now() : Date.now());
    outputCard(card, asJson, options.log || console.log);
    return 0;
  } catch (caught) {
    const verb = action === 'approve' ? 'approve that step' : action === 'answer' ? 'send that answer' : 'stop that mission';
    return reportError(caught, verb, asJson, options);
  }
}

async function approveCommand(args, options = {}) {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    (options.log || console.log)('Usage: atris approve [--json]');
    return 0;
  }
  return changeCurrentMission('approve', {}, args, options);
}

async function stopCommand(args, options = {}) {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    (options.log || console.log)('Usage: atris stop [--json]');
    return 0;
  }
  return changeCurrentMission('stop', {}, args, options);
}

async function answerCommand(args, options = {}) {
  const text = args.filter((value) => value !== '--json').join(' ').trim();
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    (options.log || console.log)('Usage: atris mission answer "your answer" [--json]');
    return 0;
  }
  if (!text) {
    return reportError(
      new HumanCommandError('Atris needs your answer.', 'Try: atris mission answer "yes, go ahead"', 2),
      'send that answer',
      args.includes('--json'),
      options,
    );
  }
  return changeCurrentMission('answer', { answer: text }, args, options);
}

function checkPayload(payload, runId) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const checks = source.checks || source.check_results || source.result && source.result.checks || [];
  const rows = Array.isArray(checks) ? checks : [];
  const passed = typeof source.passed === 'boolean'
    ? source.passed
    : typeof source.ok === 'boolean'
      ? source.ok
      : rows.length > 0 && rows.every((check) => check && (
        check.passed === true
        || ['passed', 'pass', 'ok', 'done'].includes(String(check.status || check.state || '').toLowerCase())
      ));
  return {
    mission_id: String(source.mission_id || source.task_id || source.run_id || runId),
    passed,
    checks: rows,
  };
}

function checkLine(check, index) {
  if (typeof check === 'string') return `- ${check}`;
  const name = String(check && (check.name || check.title || check.check) || `Check ${index + 1}`);
  if (check && typeof check.passed === 'boolean') {
    return `- ${name}: ${check.passed ? 'passed' : 'failed'}`;
  }
  const state = String(check && (check.status || check.state) || 'unknown').toLowerCase();
  const word = ['passed', 'pass', 'ok', 'done'].includes(state) ? 'passed' : state;
  return `- ${name}: ${word}`;
}

async function checkCommand(args, options = {}) {
  const asJson = args.includes('--json');
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    (options.log || console.log)('Usage: atris check <run-id> [--json]');
    return 0;
  }
  const positionals = args.filter((value) => !String(value).startsWith('--'));
  const runId = String(positionals[0] || '').trim();
  if (!runId) {
    return reportError(
      new HumanCommandError('Atris needs the mission id to check.', 'Try: atris check <run-id> --json', 2),
      'show those checks',
      asJson,
      options,
    );
  }
  try {
    credentialsOrThrow(options);
    const result = checkPayload(await fetchCloudMissionChecks(runId, options), runId);
    const log = options.log || console.log;
    if (asJson) {
      log(JSON.stringify(result, null, 2));
    } else {
      log(`Checks for ${result.mission_id}`);
      log(result.passed ? 'Passed: yes' : 'Passed: no');
      if (result.checks.length === 0) log('No check results are ready yet.');
      result.checks.forEach((check, index) => log(checkLine(check, index)));
    }
    return result.passed ? 0 : 1;
  } catch (caught) {
    return reportError(caught, 'show those checks', asJson, options);
  }
}

function cliVersion() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

function routeWasReached(response, expectedMissingText) {
  if (!response) return false;
  if (response.ok) return true;
  if (response.status !== 404) return false;
  const detail = String(response.error || response.data && response.data.detail || '').trim();
  return detail.toLowerCase().includes(expectedMissingText);
}

async function safeProbe(request, pathname, options) {
  try {
    return await request(pathname, options);
  } catch {
    return null;
  }
}

async function readyCommand(args, options = {}) {
  const asJson = args.includes('--json');
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    (options.log || console.log)('Usage: atris ready --json');
    return 0;
  }
  const request = options.apiRequestJson || apiRequestJson;
  const load = options.loadCredentials || loadCredentials;
  const credentials = load() || {};
  const token = String(credentials.token || '').trim();
  const [health, atrisHealth, missionProbe, checkProbe] = await Promise.all([
    safeProbe(request, '/health', { method: 'GET' }),
    safeProbe(request, '/atris2/health', { method: 'GET' }),
    token
      ? safeProbe(request, '/atris2/missions/atris-ready-probe', { method: 'GET', token })
      : Promise.resolve(null),
    token
      ? safeProbe(request, '/mission-control/missions/atris-ready-probe', { method: 'GET', token })
      : Promise.resolve(null),
  ]);
  const version = cliVersion();
  const computerVersion = health && health.ok && health.data && health.data.version
    ? String(health.data.version)
    : null;
  const atrisReady = Boolean(atrisHealth && atrisHealth.ok && atrisHealth.data && atrisHealth.data.ready !== false);
  const canRunMissions = Boolean(token && atrisReady && routeWasReached(missionProbe, 'mission not found'));
  const canCheckWork = Boolean(token && atrisReady && routeWasReached(checkProbe, 'mission not found'));
  const canMakeProof = fs.existsSync(path.join(__dirname, 'proof.js')) && knownCommands.includes('proof');
  const payload = {
    ready: Boolean(version && computerVersion && canRunMissions && canCheckWork && canMakeProof),
    cli_version: version,
    computer_version: computerVersion,
    can_run_missions: canRunMissions,
    can_check_work: canCheckWork,
    can_make_proof: canMakeProof,
  };
  const log = options.log || console.log;
  if (asJson) log(JSON.stringify(payload, null, 2));
  else {
    log(payload.ready ? 'Atris is ready.' : 'Atris is not fully ready yet.');
    log(`Run missions: ${payload.can_run_missions ? 'yes' : 'no'}`);
    log(`Check work: ${payload.can_check_work ? 'yes' : 'no'}`);
    log(`Make proof: ${payload.can_make_proof ? 'yes' : 'no'}`);
  }
  return payload.ready ? 0 : 1;
}

module.exports = {
  HUMAN_STATES,
  stableMissionKey,
  missionCard,
  renderMissionCard,
  askCommand,
  currentMissionCommand,
  approveCommand,
  stopCommand,
  answerCommand,
  checkCommand,
  readyCommand,
};
