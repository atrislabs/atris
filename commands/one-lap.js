'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { freezeMissionVerifier, listMissions, markMissionReviewReady } = require('./mission');
const { readWishes } = require('../lib/wish-store');
const {
  engineRegistryView,
  resolveEngineForRole,
  resolveRegisteredEngine,
} = require('../lib/engine-registry');
const { parseVerifyCommand } = require('../lib/auto-accept-certified');
const fleet = require('../lib/fleet');

const TERMINAL_MISSION_STATUSES = new Set(['complete', 'stopped']);
const WAITING_WISH_STATUSES = new Set(['needs_input', 'waiting_input', 'waiting_on_operator']);
const OUTBOUND_ACTION = /^(?:(?:please|kindly|execute|go|run)\s+)*(?:(?:git\s+)?push(?:ing)?|deploy(?:ing|ment)?|(?:a\s+)?(?:production|prod)\s+deploy(?:ing|ment)?|(?:npm\s+)?publish(?:ing)?|send(?:ing)?|email(?:ing)?|notify(?:ing)?|messag(?:e|ing)|charge|refund|purchase|rotate|revoke|drop|truncate|upload|share|transfer|pay|book|schedule|invite|delete|release|land|ship|curl|wget|ssh)\b|^merg(?:e|ing)\b(?!\s+sort\b)|^post\b.{0,120}\b(?:to|on)\s+(?:x|twitter|linkedin|facebook|slack|discord|the\s+customer|a\s+customer|customers?|external)\b/i;
const COMPOUND_ACTION_BOUNDARY = /\s*(?:[;,:.!?&+\/]|\b(?:and(?:\s+then)?|then|also|plus|before|after|afterwards|while|meanwhile|followed(?:\s+|-)by)\b)\s*/i;
const OUTBOUND_TARGET_ACTION = /\b(?:push|merge|deploy|publish|release|land|ship)\b.{0,120}\b(?:to|into|on)\s+(?:origin\/)?(?:production|prod|master|main)\b|\b(?:post|send|email|upload|share|transfer)\b.{0,120}\b(?:to|with)\s+(?:x|twitter|linkedin|facebook|slack|discord|customers?|external\b)/i;
const LOCAL_INTENT = /^(add|analyze|audit|build|change|check|clean|create|debug|diagnose|document|edit|ensure|find|fix|harden|implement|improve|inspect|investigate|locate|make|merge\s+sort|optimize|order\s+validation|patch|post\s+(?:\/|api\b|endpoint\b|handler\b|route\b|request\b)|reduce|refactor|remove|rename|research|review|run\s+(the\s+)?(tests?|checks?|lint|build)|simplify|test|trace|update|validate|work\s+on|write)\b/i;
const ONE_LAP_LOCK_STALE_MS = 6 * 60 * 60 * 1000;

function ownCli(root, args, cwd = root) {
  const bin = path.resolve(__dirname, '..', 'bin', 'atris.js');
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    env: process.env,
    encoding: 'utf8',
    timeout: 20 * 60 * 1000,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error || null,
  };
}

function parseJsonOutput(result) {
  try {
    return JSON.parse(String(result && result.stdout || '').trim());
  } catch {
    return null;
  }
}

function normalizedAsk(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function shellQuote(value) {
  const text = String(value || '');
  if (/^[A-Za-z0-9_./:@+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function oneLapRetryCommand(ask, options = {}) {
  const parts = ['atris', shellQuote(ask)];
  if (options.engine) parts.push('--engine', shellQuote(options.engine));
  if (options.verifier) parts.push('--verify', shellQuote(options.verifier));
  parts.push('--json');
  return parts.join(' ');
}

function wishAnswerCommand(wish) {
  const ref = wish && (wish.id || (wish.n ? `#${wish.n}` : ''));
  return ref
    ? `atris wish answer ${shellQuote(ref)} ${shellQuote('<answer>')}`
    : `atris wish answer ${shellQuote('<answer>')}`;
}

function askLockFile(root, ask) {
  const key = crypto.createHash('sha256').update(normalizedAsk(ask)).digest('hex').slice(0, 32);
  return path.join(root, '.atris', 'state', 'one-lap-locks', `${key}.lock`);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function readAskLock(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function acquireAskLock(root, ask) {
  const file = askLockFile(root, ask);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = crypto.randomBytes(16).toString('hex');
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, token, ask: normalizedAsk(ask), started_at: new Date().toISOString() })}\n`);
      } finally {
        fs.closeSync(fd);
      }
      return { ok: true, file, token };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      const holder = readAskLock(file);
      let ageMs = 0;
      try { ageMs = Date.now() - fs.statSync(file).mtimeMs; } catch {}
      if ((holder && processIsAlive(Number(holder.pid))) || (!holder && ageMs < ONE_LAP_LOCK_STALE_MS)) {
        return { ok: false, file, holder };
      }
      try { fs.unlinkSync(file); } catch (unlinkError) {
        if (!unlinkError || unlinkError.code !== 'ENOENT') return { ok: false, file, holder };
      }
    }
  }
  return { ok: false, file, holder: readAskLock(file) };
}

function releaseAskLock(lock) {
  if (!lock || !lock.ok) return;
  const current = readAskLock(lock.file);
  if (!current || current.token !== lock.token) return;
  try { fs.unlinkSync(lock.file); } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
}

function newestFirst(rows) {
  return [...rows].sort((a, b) => String(b.updated_at || b.ts || b.first_ts || '')
    .localeCompare(String(a.updated_at || a.ts || a.first_ts || '')));
}

function activeWishForAsk(root, ask) {
  const missions = new Map(listMissions(root).map((mission) => [mission.id, mission]));
  const matches = newestFirst(readWishes(root).filter((wish) => normalizedAsk(wish.text) === normalizedAsk(ask)));
  for (const wish of matches) {
    if (WAITING_WISH_STATUSES.has(String(wish.status || ''))) return { wish, mission: null };
    const mission = missions.get(wish.mission_id);
    if (mission && !TERMINAL_MISSION_STATUSES.has(String(mission.status || ''))) return { wish, mission };
  }
  return null;
}

function readyExecutor(root, preferred = '') {
  if (preferred) {
    const selected = resolveRegisteredEngine(preferred, root);
    if (!selected.roles.includes('executor')) throw new Error(`engine ${selected.id} is not an executor`);
    if (!selected.health || selected.health.status !== 'ready') throw new Error(`engine ${selected.id} is not ready`);
    if (!fleet.FLEET_CAPABLE.includes(selected.id)) throw new Error(`engine ${selected.id} cannot build headlessly`);
    return selected;
  }
  const routed = resolveEngineForRole('executor', root);
  if (routed && fleet.FLEET_CAPABLE.includes(routed.id)) return routed;
  return engineRegistryView(root)
    .filter((engine) => engine.roles.includes('executor'))
    .filter((engine) => engine.health && engine.health.status === 'ready')
    .filter((engine) => fleet.FLEET_CAPABLE.includes(engine.id))
    .sort((a, b) => Number(a.fallback_order) - Number(b.fallback_order))[0] || null;
}

function readyValidators(root, preferred = '', exclude = '') {
  const blocked = String(exclude || '').trim();
  return engineRegistryView(root)
    .filter((engine) => engine.roles.includes('validator'))
    .filter((engine) => engine.health && engine.health.status === 'ready')
    .filter((engine) => engine.id !== blocked)
    .sort((a, b) => {
      const aPreferred = preferred && a.id === preferred ? 0 : 1;
      const bPreferred = preferred && b.id === preferred ? 0 : 1;
      return aPreferred - bPreferred
        || Number(a.fallback_order) - Number(b.fallback_order)
        || String(a.id).localeCompare(String(b.id));
    });
}

function taskById(runCli, taskId) {
  const result = runCli(['task', 'show', taskId, '--json']);
  if (!result || result.status !== 0) return null;
  return parseJsonOutput(result);
}

function missionVerifier(mission) {
  return String(mission && (mission.effective_verifier || mission.verifier) || '').trim();
}

function requestAction(title) {
  return String(title || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:(?:please|kindly)\s+|(?:can|could|would|will)\s+you\s+(?:please\s+)?|i\s+(?:need|want)\s+you\s+to\s+|help\s+me(?:\s+to)?\s+)+/i, '')
    .trim();
}

function includesOutboundAction(title) {
  const text = String(title || '').replace(/\s+/g, ' ').trim();
  if (OUTBOUND_TARGET_ACTION.test(text)) return true;
  return text.split(COMPOUND_ACTION_BOUNDARY)
    .map(requestAction)
    .filter(Boolean)
    .some((clause) => OUTBOUND_ACTION.test(clause));
}

function oneLapSafetyIssue(task) {
  if (!fleet.isSafeLane(task)) return 'the task is in a protected lane';
  const title = String(task && task.title || '').replace(/\s+/g, ' ').trim();
  const action = requestAction(title);
  if (includesOutboundAction(title)) {
    return 'the request includes an outbound or irreversible action';
  }
  if (!LOCAL_INTENT.test(action)) return 'one lap only dispatches local build, test, review, or research work';
  return '';
}

function directoryHasTests(root, dirName) {
  const start = path.join(root, dirName);
  if (!fs.existsSync(start)) return false;
  const pending = [{ dir: start, depth: 0 }];
  while (pending.length) {
    const { dir, depth } = pending.shift();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isFile() && /(?:^|[._-])(test|spec)\.(?:c|m)?js$/i.test(entry.name)) return true;
      if (entry.isDirectory() && depth < 2 && !entry.name.startsWith('.')) {
        pending.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      }
    }
  }
  return false;
}

function projectVerifier(root) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const scripts = pkg && pkg.scripts || {};
    const testScript = String(scripts.test || '').trim();
    if (testScript && !/no test specified|exit 1/i.test(testScript)) return 'npm test';
    for (const name of ['test:fast', 'test:unit', 'check']) {
      if (String(scripts[name] || '').trim()) return `npm run ${name}`;
    }
  } catch {}
  if (directoryHasTests(root, 'test') || directoryHasTests(root, 'tests')) return 'node --test';
  if (fs.existsSync(path.join(root, 'tsconfig.json'))) return 'tsc';
  if (fs.existsSync(path.join(root, 'pyproject.toml')) || fs.existsSync(path.join(root, 'pytest.ini'))) {
    return 'python -m pytest';
  }
  return '';
}

function relativeReceipt(root, receipt) {
  return receipt ? path.relative(root, receipt) : '';
}

function passingReadyProof(candidate, { taskId, wishId, missionId, verifier }) {
  if (!candidate || !candidate.receipt || !candidate.ready) return false;
  const { receipt, ready } = candidate;
  const context = receipt.context || {};
  const readyVerifier = ready.verifier_result || {};
  const resultVerifier = receipt.result && receipt.result.verifier_result || {};
  const validator = receipt.result && receipt.result.validator_result || {};
  return receipt.schema === 'atris.dispatch_receipt.v1'
    && receipt.review_only === true
    && context.source === 'one_lap'
    && Array.isArray(receipt.tasks)
    && receipt.tasks.includes(taskId)
    && receipt.result
    && receipt.result.passed === true
    && receipt.result.master_boundary_enforced === true
    && receipt.result.master_unchanged === true
    && ready.task === taskId
    && ready.review_recorded === true
    && readyVerifier.passed === true
    && readyVerifier.status === 0
    && readyVerifier.command === verifier
    && resultVerifier.passed === true
    && resultVerifier.status === 0
    && resultVerifier.command === verifier
    && validator.passed === true
    && validator.independent === true
    && validator.worktree_unchanged === true
    && Boolean(validator.engine)
    && Boolean(validator.executor_engine)
    && validator.engine !== validator.executor_engine
    && validator.executor_engine === ready.engine
    && (!wishId || context.wish_id === wishId)
    && (!missionId || context.mission_id === missionId);
}

function findDispatchReceipt(root, taskId, proof = null) {
  const dir = path.join(root, 'atris', 'runs');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((name) => /^dispatch-.+\.json$/.test(name)).sort().reverse();
  } catch {
    return null;
  }
  for (const name of files) {
    try {
      const receipt = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (Array.isArray(receipt.tasks) && receipt.tasks.includes(taskId)) {
        const candidate = {
          path: path.join('atris', 'runs', name),
          receipt,
          ready: Array.isArray(receipt.ready) ? receipt.ready.find((row) => row.task === taskId) || null : null,
        };
        if (!proof || passingReadyProof(candidate, { ...proof, taskId })) return candidate;
      }
    } catch {}
  }
  return null;
}

function resultBase({ status, ask, wish, mission, task, engine, validator, verifier }) {
  return {
    schema: 'atris.one_lap.v1',
    ok: status === 'done' || status === 'waiting_input',
    status,
    ask,
    wish_id: wish && wish.id || null,
    task_id: task && task.display_id || wish && wish.task_id || null,
    mission_id: mission && mission.id || wish && wish.mission_id || null,
    engine: engine && engine.id || wish && wish.engine || null,
    validator: validator && validator.id || wish && wish.validator || null,
    verifier: verifier || null,
  };
}

function renderText(result) {
  const status = result.status === 'waiting_input'
    ? 'waiting on you'
    : String(result.status || 'stuck').replace(/_/g, ' ');
  console.log(`lap: ${status}`);
  if (result.question) console.log(`question: ${result.question}`);
  if (result.changed) console.log(`changed: ${result.changed}`);
  if (result.reason) console.log(`why it matters: ${result.reason}`);
  if (result.checked) console.log(`how i checked: ${result.checked}`);
  if (result.tested) console.log(`what i tested: ${result.tested}`);
  if (result.receipt) console.log(`proof: ${result.receipt}`);
  if (result.next_action) console.log(`next: ${result.next_action}`);
}

function emit(result, asJson) {
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else renderText(result);
}

function waitingResult({ ask, wish, mission = null, task = null, question = '', nextAction = '' }) {
  return {
    ...resultBase({ status: 'waiting_input', ask, wish, mission, task }),
    question: question || 'the existing lap needs operator input before it can continue',
    next_action: nextAction || (wish && wish.id ? `atris wish show ${shellQuote(wish.id)}` : 'atris wish list'),
  };
}

async function runOneLap(ask, options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const asJson = options.asJson === true;
  const runCli = options.ownCli || ((args, cwd = root) => ownCli(root, args, cwd));
  const progress = options.progress || ((line) => process.stderr.write(`${line}\n`));
  const text = String(ask || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    const result = { schema: 'atris.one_lap.v1', ok: false, status: 'stuck', reason: 'a request is required', next_action: 'atris "<request>"' };
    emit(result, asJson);
    return 2;
  }

  const lapLock = acquireAskLock(root, text);
  if (!lapLock.ok) {
    const running = activeWishForAsk(root, text);
    const runningWish = running && running.wish || null;
    const runningMission = running && running.mission || null;
    const runningTask = runningWish && runningWish.task_id ? taskById(runCli, runningWish.task_id) : null;
    const waitingForAnswer = runningWish && WAITING_WISH_STATUSES.has(String(runningWish.status || ''));
    const result = waitingResult({
      ask: text,
      wish: runningWish,
      mission: runningMission,
      task: runningTask,
      question: waitingForAnswer
        ? (Array.isArray(runningWish.questions) ? runningWish.questions[0] : '')
        : 'an identical lap is already running',
      nextAction: waitingForAnswer
        ? wishAnswerCommand(runningWish)
        : oneLapRetryCommand(text, options),
    });
    result.resumed = true;
    emit(result, asJson);
    return 0;
  }

  try {
  const existing = activeWishForAsk(root, text);
  if (existing && WAITING_WISH_STATUSES.has(String(existing.wish.status || ''))) {
    const result = waitingResult({
      ask: text,
      wish: existing.wish,
      question: Array.isArray(existing.wish.questions) ? existing.wish.questions[0] : '',
      nextAction: wishAnswerCommand(existing.wish),
    });
    result.resumed = true;
    emit(result, asJson);
    return 0;
  }

  let wish = existing && existing.wish;
  let mission = existing && existing.mission;
  let task = wish && wish.task_id ? taskById(runCli, wish.task_id) : null;
  const retryVerifier = String(options.verifier || '').trim();
  const existingVerifier = missionVerifier(mission);
  if (existingVerifier && retryVerifier && retryVerifier !== existingVerifier) {
    const result = {
      ...resultBase({ status: 'stuck', ask: text, wish, mission, task, verifier: existingVerifier }),
      resumed: true,
      reason: 'the lap verifier is frozen after intake and cannot be replaced on retry',
      next_action: oneLapRetryCommand(text, { engine: options.engine || '', verifier: existingVerifier }),
    };
    emit(result, asJson);
    return 2;
  }
  if (task && ['review', 'done'].includes(String(task.status || ''))) {
    const verifier = missionVerifier(mission);
    const prior = verifier ? findDispatchReceipt(root, task.display_id, {
      wishId: wish.id,
      missionId: mission && mission.id,
      verifier,
    }) : null;
    if (!prior) {
      const result = {
        ...resultBase({ status: 'stuck', ask: text, wish, mission, task, verifier }),
        resumed: true,
        reason: 'the matching task is in Review without a passing matching one-lap receipt',
        next_action: `atris task show ${shellQuote(task.display_id)}`,
      };
      emit(result, asJson);
      return 1;
    }
    const result = {
      ...resultBase({
        status: 'done',
        ask: text,
        wish,
        mission,
        task,
        engine: prior && prior.ready && prior.ready.engine
          ? { id: prior.ready.engine }
          : (wish && wish.engine ? { id: wish.engine } : null),
        verifier,
      }),
      resumed: true,
      changed: task.title,
      reason: 'the matching lap is already proof ready',
      checked: `${verifier} passed`,
      tested: 'the linked task is in Review',
      receipt: prior && prior.path || '',
      worktree: prior && prior.ready && prior.ready.worktree || null,
      next_action: prior.ready.next_action || `atris task show ${shellQuote(task.display_id)}`,
      mission_status: mission && mission.status || null,
      approval_status: task.status === 'review' ? 'pending' : null,
      master_changed: false,
      ...(prior && prior.receipt && prior.receipt.result ? { result: prior.receipt.result } : {}),
    };
    emit(result, asJson);
    return 0;
  }
  if (task && String(task.status || '') === 'claimed') {
    const actor = String(mission && mission.owner || 'mission-lead').trim() || 'mission-lead';
    if (String(task.claimed_by || '').toLowerCase() !== actor.toLowerCase()) {
      const result = waitingResult({
        ask: text,
        wish,
        mission,
        task,
        question: `the matching task is already held by ${task.claimed_by || 'another worker'}`,
        nextAction: `atris task show ${shellQuote(task.display_id)}`,
      });
      result.resumed = true;
      emit(result, asJson);
      return 0;
    }
    const released = runCli(['task', 'release', task.display_id, '--as', actor, '--json']);
    if (!released || released.status !== 0) {
      const detail = String(released && (released.stderr || released.stdout) || 'claim release failed').trim().slice(-300);
      const result = {
        ...resultBase({ status: 'stuck', ask: text, wish, mission, task }),
        resumed: true,
        reason: `the abandoned one-lap claim could not be released: ${detail}`,
        next_action: `atris task show ${shellQuote(task.display_id)}`,
      };
      emit(result, asJson);
      return 1;
    }
    task = taskById(runCli, task.display_id);
  }
  if (!wish) {
    const intakeSafetyIssue = oneLapSafetyIssue({ title: text, tag: 'wish' });
    if (intakeSafetyIssue) {
      const result = { ...resultBase({ status: 'stuck', ask: text }), reason: intakeSafetyIssue, next_action: 'use a protected workflow with explicit approval' };
      emit(result, asJson);
      return 2;
    }
  }

  let executor;
  try {
    executor = readyExecutor(root, options.engine || '');
  } catch (error) {
    const result = { ...resultBase({ status: 'stuck', ask: text }), reason: error.message, next_action: 'atris engine' };
    emit(result, asJson);
    return 2;
  }
  if (!executor) {
    const result = { ...resultBase({ status: 'stuck', ask: text }), reason: 'no ready executor engine is installed', next_action: 'atris engine' };
    emit(result, asJson);
    return 2;
  }

  if (!wish) {
    const intakeVerifier = String(options.verifier || '').trim() || projectVerifier(root);
    if (intakeVerifier) {
      const parsedIntakeVerifier = parseVerifyCommand(intakeVerifier);
      if (!parsedIntakeVerifier.ok) {
        const result = { ...resultBase({ status: 'stuck', ask: text, engine: executor, verifier: intakeVerifier }), reason: `the verifier is not safe to run (${parsedIntakeVerifier.reason})`, next_action: 'choose a local test command' };
        emit(result, asJson);
        return 2;
      }
    }
    progress('lap: navigator is scoping the request');
    const captured = runCli([
      'wish', text,
      '--engine', executor.id,
      ...(intakeVerifier ? ['--verify', intakeVerifier] : []),
      '--one-lap',
      '--json',
    ]);
    const payload = parseJsonOutput(captured);
    if (!payload) {
      const detail = String(captured && (captured.stderr || captured.stdout) || 'wish intake failed').trim().slice(-500);
      const result = { ...resultBase({ status: 'stuck', ask: text, engine: executor }), reason: detail, next_action: oneLapRetryCommand(text, { engine: executor.id, verifier: intakeVerifier }) };
      emit(result, asJson);
      return captured && captured.status === 2 ? 2 : 1;
    }
    const durableWish = readWishes(root).find((row) => row.id === payload.wish_id);
    wish = durableWish || { id: payload.wish_id, task_id: payload.task_id, mission_id: payload.mission_id, engine: payload.engine, validator: payload.validator, questions: payload.questions, status: payload.status, text };
    if (payload.status === 'needs_input') {
      const result = waitingResult({
        ask: text,
        wish,
        question: Array.isArray(payload.questions) ? payload.questions[0] : '',
        nextAction: wishAnswerCommand(wish),
      });
      emit(result, asJson);
      return 0;
    }
    if (payload.status !== 'delegated' || !payload.task_id || !payload.mission_id) {
      const result = { ...resultBase({ status: 'stuck', ask: text, wish, engine: executor }), reason: 'wish intake did not produce one scoped task and mission', next_action: `atris wish show ${payload.wish_id}` };
      emit(result, asJson);
      return 2;
    }
    mission = listMissions(root).find((row) => row.id === payload.mission_id) || null;
    task = taskById(runCli, payload.task_id);
  }

  if (!mission || !task) {
    const result = { ...resultBase({ status: 'stuck', ask: text, wish, mission, task, engine: executor }), reason: 'the scoped task or mission could not be loaded', next_action: wish && wish.id ? `atris wish show ${wish.id}` : 'atris wish list' };
    emit(result, asJson);
    return 1;
  }
  const safetyIssue = oneLapSafetyIssue(task);
  if (safetyIssue) {
    const result = { ...resultBase({ status: 'stuck', ask: text, wish, mission, task, engine: executor }), reason: safetyIssue, next_action: `atris task show ${task.display_id}` };
    emit(result, asJson);
    return 2;
  }
  let frozenVerifier = missionVerifier(mission);
  const requestedVerifier = String(options.verifier || '').trim();
  if (frozenVerifier && requestedVerifier && requestedVerifier !== frozenVerifier) {
    const result = {
      ...resultBase({ status: 'stuck', ask: text, wish, mission, task, engine: executor, verifier: frozenVerifier }),
      reason: 'the lap verifier is frozen after intake and cannot be replaced on retry',
      next_action: oneLapRetryCommand(text, { engine: options.engine || '', verifier: frozenVerifier }),
    };
    emit(result, asJson);
    return 2;
  }
  const verifier = frozenVerifier || requestedVerifier || projectVerifier(root);
  if (!verifier) {
    const result = waitingResult({
      ask: text,
      wish,
      mission,
      task,
      question: 'what exact command proves this request works?',
      nextAction: oneLapRetryCommand(text, { engine: options.engine || '', verifier: '<command>' }),
    });
    result.engine = executor.id;
    emit(result, asJson);
    return 0;
  }
  const parsedVerifier = parseVerifyCommand(verifier);
  if (!parsedVerifier.ok) {
    const result = { ...resultBase({ status: 'stuck', ask: text, wish, mission, task, engine: executor, verifier }), reason: `the mission has no safe runnable verifier (${parsedVerifier.reason})`, next_action: `atris mission status ${mission.id}` };
    emit(result, asJson);
    return 2;
  }
  if (!frozenVerifier) {
    try {
      mission = freezeMissionVerifier(mission.id, verifier, root);
      frozenVerifier = missionVerifier(mission);
    } catch (error) {
      const result = {
        ...resultBase({ status: 'stuck', ask: text, wish, mission, task, engine: executor, verifier }),
        reason: `the verifier could not be frozen before dispatch: ${error.message}`,
        next_action: `atris mission status ${mission.id}`,
      };
      emit(result, asJson);
      return 1;
    }
  }

  const validators = readyValidators(root, wish && wish.validator || '', executor.id);
  if (!validators.length) {
    const result = {
      ...resultBase({ status: 'stuck', ask: text, wish, mission, task, engine: executor, verifier }),
      reason: 'no distinct ready validator engine is installed',
      next_action: 'atris engine',
    };
    emit(result, asJson);
    return 2;
  }

  progress(`lap: ${executor.id} is building ${task.display_id} in isolation`);
  let flight;
  try {
    flight = await fleet.runDispatchFlight({
      root,
      taskIds: [task.display_id],
      engine: executor.id,
      reviewOnly: true,
      verifierCommand: verifier,
      validatorEngines: validators.map((entry) => entry.id),
      actor: mission.owner || 'mission-lead',
      installedEngines: engineRegistryView(root)
        .filter((entry) => entry.health && entry.health.status === 'ready')
        .filter((entry) => fleet.FLEET_CAPABLE.includes(entry.id))
        .map((entry) => entry.id),
      ownCli: runCli,
      log: (line) => {
        const clean = String(line || '')
          .replace(/[—–]/g, '-')
          .replace(/[✓✔]/g, 'passed')
          .replace(/[✗✖]/g, 'failed')
          .replace(/[⏸·→]/g, '-')
          .trim();
        if (clean) progress(`lap: ${clean.replace(/^[^a-z0-9]+/i, '')}`);
      },
      receiptContext: {
        source: 'one_lap',
        ask: text,
        wish_id: wish.id,
        mission_id: mission.id,
        validator: wish.validator || null,
        mission_room_receipt_path: mission.mission_room_receipt_path || mission.metadata && mission.metadata.mission_room_receipt_path || null,
      },
    });
  } catch (error) {
    const result = { ...resultBase({ status: 'stuck', ask: text, wish, mission, task, engine: executor, verifier }), reason: error.message || String(error), next_action: `atris task show ${task.display_id}` };
    emit(result, asJson);
    return 1;
  }

  const ready = flight.ready && flight.ready[0];
  const receipt = relativeReceipt(root, flight.receipt);
  if (!flight.result || flight.result.passed !== true || !ready) {
    const paused = flight.paused && flight.paused[0] || {};
    const actualEngine = paused.engine ? { id: paused.engine } : executor;
    const validation = paused.validator_result || flight.result && flight.result.validator_result || null;
    const verifierPassed = paused.verifier_result && paused.verifier_result.passed === true;
    const result = {
      ...resultBase({
        status: 'stuck',
        ask: text,
        wish,
        mission,
        task,
        engine: actualEngine,
        validator: validation && validation.engine ? { id: validation.engine } : null,
        verifier,
      }),
      reason: paused.detail || `the lap paused at ${paused.stage || 'verification'}`,
      checked: paused.verifier_result
        ? `${verifier} ${verifierPassed ? 'passed' : 'failed'} (exit ${paused.verifier_result.status})`
        : '',
      tested: 'the isolated change did not clear every proof gate',
      receipt,
      worktree: paused.worktree || null,
      next_action: paused.worktree ? `cd ${shellQuote(paused.worktree)} && atris worktree guard` : `atris task show ${shellQuote(task.display_id)}`,
    };
    emit(result, asJson);
    return 1;
  }

  try {
    mission = markMissionReviewReady(mission.id, {
      verifier,
      receiptPath: flight.receipt,
      taskId: task.display_id,
      worktree: ready.worktree,
      nextAction: ready.next_action,
    }, root);
  } catch (error) {
    const result = {
      ...resultBase({ status: 'stuck', ask: text, wish, mission, task, engine: { id: ready.engine }, verifier }),
      reason: `proof passed, but mission state could not move to Review: ${error.message}`,
      checked: `${verifier} passed (exit 0)`,
      receipt,
      worktree: ready.worktree,
      next_action: `atris mission status ${mission.id}`,
    };
    emit(result, asJson);
    return 1;
  }

  task = { ...task, status: 'review' };
  const verifyOutput = String(ready.verifier_result && ready.verifier_result.output || '').trim().replace(/\s+/g, ' ').slice(-300);
  const result = {
    ...resultBase({
      status: 'done',
      ask: text,
      wish,
      mission,
      task,
      engine: { id: ready.engine },
      validator: ready.validator_result && ready.validator_result.engine ? { id: ready.validator_result.engine } : null,
      verifier,
    }),
    changed: task.title,
    reason: 'the requested change is built and proof ready without changing master',
    checked: `${verifier} passed (exit 0)`,
    tested: verifyOutput || 'the verifier completed with no output',
    receipt,
    worktree: ready.worktree,
    next_action: ready.next_action,
    mission_status: mission.status,
    approval_status: 'pending',
    master_changed: false,
    result: flight.result,
  };
  emit(result, asJson);
  return 0;
  } finally {
    releaseAskLock(lapLock);
  }
}

module.exports = {
  OUTBOUND_ACTION,
  activeWishForAsk,
  normalizedAsk,
  oneLapSafetyIssue,
  projectVerifier,
  readyExecutor,
  readyValidators,
  runOneLap,
};
