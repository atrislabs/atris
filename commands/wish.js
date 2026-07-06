'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getLogPath, ensureLogDirectory, createLogFile, addInboxIdea } = require('../lib/file-ops');
const engineRegistry = require('../lib/engine-registry');
const { delegateTask } = require('./task');
const { startMission, listMissions } = require('./mission');

const VERBS = new Set([
  'add',
  'audit',
  'build',
  'change',
  'check',
  'clean',
  'create',
  'debug',
  'delegate',
  'deploy',
  'design',
  'draft',
  'explain',
  'find',
  'fix',
  'improve',
  'make',
  'migrate',
  'move',
  'open',
  'plan',
  'polish',
  'refactor',
  'remove',
  'rename',
  'research',
  'review',
  'run',
  'set',
  'setup',
  'ship',
  'start',
  'stop',
  'test',
  'update',
  'verify',
  'write',
  'understand',
]);

const PROPER_SKIP = new Set([
  'A',
  'An',
  'And',
  'At',
  'But',
  'For',
  'I',
  'In',
  'Make',
  'On',
  'Or',
  'Please',
  'The',
  'This',
  'To',
  'With',
]);

const BUDGET_LABELS = {
  quick: 'about fifteen minutes',
  long: 'about an hour',
  deep: 'about three hours',
};

const TEST_VERIFY_COMMAND = 'node --test';
const JOURNAL_RESULT_TEXT = 'a written result will be waiting in your journal';
const AUDIENCE_WORDS = /\b(?:for|user|users|customer|customers|operator|operators|agent|agents|developer|developers|admin|admins|member|members|team|teams|visitor|visitors|client|clients|student|students|founder|founders|newcomer|newcomers)\b/i;
const BUDGET_RANK = { quick: 1, long: 2, deep: 3 };
const PART_JOINER = /\s+(?:and|plus|also)\s+|[;]\s*/i;
const EXTERNAL_REF_WORDS = new Set(['repo', 'repository', 'project', 'workspace']);
const EXTERNAL_REF_STOP = new Set([
  'and',
  'also',
  'but',
  'for',
  'hard',
  'it',
  'may',
  'might',
  'or',
  'plus',
  'seem',
  'seems',
  'that',
  'though',
  'to',
  'when',
  'where',
  'which',
  'with',
]);
const SUBJECT_SKIP_WORDS = new Set([
  'can',
  'could',
  'done',
  'everything',
  'finish',
  'line',
  'maybe',
  'might',
  'need',
  'needs',
  'should',
  'take',
  'this',
  'us',
  'we',
  'will',
  'wish',
  'would',
]);
const FILLER_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'better',
  'by',
  'for',
  'from',
  'good',
  'great',
  'help',
  'improved',
  'into',
  'it',
  'its',
  'more',
  'nice',
  'of',
  'on',
  'or',
  'our',
  'please',
  'rough',
  'roughly',
  'the',
  'their',
  'this',
  'to',
  'want',
  'with',
]);

function showHelp() {
  console.log('');
  console.log('Usage: atris wish "<plain sentence>" [--json]');
  console.log('       atris wish list');
  console.log('       atris wish grant <n> "<answer>" [--json]');
  console.log('');
}

function hasFlag(args, name) {
  return args.includes(name);
}

function stripFlags(args) {
  return args.filter((arg) => !String(arg || '').startsWith('--'));
}

function stateFile(root = process.cwd()) {
  return path.join(root, '.atris', 'state', 'wishes.jsonl');
}

function stampIso() {
  return new Date().toISOString();
}

function todayName(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function slugify(value) {
  return String(value || 'wish')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36) || 'wish';
}

function wishId(text, ts = stampIso()) {
  const hash = crypto.createHash('sha1').update(`${text}:${ts}`).digest('hex').slice(0, 8);
  return `wish-${todayName(new Date(ts))}-${slugify(text)}-${hash}`;
}

function appendWishRecord(root, record) {
  const file = stateFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  return file;
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function readWishes(root = process.cwd()) {
  const byId = new Map();
  for (const event of readJsonLines(stateFile(root))) {
    if (!event || !event.id) continue;
    const current = byId.get(event.id) || {
      id: event.id,
      ts: event.ts,
      text: event.text || '',
      answers: [],
      first_ts: event.ts,
    };
    const next = {
      ...current,
      ...event,
      first_ts: current.first_ts || event.ts,
      answers: current.answers || [],
    };
    if (event.answer) next.answers = [...next.answers, String(event.answer)];
    if (Array.isArray(event.answers)) next.answers = [...next.answers, ...event.answers.map(String)];
    byId.set(event.id, next);
  }
  return Array.from(byId.values())
    .sort((a, b) => String(a.first_ts || a.ts || '').localeCompare(String(b.first_ts || b.ts || '')));
}

function captureWishToJournal(text, root = process.cwd()) {
  if (!fs.existsSync(path.join(root, 'atris'))) {
    fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  }
  ensureLogDirectory();
  const { logFile, dateFormatted } = getLogPath();
  if (!fs.existsSync(logFile)) createLogFile(logFile, dateFormatted);
  const inboxId = addInboxIdea(logFile, text);
  return { logFile, inbox_id: inboxId };
}

function wordList(text) {
  return String(text || '')
    .trim()
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);
}

function quoteText(text) {
  return JSON.stringify(String(text || ''));
}

function hasVerb(text) {
  return wordList(text).some((word) => {
    const clean = word.toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, '');
    return VERBS.has(clean) || /(?:ed|ing)$/.test(clean);
  });
}

function largerBudget(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return BUDGET_RANK[right] > BUDGET_RANK[left] ? right : left;
}

function speedBudgetSignal(text) {
  const compact = String(text || '').toLowerCase();
  const action = '(?:fix|patch|polish|tweak|change|update|edit|cleanup|clean|rename|remove|add|copy)';
  if (new RegExp(`\\b(?:quick|small|tiny)\\s+${action}\\b`).test(compact)) return 'quick';
  if (new RegExp(`\\b${action}\\b.{0,32}\\b(?:quick|quickly|small|tiny)\\b`).test(compact)) return 'quick';
  return null;
}

function deliverableBudgetSignal(text) {
  const compact = String(text || '').toLowerCase();
  if (/\b(big|full|overhaul|all|refactor|restructure|rewrite|architecture|system|suite|migration|migrate|e2e|end-to-end)\b/.test(compact)) {
    return 'deep';
  }
  if (/\b(test|tests|testing|coverage|command|commands|cli|subcommand|workflow|flow|integration|real results)\b/.test(compact)) {
    return 'long';
  }
  return null;
}

function inferBudgetTier(text) {
  let tier = null;
  tier = largerBudget(tier, speedBudgetSignal(text));
  tier = largerBudget(tier, deliverableBudgetSignal(text));
  return tier || 'long';
}

function resolveRole(role, root) {
  const resolver = engineRegistry.resolveRole || engineRegistry.resolve || engineRegistry.resolveEngineForRole;
  return resolver(role, root);
}

function cleanToken(value) {
  return String(value || '')
    .replace(/^[`'"]+|[`'",;:!?]+$/g, '')
    .trim();
}

function pathLike(value) {
  const text = cleanToken(value);
  return text.startsWith('./')
    || text.startsWith('../')
    || text.startsWith('/')
    || text.startsWith('~/')
    || text.includes('/')
    || /\.[A-Za-z0-9]{1,8}$/.test(text);
}

function fileExists(root, value) {
  const raw = cleanToken(value);
  if (!raw) return false;
  const expanded = raw.startsWith('~/') ? path.join(process.env.HOME || '', raw.slice(2)) : raw;
  const candidates = path.isAbsolute(expanded)
    ? [expanded]
    : [path.join(root, expanded), path.join(path.dirname(root), expanded)];
  return candidates.some((candidate) => fs.existsSync(candidate));
}

function namedThingExists(root, value) {
  const raw = cleanToken(value);
  if (!raw) return false;
  if (fileExists(root, raw)) return true;
  const slug = slugify(raw);
  const base = path.basename(root).toLowerCase();
  const parentBase = path.basename(path.dirname(root)).toLowerCase();
  if (slug && (base.includes(slug) || parentBase.includes(slug))) return true;
  const candidates = [
    path.join(root, raw),
    path.join(root, slug),
    path.join(path.dirname(root), raw),
    path.join(path.dirname(root), slug),
    path.join(root, 'atris', 'team', raw),
    path.join(root, 'atris', 'team', slug),
  ];
  return candidates.some((candidate) => fs.existsSync(candidate));
}

function subjectForWish(text) {
  const words = wordList(text)
    .map(cleanToken)
    .filter(Boolean);
  if (!words.length) return '';
  let usable = words;
  while (usable.length) {
    const clean = usable[0].toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (VERBS.has(clean) || FILLER_WORDS.has(clean) || SUBJECT_SKIP_WORDS.has(clean)) {
      usable = usable.slice(1);
      continue;
    }
    break;
  }
  const phrase = [];
  for (const word of usable) {
    const clean = word.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!clean) continue;
    if (['by', 'for', 'from', 'in', 'into', 'of', 'on', 'to', 'with'].includes(clean) && phrase.length) break;
    if (FILLER_WORDS.has(clean) || SUBJECT_SKIP_WORDS.has(clean)) continue;
    if (VERBS.has(clean)) continue;
    phrase.push(clean);
    if (phrase.length >= 4) break;
  }
  return phrase.join(' ');
}

function meaningfulWordSet(text) {
  const words = new Set();
  for (const raw of wordList(text)) {
    const clean = raw.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
    if (!clean || clean.length < 3) continue;
    if (VERBS.has(clean) || FILLER_WORDS.has(clean)) continue;
    words.add(clean.replace(/s$/, ''));
  }
  return words;
}

function sharesMeaningfulWords(left, right) {
  const leftWords = meaningfulWordSet(left);
  const rightWords = meaningfulWordSet(right);
  if (!leftWords.size || !rightWords.size) return false;
  for (const word of leftWords) {
    if (rightWords.has(word)) return true;
  }
  return false;
}

function clarityAudit(text) {
  const words = wordList(text);
  const subject = subjectForWish(text);
  const missing = [];
  const questions = [];
  const vague = words.length < 4 || !hasVerb(text);

  if (vague) {
    missing.push('outcome');
    questions.push(subject ? `What outcome should ${subject} create?` : 'What would done look like for this wish?');
  }
  if (vague && !AUDIENCE_WORDS.test(text)) {
    missing.push('audience');
    questions.push(subject ? `Who is ${subject} for?` : 'What should exist when it comes true?');
  }
  if (vague) {
    missing.push('scope');
    questions.push(subject ? `What part of ${subject} should I change first?` : 'What should I change first?');
  }

  return {
    vague,
    missing,
    questions,
  };
}

function missingNamedInputs(text, root) {
  const missing = [];
  const seen = new Set();
  const addMissing = (value, kind) => {
    const clean = cleanToken(value);
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    const exists = kind === 'path' ? fileExists(root, clean) : namedThingExists(root, clean);
    if (!exists) missing.push({ value: clean, kind });
  };

  const words = wordList(text);
  for (const word of words) {
    if (pathLike(word)) addMissing(word, 'path');
  }

  const keywordPattern = /\b(?:member|repo|repository|file|folder|path)\s+[`'"]?([A-Za-z0-9._/-]+)[`'"]?/gi;
  let match;
  while ((match = keywordPattern.exec(text))) {
    addMissing(match[1], pathLike(match[1]) ? 'path' : 'proper');
  }

  for (let index = 0; index < words.length; index += 1) {
    const clean = cleanToken(words[index]);
    if (!/^[A-Z][A-Za-z0-9_-]{2,}$/.test(clean)) continue;
    if (PROPER_SKIP.has(clean)) continue;
    if (index === 0 && VERBS.has(clean.toLowerCase())) continue;
    addMissing(clean, 'proper');
  }
  return missing;
}

function cleanPartText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/^[,;:\s]+|[,;:\s]+$/g, '')
    .trim();
}

function externalReference(text) {
  const words = wordList(text).map(cleanToken).filter(Boolean);
  for (let index = 0; index < words.length; index += 1) {
    const marker = words[index].toLowerCase().replace(/[^a-z]/g, '');
    if (!EXTERNAL_REF_WORDS.has(marker)) continue;
    const collected = [];
    for (let next = index + 1; next < words.length; next += 1) {
      const clean = words[next].toLowerCase().replace(/[^a-z0-9._-]/g, '');
      if (!clean || EXTERNAL_REF_STOP.has(clean)) break;
      if (VERBS.has(clean) || FILLER_WORDS.has(clean)) break;
      collected.push(clean);
      if (collected.length >= 3) break;
    }
    if (collected.length) return { marker, name: collected.join(' ') };
  }
  return null;
}

function outOfScopeReason(text, root) {
  const ref = externalReference(text);
  if (ref && !namedThingExists(root, ref.name)) {
    return `${ref.marker} ${ref.name} is not in this checkout`;
  }
  const missing = missingNamedInputs(text, root);
  const pathMissing = missing.find((item) => item.kind === 'path');
  if (pathMissing) return `${pathMissing.value} is not in this checkout`;
  return '';
}

function partLooksDeliverable(text, root) {
  if (outOfScopeReason(text, root)) return true;
  if (hasVerb(text)) return true;
  return meaningfulWordSet(text).size >= 2;
}

function analyzeWishParts(text, root) {
  const clean = cleanPartText(text);
  if (!clean) return null;
  const rough = clean.split(PART_JOINER).map(cleanPartText).filter(Boolean);
  const parts = (rough.length > 1 ? rough : [clean])
    .map((part, index) => ({
      part: index + 1,
      text: part,
      waiting_reason: outOfScopeReason(part, root),
    }))
    .filter((part) => rough.length === 1 || partLooksDeliverable(part.text, root));
  if (parts.length < 2 && !parts.some((part) => part.waiting_reason)) return null;
  return parts.length ? parts : null;
}

function auditWish(text, root = process.cwd()) {
  const questions = [];
  const clarity = clarityAudit(text);
  questions.push(...clarity.questions);

  let executor = null;
  let validator = null;
  try {
    executor = resolveRole('executor', root);
  } catch {
    executor = null;
  }
  try {
    validator = resolveRole('validator', root);
  } catch {
    validator = null;
  }
  if (!executor) questions.push('Which working builder should handle this?');
  if (!validator) questions.push('Which working reviewer should validate it?');

  const missing = missingNamedInputs(text, root);
  if (missing.some((item) => item.kind === 'path')) {
    questions.push('Where should I find the file or folder you named?');
  } else if (missing.length) {
    questions.push(`Which workspace, repo, file, or team member did you mean by ${missing[0].value}?`);
  }

  return {
    ok: questions.length === 0,
    questions: questions.slice(0, 3),
    executor,
    validator,
    budget: inferBudgetTier(text),
    missing,
    vague: clarity.vague,
    missing_slots: clarity.missing,
  };
}

function machineRecord(wish, status, audit, extra = {}) {
  return {
    wish_id: wish.id,
    status,
    task_id: extra.task_id || null,
    mission_id: extra.mission_id || null,
    engine: audit && audit.executor ? audit.executor.id : (extra.engine || null),
    budget: audit ? audit.budget : (extra.budget || null),
    questions: audit ? audit.questions : (extra.questions || []),
  };
}

function printQuestions(wishText, questions) {
  console.log(`You wished: ${quoteText(wishText)}`);
  questions.forEach((question, index) => {
    console.log(`${index + 1}. ${question}`);
  });
  console.log('answer with atris wish grant <n> "your answer".');
}

function engineLabel(engine) {
  const text = String(engine || 'the worker');
  if (text === 'codex') return 'Codex';
  if (text === 'claude') return 'Claude';
  if (text === 'atris-fast') return 'Atris Fast';
  return text;
}

function deriveVerifyPlan(text) {
  const compact = String(text || '').toLowerCase();
  if (/\b(test|tests|testing|suite|coverage)\b/.test(compact)) {
    return {
      command: TEST_VERIFY_COMMAND,
      outcome: 'the fast test run passes and is timed',
      status: 'derived',
    };
  }
  if (/\b(command|commands|cli|subcommand)\b/.test(compact)) {
    return {
      command: TEST_VERIFY_COMMAND,
      outcome: 'the new command runs end to end',
      status: 'derived',
    };
  }
  return {
    command: '',
    outcome: 'I will show you the result to judge',
    status: 'needs-review',
  };
}

function verifyOutcomeText(planOrCommand) {
  if (planOrCommand && typeof planOrCommand === 'object') return planOrCommand.outcome || JOURNAL_RESULT_TEXT;
  const verify = String(planOrCommand || '').trim();
  if (!verify) return JOURNAL_RESULT_TEXT;
  if (verify === TEST_VERIFY_COMMAND) return 'the fast test run passes and is timed';
  return `the verify command ${quoteText(verify)} passes`;
}

function printGranted(text, audit, options = {}) {
  const verifyPlan = options.verifyPlan || deriveVerifyPlan(text);
  if (options.grantNumber) {
    console.log(`Granting wish ${options.grantNumber}: ${quoteText(text)}`);
  } else {
    console.log(`I heard you: ${quoteText(text)}`);
  }
  console.log(`I delegated it to ${engineLabel(audit.executor.id)} with a ${audit.budget} budget, ${BUDGET_LABELS[audit.budget]}.`);
  if (verifyPlan.status === 'needs-review') console.log(verifyPlan.outcome + '.');
  else console.log(`You will know it came true when ${verifyOutcomeText(verifyPlan)}.`);
}

function latestMissionStatus(root, missionId) {
  if (!missionId) return '';
  try {
    const mission = listMissions(root).find((row) => row.id === missionId);
    return mission ? String(mission.status || '') : '';
  } catch {
    return '';
  }
}

function operatorStatus(wish, root = process.cwd()) {
  if (wish.status === 'needs_input') return 'waiting on you';
  if (wish.status === 'delegated' || wish.status === 'decomposed') {
    const missionStatus = latestMissionStatus(root, wish.mission_id);
    if (missionStatus === 'complete') return 'came true';
    if (missionStatus === 'stopped') return 'stopped';
    if (missionStatus === 'blocked') return 'blocked';
    if (missionStatus === 'paused') return 'paused';
    if (missionStatus === 'ready') return 'ready for review';
    if (missionStatus) return 'in flight';
    if (Array.isArray(wish.out_of_scope_parts) && wish.out_of_scope_parts.length) return 'waiting on another home';
    return 'in flight';
  }
  if (wish.status === 'complete') return 'came true';
  return wish.status || 'waiting';
}

function openWishes(root = process.cwd()) {
  return readWishes(root).filter((wish) => ['needs_input', 'delegated', 'decomposed', 'complete'].includes(String(wish.status || '')));
}

function printList(root = process.cwd()) {
  const wishes = openWishes(root);
  if (!wishes.length) {
    console.log('No open wishes.');
    return 0;
  }
  wishes.forEach((wish, index) => {
    console.log(`${index + 1}. ${wish.text} - ${operatorStatus(wish, root)}`);
  });
  return 0;
}

function startWishDelegation(wish, audit, root, options = {}) {
  const taskText = String(options.taskText || wish.text);
  const recordText = String(options.recordText || wish.text);
  const verifyPlan = options.verifyPlan || deriveVerifyPlan(taskText);
  const note = [
    `Wish: ${taskText}`,
    verifyPlan.command
      ? `Verify: ${verifyPlan.command} (${verifyOutcomeText(verifyPlan)})`
      : `Verify: needs human review (${verifyPlan.outcome})`,
    `Budget: ${audit.budget}`,
  ].join('\n');
  const taskPayload = delegateTask([
    taskText,
    '--to',
    audit.executor.id,
    '--executed-by',
    audit.executor.id,
    '--tag',
    'wish',
    '--goal-objective',
    taskText,
    '--note',
    note,
  ]);
  const missionArgs = [
    taskText,
    '--owner',
    audit.executor.id,
    '--runner',
    audit.executor.id,
    '--budget',
    audit.budget,
    '--task',
    taskPayload.task_id,
    '--json',
  ];
  if (verifyPlan.command) missionArgs.push('--verify', verifyPlan.command);
  const missionPayload = startMission(missionArgs, { silent: true });
  const mission = missionPayload && missionPayload.mission ? missionPayload.mission : null;
  const record = {
    id: wish.id,
    ts: stampIso(),
    text: recordText,
    status: 'delegated',
    task_id: taskPayload.task_id,
    mission_id: mission ? mission.id : null,
    engine: audit.executor.id,
    validator: audit.validator.id,
    budget: audit.budget,
    verify: verifyPlan.command,
    verify_status: verifyPlan.status,
    verify_outcome: verifyPlan.outcome,
    task_text: taskText,
  };
  return { record, taskPayload, mission, verifyPlan };
}

function delegateWish(wish, audit, root, asJson, options = {}) {
  const { record, verifyPlan } = startWishDelegation(wish, audit, root, options);
  appendWishRecord(root, record);
  const payload = machineRecord(wish, 'delegated', audit, {
    task_id: record.task_id,
    mission_id: record.mission_id,
  });
  if (asJson) console.log(JSON.stringify(payload, null, 2));
  else printGranted(options.taskText || wish.text, audit, { ...options, verifyPlan });
  return 0;
}

function formatPartRefs(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  if (!sorted.length) return 'no parts';
  if (sorted.length === 1) return `part ${sorted[0]}`;
  const contiguous = sorted.every((value, index) => index === 0 || value === sorted[index - 1] + 1);
  if (contiguous) return `parts ${sorted[0]}-${sorted[sorted.length - 1]}`;
  return `parts ${sorted.slice(0, -1).join(', ')} and ${sorted[sorted.length - 1]}`;
}

function printDecomposed(parts, delegatedParts, waitingParts) {
  console.log(`This wish has ${parts.length} ${parts.length === 1 ? 'part' : 'parts'}.`);
  parts.forEach((part) => {
    console.log(`Part ${part.part}: ${part.text}`);
  });
  const delegatedNumbers = delegatedParts.map((part) => part.part);
  const ownHomeNumbers = waitingParts
    .filter((part) => part.reason && /not in this checkout/.test(part.reason))
    .map((part) => part.part);
  const otherWaitingNumbers = waitingParts
    .filter((part) => !ownHomeNumbers.includes(part.part))
    .map((part) => part.part);
  if (delegatedNumbers.length && ownHomeNumbers.length) {
    const needs = ownHomeNumbers.length === 1 ? 'needs its own home' : 'need their own homes';
    console.log(`I can start ${formatPartRefs(delegatedNumbers)} now; ${formatPartRefs(ownHomeNumbers)} ${needs}.`);
  } else if (delegatedNumbers.length) {
    console.log(`I can start ${formatPartRefs(delegatedNumbers)} now.`);
  } else if (ownHomeNumbers.length) {
    const needs = ownHomeNumbers.length === 1 ? 'needs its own home' : 'need their own homes';
    console.log(`${formatPartRefs(ownHomeNumbers)} ${needs}.`);
  }
  if (otherWaitingNumbers.length) {
    console.log(`${formatPartRefs(otherWaitingNumbers)} need one clearer answer before I start.`);
  }
}

function decomposeWish(wish, parts, root, asJson) {
  const delegatedParts = [];
  const waitingParts = [];
  let firstAudit = null;
  for (const part of parts) {
    if (part.waiting_reason) {
      waitingParts.push({
        part: part.part,
        text: part.text,
        status: 'waiting',
        reason: part.waiting_reason,
      });
      continue;
    }
    const audit = auditWish(part.text, root);
    if (!audit.ok) {
      waitingParts.push({
        part: part.part,
        text: part.text,
        status: 'waiting',
        reason: audit.questions[0] || 'needs a clearer scope',
        questions: audit.questions,
      });
      continue;
    }
    if (!firstAudit) firstAudit = audit;
    const { record, verifyPlan } = startWishDelegation(wish, audit, root, {
      taskText: part.text,
      recordText: wish.text,
      verifyPlan: deriveVerifyPlan(part.text),
    });
    const delegated = {
      part: part.part,
      text: part.text,
      status: 'delegated',
      task_id: record.task_id,
      mission_id: record.mission_id,
      budget: record.budget,
      verify: record.verify,
      verify_status: record.verify_status,
      verify_outcome: record.verify_outcome,
    };
    delegatedParts.push(delegated);
    appendWishRecord(root, {
      ...record,
      decomposed_part: part.part,
      parts_total: parts.length,
      verify_status: verifyPlan.status,
    });
  }
  const statusParts = parts.map((part) => {
    const delegated = delegatedParts.find((item) => item.part === part.part);
    if (delegated) return { part: part.part, text: part.text, status: 'delegated' };
    const waiting = waitingParts.find((item) => item.part === part.part);
    return {
      part: part.part,
      text: part.text,
      status: 'waiting',
      reason: waiting ? waiting.reason : 'needs its own home',
    };
  });
  const firstDelegated = delegatedParts[0] || null;
  const record = {
    id: wish.id,
    ts: stampIso(),
    text: wish.text,
    status: 'decomposed',
    task_id: firstDelegated ? firstDelegated.task_id : null,
    mission_id: firstDelegated ? firstDelegated.mission_id : null,
    engine: firstAudit && firstAudit.executor ? firstAudit.executor.id : null,
    validator: firstAudit && firstAudit.validator ? firstAudit.validator.id : null,
    budget: firstAudit ? firstAudit.budget : inferBudgetTier(wish.text),
    parts: statusParts,
    delegated_parts: delegatedParts,
    out_of_scope_parts: waitingParts
      .filter((part) => part.reason && /not in this checkout/.test(part.reason))
      .map((part) => ({ ...part, status: 'waiting' })),
    waiting_parts: waitingParts,
  };
  appendWishRecord(root, record);
  const payload = {
    ...machineRecord(wish, 'decomposed', firstAudit, {
      task_id: record.task_id,
      mission_id: record.mission_id,
      engine: record.engine,
      budget: record.budget,
      questions: [],
    }),
    parts: statusParts,
    delegated_parts: delegatedParts,
    out_of_scope_parts: record.out_of_scope_parts,
  };
  if (asJson) console.log(JSON.stringify(payload, null, 2));
  else printDecomposed(parts, delegatedParts, waitingParts);
  return delegatedParts.length ? 0 : 1;
}

function askForInput(wish, audit, root, asJson) {
  appendWishRecord(root, {
    id: wish.id,
    ts: stampIso(),
    text: wish.text,
    status: 'needs_input',
    questions: audit.questions,
    vague: !!audit.vague,
    missing_slots: audit.missing_slots || [],
  });
  const payload = machineRecord(wish, 'needs_input', audit);
  if (asJson) console.log(JSON.stringify(payload, null, 2));
  else printQuestions(wish.text, audit.questions);
  return 1;
}

function runCapturedWish(text, args, root = process.cwd()) {
  const asJson = hasFlag(args, '--json');
  const ts = stampIso();
  const wish = {
    id: wishId(text, ts),
    ts,
    text,
    status: 'captured',
  };
  captureWishToJournal(text, root);
  appendWishRecord(root, wish);
  const parts = analyzeWishParts(text, root);
  if (parts) return decomposeWish(wish, parts, root, asJson);
  const audit = auditWish(text, root);
  if (!audit.ok) return askForInput(wish, audit, root, asJson);
  return delegateWish(wish, audit, root, asJson);
}

function grantWish(args, root = process.cwd()) {
  const asJson = hasFlag(args, '--json');
  const positionals = stripFlags(args);
  const number = Number(positionals[1]);
  const answer = positionals.slice(2).join(' ').trim();
  if (!Number.isInteger(number) || number <= 0 || !answer) {
    console.error('wish grant needs a list number and an answer.');
    return 2;
  }
  const waiting = openWishes(root);
  const wish = waiting[number - 1];
  if (!wish) {
    console.error('No wish is waiting at that number.');
    return 2;
  }
  if (wish.status !== 'needs_input') {
    if (!asJson) console.log(`Granting wish ${number}: ${quoteText(wish.text)}`);
    console.error('That wish is not waiting on an answer.');
    return 2;
  }
  const vagueFlagged = wish.vague === true
    || (Array.isArray(wish.missing_slots) && wish.missing_slots.length > 0)
    || (Array.isArray(wish.questions) && wish.questions.some((question) => /\b(outcome|Who is|What part)\b/i.test(String(question))));
  if (vagueFlagged && !sharesMeaningfulWords(wish.text, answer)) {
    const notice = 'This answer may be for a different wish, so I did not dispatch it.';
    if (asJson) {
      const payload = machineRecord(wish, 'needs_input', {
        executor: null,
        budget: wish.budget || inferBudgetTier(wish.text),
        questions: wish.questions || [],
      }, {
        engine: wish.engine || null,
      });
      console.log(JSON.stringify({
        ...payload,
        mismatch: true,
        notice,
        wish_text: wish.text,
      }, null, 2));
    } else {
      console.log(`Granting wish ${number}: ${quoteText(wish.text)}`);
      console.log(notice);
      printList(root);
    }
    return 1;
  }
  appendWishRecord(root, {
    id: wish.id,
    ts: stampIso(),
    text: wish.text,
    status: 'needs_input',
    answer,
  });
  const answeredWish = {
    ...wish,
    answers: [...(wish.answers || []), answer],
  };
  const auditText = [wish.text, ...(answeredWish.answers || [])].join(' ');
  const audit = auditWish(auditText, root);
  if (!audit.ok) return askForInput(answeredWish, audit, root, asJson);
  return delegateWish(answeredWish, audit, root, asJson, { grantNumber: number });
}

function wishCommand(args = []) {
  const first = String(args[0] || '').trim();
  if (!first || first === '--help' || first === '-h' || first === 'help') {
    showHelp();
    return first ? 0 : 2;
  }
  if (first === 'list' || first === 'ls' || first === 'status') {
    return printList(process.cwd());
  }
  if (first === 'grant' || first === 'answer') {
    return grantWish(args, process.cwd());
  }
  const text = stripFlags(args).join(' ').trim();
  if (!text) {
    showHelp();
    return 2;
  }
  return runCapturedWish(text, args, process.cwd());
}

module.exports = {
  wishCommand,
  analyzeWishParts,
  auditWish,
  captureWishToJournal,
  deriveVerifyPlan,
  inferBudgetTier,
  missingNamedInputs,
  readWishes,
  sharesMeaningfulWords,
  stateFile,
  verifyOutcomeText,
};
