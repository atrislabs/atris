'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const engineRegistry = require('./engine-registry');
const { slugify } = require('./wish-store');

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

const WISH_SWEEP_LIMIT = 3;
const WISH_MISSION_RUNNER = 'claude';
const TEST_VERIFY_COMMAND = 'node --test';
const JOURNAL_RESULT_TEXT = 'a written result will be waiting in your journal';
const WAITING_INPUT_STATUSES = new Set(['needs_input', 'waiting_input']);
const PATH_SLOT_QUESTION = 'Where should I find the file or folder you named?';
const AUDIENCE_WORDS = /\b(?:for|user|users|customer|customers|operator|operators|agent|agents|developer|developers|admin|admins|member|members|team|teams|visitor|visitors|client|clients|student|students|founder|founders|newcomer|newcomers)\b/i;
const BUDGET_RANK = { quick: 1, long: 2, deep: 3 };
let answerAuditContext = null;
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
const KEYWORD_VALUE_SKIP = new Set([
  ...FILLER_WORDS,
  'again',
  'already',
  'anyway',
  'everywhere',
  'first',
  'in',
  'is',
  'next',
  'now',
  'still',
  'though',
  'today',
  'yet',
]);

function validateEngineOverride(engineOverride, root) {
  const clean = String(engineOverride || '').trim();
  if (clean) engineRegistry.resolveRegisteredEngine(clean, root);
  return clean;
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

function resolveExecutor(root, engineOverride = '') {
  if (engineOverride) {
    return engineRegistry.resolveEngineForRoleWithPreference('executor', root, engineOverride);
  }
  return {
    engine: resolveRole('executor', root),
    requested_engine: null,
    engine_fallback_reason: null,
  };
}

function cleanToken(value) {
  return String(value || '')
    .replace(/^[`'"]+|[`'",;:!?]+$/g, '')
    .trim();
}

function expandHomePath(value) {
  const raw = String(value || '');
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return raw;
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
  const expanded = expandHomePath(raw);
  const candidates = path.isAbsolute(expanded)
    ? [expanded]
    : [path.join(root, expanded), path.join(path.dirname(root), expanded)];
  return candidates.some((candidate) => fs.existsSync(candidate));
}

function wishEventsFile(root) {
  return path.join(root, '.atris', 'state', 'wishes.jsonl');
}

function readWishAuditEvents(root) {
  const file = wishEventsFile(root);
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

function pathLikeTokens(text) {
  return wordList(text).map(cleanToken).filter((word) => pathLike(word));
}

function rowAskedQuestion(row, expected) {
  const cleanExpected = String(expected || '').trim();
  if (!cleanExpected) return false;
  return Array.isArray(row && row.questions)
    && row.questions.some((question) => String(question || '').trim() === cleanExpected);
}

function rowMatchesAuditText(row, auditText) {
  const text = String(row && row.text || '').trim();
  const full = String(auditText || '').trim();
  return !!text && (full === text || full.startsWith(`${text} `));
}

function priorQuestionRowForAuditText(text, root, question) {
  return readWishAuditEvents(root).find((row) => rowAskedQuestion(row, question) && rowMatchesAuditText(row, text)) || null;
}

function activeAnswerContext(root) {
  const context = answerAuditContext;
  if (!context || path.resolve(context.root || root) !== path.resolve(root)) return false;
  if (!String(context.answer || '').trim()) return false;
  return context;
}

function rememberFilledQuestion(context, askedRow, question, slot) {
  if (slot && !context.filled_slot) {
    context.filled_slot = {
      kind: slot.kind,
      question,
      value: slot.value,
    };
  }
  context.wish_id = askedRow.id || context.wish_id || null;
  context.n = askedRow.n || context.n || undefined;
  context.text = askedRow.text || context.text || '';
}

function shouldAcceptRepeatedQuestion(text, root, question, slot = null) {
  const context = activeAnswerContext(root);
  if (!context) return false;
  const askedRow = priorQuestionRowForAuditText(text, root, question);
  if (!askedRow) return false;
  rememberFilledQuestion(context, askedRow, question, slot);
  return true;
}

function shouldAcceptPathAnswer(text, root) {
  const context = activeAnswerContext(root);
  if (!context) return false;
  const tokens = pathLikeTokens(context.answer || '');
  return shouldAcceptRepeatedQuestion(text, root, PATH_SLOT_QUESTION, {
    kind: 'path',
    value: tokens[0] || String(context.answer || '').trim(),
  });
}

function answeredRepeatedQuestionValue(text, root, question, kind = 'question') {
  const context = activeAnswerContext(root);
  if (!context) return '';
  const value = String(context.answer || '').trim();
  return shouldAcceptRepeatedQuestion(text, root, question, { kind, value }) ? value : '';
}

function withWishAnswerAuditContext(context, fn) {
  const previous = answerAuditContext;
  answerAuditContext = context || null;
  try {
    return fn();
  } finally {
    answerAuditContext = previous;
  }
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
    questions.push(subject
      ? `What should be different about ${subject} when this wish comes true?`
      : 'What should be different when this wish comes true?');
  }
  if (vague && !AUDIENCE_WORDS.test(text)) {
    missing.push('audience');
    questions.push('Who is this for?');
  }
  if (vague) {
    missing.push('scope');
    questions.push(subject ? `What part of ${subject} should I change first?` : 'What part should I change first?');
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
    if (KEYWORD_VALUE_SKIP.has(String(match[1] || '').toLowerCase())) continue;
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

function auditWish(text, root = process.cwd(), options = {}) {
  const questions = [];
  const clarity = clarityAudit(text);
  for (const question of clarity.questions) {
    if (!answeredRepeatedQuestionValue(text, root, question, 'clarity')) questions.push(question);
  }
  const engineOverride = String(options.engineOverride || '').trim();

  let executor = null;
  let validator = null;
  let requestedEngine = null;
  let engineFallbackReason = null;
  try {
    const resolved = resolveExecutor(root, engineOverride);
    executor = resolved.engine;
    requestedEngine = resolved.requested_engine;
    engineFallbackReason = resolved.engine_fallback_reason;
  } catch (error) {
    if (engineOverride) throw error;
    executor = null;
  }
  try {
    validator = resolveRole('validator', root);
  } catch {
    validator = null;
  }
  if (!executor) {
    const question = 'Which working builder should handle this?';
    const answered = answeredRepeatedQuestionValue(text, root, question, 'builder');
    if (answered) executor = { id: slugify(answered), name: answered };
    else questions.push(question);
  }
  if (!validator) {
    const question = 'Which working reviewer should validate it?';
    const answered = answeredRepeatedQuestionValue(text, root, question, 'reviewer');
    if (answered) validator = { id: slugify(answered), name: answered };
    else questions.push(question);
  }

  let missing = missingNamedInputs(text, root);
  if (missing.some((item) => item.kind === 'path') && shouldAcceptPathAnswer(text, root)) {
    missing = missing.filter((item) => item.kind !== 'path');
  }
  if (missing.some((item) => item.kind === 'path')) {
    questions.push(PATH_SLOT_QUESTION);
  } else {
    while (missing.length) {
      const [first, ...rest] = missing;
      const question = `Which workspace, repo, file, or team member did you mean by ${first.value}?`;
      const answered = answeredRepeatedQuestionValue(text, root, question, first.kind);
      if (!answered) {
        questions.push(question);
        break;
      }
      missing = rest;
    }
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
    requested_engine: requestedEngine,
    engine_fallback_reason: engineFallbackReason,
  };
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

module.exports = {
  BUDGET_LABELS,
  JOURNAL_RESULT_TEXT,
  TEST_VERIFY_COMMAND,
  WAITING_INPUT_STATUSES,
  WISH_MISSION_RUNNER,
  WISH_SWEEP_LIMIT,
  analyzeWishParts,
  auditWish,
  deriveVerifyPlan,
  inferBudgetTier,
  missingNamedInputs,
  PATH_SLOT_QUESTION,
  quoteText,
  sharesMeaningfulWords,
  validateEngineOverride,
  verifyOutcomeText,
  withWishAnswerAuditContext,
};
