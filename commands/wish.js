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

const VERIFY_COMMAND = 'git diff --check';
const JOURNAL_RESULT_TEXT = 'a written result will be waiting in your journal';
const AUDIENCE_WORDS = /\b(?:for|user|users|customer|customers|operator|operators|agent|agents|developer|developers|admin|admins|member|members|team|teams|visitor|visitors|client|clients|student|students|founder|founders|newcomer|newcomers)\b/i;
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

function inferBudgetTier(text) {
  const compact = String(text || '').toLowerCase();
  if (/\b(quick|small|tiny)\b/.test(compact)) return 'quick';
  if (/\b(big|full|overhaul|all)\b/.test(compact)) return 'deep';
  return 'long';
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
  if (slug && base.includes(slug)) return true;
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
  if (!words.length) return 'this wish';
  let usable = words;
  const first = words[0].toLowerCase();
  if (VERBS.has(first)) usable = words.slice(1);
  usable = usable.filter((word) => {
    const clean = word.toLowerCase().replace(/[^a-z0-9-]/g, '');
    return clean && !['a', 'an', 'the', 'please', 'better', 'friendlier', 'improved', 'more'].includes(clean);
  });
  return usable.slice(0, 4).join(' ') || 'this wish';
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
    questions.push(`What outcome should ${subject} create?`);
  }
  if (vague && !AUDIENCE_WORDS.test(text)) {
    missing.push('audience');
    questions.push(`Who is ${subject} for?`);
  }
  if (vague) {
    missing.push('scope');
    questions.push(`What part of ${subject} should I change first?`);
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

function verifyOutcomeText(command) {
  const verify = String(command || '').trim();
  if (!verify) return JOURNAL_RESULT_TEXT;
  if (verify === 'git diff --check') return 'the git diff whitespace check passes';
  return `the verify command ${quoteText(verify)} passes`;
}

function printGranted(text, audit, options = {}) {
  if (options.grantNumber) {
    console.log(`Granting wish ${options.grantNumber}: ${quoteText(text)}`);
  } else {
    console.log(`I heard you: ${quoteText(text)}`);
  }
  console.log(`I delegated it to ${engineLabel(audit.executor.id)} with a ${audit.budget} budget, ${BUDGET_LABELS[audit.budget]}.`);
  console.log(`You will know it came true when ${verifyOutcomeText(options.verify || VERIFY_COMMAND)}.`);
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
  if (wish.status === 'delegated') {
    return latestMissionStatus(root, wish.mission_id) === 'complete' ? 'came true' : 'in flight';
  }
  if (wish.status === 'complete') return 'came true';
  return wish.status || 'waiting';
}

function openWishes(root = process.cwd()) {
  return readWishes(root).filter((wish) => ['needs_input', 'delegated', 'complete'].includes(String(wish.status || '')));
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

function delegateWish(wish, audit, root, asJson, options = {}) {
  const note = [
    `Wish: ${wish.text}`,
    `Verify: ${VERIFY_COMMAND} (${verifyOutcomeText(VERIFY_COMMAND)})`,
    `Budget: ${audit.budget}`,
  ].join('\n');
  const taskPayload = delegateTask([
    wish.text,
    '--to',
    audit.executor.id,
    '--executed-by',
    audit.executor.id,
    '--tag',
    'wish',
    '--goal-objective',
    wish.text,
    '--note',
    note,
  ]);
  const missionPayload = startMission([
    wish.text,
    '--owner',
    audit.executor.id,
    '--runner',
    audit.executor.id,
    '--budget',
    audit.budget,
    '--verify',
    VERIFY_COMMAND,
    '--task',
    taskPayload.task_id,
    '--json',
  ], { silent: true });
  const mission = missionPayload && missionPayload.mission ? missionPayload.mission : null;
  const record = {
    id: wish.id,
    ts: stampIso(),
    text: wish.text,
    status: 'delegated',
    task_id: taskPayload.task_id,
    mission_id: mission ? mission.id : null,
    engine: audit.executor.id,
    validator: audit.validator.id,
    budget: audit.budget,
    verify: VERIFY_COMMAND,
  };
  appendWishRecord(root, record);
  const payload = machineRecord(wish, 'delegated', audit, {
    task_id: taskPayload.task_id,
    mission_id: mission ? mission.id : null,
  });
  if (asJson) console.log(JSON.stringify(payload, null, 2));
  else printGranted(wish.text, audit, { ...options, verify: VERIFY_COMMAND });
  return 0;
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
  auditWish,
  captureWishToJournal,
  inferBudgetTier,
  missingNamedInputs,
  readWishes,
  sharesMeaningfulWords,
  stateFile,
  verifyOutcomeText,
};
