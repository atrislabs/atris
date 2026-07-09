'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const engineRegistry = require('./engine-registry');
const { slugify } = require('./wish-store');

const VERBS = new Set([
  'add',
  'archive',
  'audit',
  'backfill',
  'build',
  'bump',
  'bundle',
  'buries',
  'bury',
  'change',
  'check',
  'clean',
  'compress',
  'create',
  'cut',
  'debug',
  'debounce',
  'delegate',
  'deserve',
  'deserves',
  'deploy',
  'design',
  'disable',
  'do',
  'draft',
  'downgrade',
  'drop',
  'enable',
  'explain',
  'extract',
  'find',
  'fix',
  'get',
  'hide',
  'hook',
  'improve',
  'inline',
  'install',
  'kill',
  'lighten',
  'make',
  'merge',
  'migrate',
  'move',
  'need',
  'needs',
  'open',
  'paginate',
  'pin',
  'plan',
  'polish',
  'refactor',
  'rebuild',
  'remove',
  'rename',
  'research',
  'reduce',
  'review',
  'redo',
  'release',
  'restore',
  'retry',
  'rework',
  'rewrite',
  'rotate',
  'run',
  'schedule',
  'set',
  'setup',
  'shave',
  'ship',
  'shrink',
  'sort',
  'speed',
  'split',
  'start',
  'stop',
  'swap',
  'sweep',
  'test',
  'theres',
  'throttle',
  'toggle',
  'trim',
  'tweak',
  'update',
  'upgrade',
  'verify',
  'wire',
  'write',
  'understand',
]);

const PROPER_SKIP = new Set([
  'A',
  'An',
  'And',
  'At',
  'But',
  'Cant',
  'Didnt',
  'Doesnt',
  'Dont',
  'For',
  'Hes',
  'Id',
  'Ill',
  'Im',
  'I',
  'Isnt',
  'Its',
  'Ive',
  'In',
  'Lets',
  'Make',
  'On',
  'Or',
  'Please',
  'Shes',
  'Thats',
  'The',
  'Theres',
  'This',
  'To',
  'Were',
  'Weve',
  'Whats',
  'With',
  'Wont',
  'Youre',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
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
const VAGUE_SUPERLATIVE_WORDS = new Set([
  'amazing',
  'awesome',
  'best',
  'better',
  'clearest',
  'easiest',
  'fastest',
  'friendliest',
  'good',
  'great',
  'greatest',
  'nicest',
  'perfect',
  'smartest',
]);
const GENERIC_INTERPRETATION_VERBS = new Set([
  'add',
  'build',
  'change',
  'create',
  'do',
  'fix',
  'get',
  'improve',
  'make',
  'polish',
  'tweak',
  'update',
]);
const AMBIGUITY_INTERPRETATIONS = {
  'vague-superlative': {
    candidates: ['faster to use', 'smarter by default', 'more complete'],
    recommendedIndex: 1,
    ask: 'which should I optimize for',
  },
  'missing-audience': {
    candidates: ['solo operator', 'team member', 'end user'],
    recommendedIndex: 0,
    ask: 'who is this for',
  },
  'missing-first-slice': {
    candidates: ['capture path', 'resurfacing rule', 'closure loop'],
    recommendedIndex: 1,
    ask: 'what should I change first',
  },
};
const SUBJECT_KIND_INTERPRETATIONS = {
  list: {
    'vague-superlative': {
      candidates: ['fastest capture', 'smartest resurfacing', 'most closure'],
      recommendedIndex: 1,
    },
    'missing-first-slice': {
      candidates: ['capture path', 'resurfacing rule', 'closure loop'],
      recommendedIndex: 1,
    },
  },
  page: {
    'vague-superlative': {
      candidates: ['clearer layout', 'faster scanning', 'stronger action'],
      recommendedIndex: 0,
    },
    'missing-first-slice': {
      candidates: ['top section', 'content hierarchy', 'primary action'],
      recommendedIndex: 1,
    },
  },
  loop: {
    'vague-superlative': {
      candidates: ['fewer steps', 'smarter defaults', 'more reliable completion'],
      recommendedIndex: 1,
    },
    'missing-first-slice': {
      candidates: ['entry path', 'decision rule', 'completion check'],
      recommendedIndex: 1,
    },
  },
  generic: {
    'vague-superlative': {
      candidates: ['faster to use', 'smarter by default', 'more complete'],
      recommendedIndex: 1,
    },
    'missing-first-slice': {
      candidates: ['first step', 'default behavior', 'completion path'],
      recommendedIndex: 1,
    },
  },
};
const SUBJECT_KIND_WORDS = {
  list: new Set(['backlog', 'board', 'inbox', 'kanban', 'list', 'queue', 'reminder', 'task', 'todo']),
  page: new Set(['card', 'dashboard', 'form', 'homepage', 'landing', 'modal', 'page', 'panel', 'screen', 'site', 'surface', 'ui', 'view', 'website']),
  loop: new Set(['auth', 'automation', 'cadence', 'checkout', 'flow', 'import', 'login', 'loop', 'onboarding', 'pipeline', 'process', 'routine', 'signup', 'sync', 'workflow']),
};
// A conjunction followed by a determiner ("an ml researcher and a 2nd grade
// teacher") joins noun phrases inside one clause, not two separate wishes.
const PART_JOINER_WORDS = new Set(['and', 'plus', 'also', 'adn', 'nad', 'annd']);
const PART_JOINER_DETERMINERS = new Set(['a', 'an', 'the', 'my', 'our', 'your', 'this', 'that', 'these', 'those', 'its', 'his', 'her', 'their']);
const PART_JOINER_PRONOUN_OBJECTS = new Set(['it', 'them', 'this', 'that']);
const FIXED_AND_COMPOUNDS = new Set([
  'back and forth',
  'black and white',
  'copy and paste',
  'drag and drop',
  'plug and play',
  'pros and cons',
]);
const LEADING_PART_CONNECTORS = /^(?:(?:and|also|then|plus|finally|next)\s+)+/i;
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
  'me',
  'might',
  'my',
  'need',
  'needs',
  'our',
  'should',
  'take',
  'this',
  'us',
  'we',
  'will',
  'wish',
  'would',
  'you',
  'your',
]);
const FILLER_WORDS = new Set([
  'a',
  'about',
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
  'like',
  'more',
  'nice',
  'of',
  'on',
  'or',
  'our',
  'please',
  'pls',
  'plz',
  'rough',
  'roughly',
  'the',
  'their',
  'this',
  'to',
  'want',
  'with',
]);
const DEICTIC_STAND_INS = new Set(['thing', 'stuff', 'one', 'it', 'that', 'those', 'these', 'other', 'same', 'again']);
const COMMON_GERUND_NOUNS = new Set([
  'spacing',
  'padding',
  'loading',
  'landing',
  'onboarding',
  'branding',
  'heading',
  'setting',
  'settings',
  'styling',
  'everything',
  'nothing',
  'morning',
  'evening',
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
const INTERPRETATION_SKIP_WORDS = new Set([
  ...FILLER_WORDS,
  ...SUBJECT_SKIP_WORDS,
  ...DEICTIC_STAND_INS,
  ...VAGUE_SUPERLATIVE_WORDS,
  'ever',
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

function cleanWord(value) {
  return String(value || '').toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
}

function hasVerbToken(value) {
  const clean = cleanWord(value);
  if (clean.endsWith('ing') && COMMON_GERUND_NOUNS.has(clean)) return false;
  return VERBS.has(clean) || /(?:ed|ing)$/.test(clean);
}

function hasVerb(text) {
  return wordList(text).some((word) => hasVerbToken(word));
}

function hasStandaloneInstructionVerb(text) {
  for (const word of wordList(text)) {
    const clean = cleanWord(word);
    if (!clean) continue;
    if (VERBS.has(clean)) return true;
    if (/(?:ed|ing)$/.test(clean)) {
      if (!clean.endsWith('ing') || !COMMON_GERUND_NOUNS.has(clean)) return true;
    }
  }
  return false;
}

function largerBudget(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return BUDGET_RANK[right] > BUDGET_RANK[left] ? right : left;
}

function speedBudgetSignal(text) {
  const compact = String(text || '').toLowerCase();
  const action = '(?:fix|patch|polish|tweak|change|update|edit|cleanup|clean|rename|remove|add|copy)';
  const quick = '(?:quick|quik|qucik|small|smal|tiny)';
  if (new RegExp(`\\b${quick}\\s+${action}\\b`).test(compact)) return 'quick';
  if (new RegExp(`\\b${action}\\b.{0,32}\\b(?:${quick}|quickly)\\b`).test(compact)) return 'quick';
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
  if (/^v?\d+(?:\.\d+)+$/i.test(text)) return false;
  if (/^\d+(?:\.\d+)?(?:s|ms|x|k|m|gb|mb|px|%)$/i.test(text)) return false;
  if (!/[\\/]/.test(text)) {
    const suffix = (text.match(/\.([A-Za-z]+)$/) || [])[1];
    if (suffix && new Set(['then', 'also', 'and', 'so', 'but', 'now', 'next', 'we', 'it']).has(suffix.toLowerCase())) {
      return false;
    }
  }
  return text.startsWith('./')
    || text.startsWith('../')
    || text.startsWith('/')
    || text.startsWith('~/')
    || text.includes('/')
    || /\.[A-Za-z0-9]{1,8}$/.test(text);
}

function isNameShapedToken(value) {
  const text = cleanToken(value);
  if (!text) return false;
  if (/^[A-Z]/.test(text)) return true;
  return /[./_\-0-9]/.test(text);
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
    path.join(root, `${raw}.md`),
    path.join(root, `${slug}.md`),
    path.join(path.dirname(root), raw),
    path.join(path.dirname(root), slug),
    path.join(path.dirname(root), `${raw}.md`),
    path.join(path.dirname(root), `${slug}.md`),
    path.join(root, 'atris', 'team', raw),
    path.join(root, 'atris', 'team', slug),
  ];
  if (candidates.some((candidate) => fs.existsSync(candidate))) return true;
  try {
    const names = new Set([raw, slug, `${raw}.md`, `${slug}.md`]
      .filter(Boolean)
      .map((name) => String(name).toLowerCase()));
    return fs.readdirSync(root).some((entry) => {
      const lower = entry.toLowerCase();
      const base = path.basename(entry, path.extname(entry)).toLowerCase();
      return names.has(lower) || names.has(base);
    });
  } catch {
    return false;
  }
}

function subjectForWish(text) {
  const words = wordList(text)
    .map(cleanToken)
    .filter(Boolean);
  if (!words.length) return '';
  let usable = words;
  while (usable.length) {
    const clean = cleanWord(usable[0]);
    if (VERBS.has(clean) || FILLER_WORDS.has(clean) || SUBJECT_SKIP_WORDS.has(clean) || DEICTIC_STAND_INS.has(clean)) {
      usable = usable.slice(1);
      continue;
    }
    break;
  }
  const phrase = [];
  for (const word of usable) {
    const clean = cleanWord(word);
    if (!clean) continue;
    if (['by', 'for', 'from', 'in', 'into', 'of', 'on', 'to', 'with'].includes(clean) && phrase.length) break;
    if (FILLER_WORDS.has(clean) || SUBJECT_SKIP_WORDS.has(clean) || DEICTIC_STAND_INS.has(clean)) continue;
    if (VERBS.has(clean)) continue;
    phrase.push(clean);
    if (phrase.length >= 4) break;
  }
  return phrase.join(' ');
}

function meaningfulWordSet(text) {
  const words = new Set();
  for (const raw of wordList(text)) {
    const clean = cleanWord(raw);
    if (!clean || clean.length < 3) continue;
    if (VERBS.has(clean) || FILLER_WORDS.has(clean)) continue;
    words.add(clean.replace(/s$/, ''));
  }
  return words;
}

function meaningfulInstructionWordCount(text) {
  let count = 0;
  for (const raw of wordList(text)) {
    const clean = cleanWord(raw);
    if (!clean || clean.length < 2) continue;
    if (FILLER_WORDS.has(clean) || SUBJECT_SKIP_WORDS.has(clean) || DEICTIC_STAND_INS.has(clean)) continue;
    count += 1;
  }
  return count;
}

function hasMeaningfulContent(text) {
  for (const raw of wordList(text)) {
    const clean = cleanWord(raw);
    if (!clean || clean.length < 2) continue;
    if (FILLER_WORDS.has(clean) || SUBJECT_SKIP_WORDS.has(clean) || DEICTIC_STAND_INS.has(clean)) continue;
    if (VERBS.has(clean) || hasVerbToken(raw)) continue;
    return true;
  }
  return false;
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

function capitalizeFirst(text) {
  const clean = String(text || '').trim();
  if (!clean) return '';
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function singularInterpretationWord(word) {
  const clean = cleanWord(word);
  if (clean.length > 3 && clean.endsWith('s')) return clean.slice(0, -1);
  return clean;
}

function interpretationWords(text, subject) {
  const values = [];
  for (const source of [subject, text]) {
    for (const word of wordList(source)) {
      const raw = cleanWord(word);
      if (!raw || INTERPRETATION_SKIP_WORDS.has(raw)) continue;
      const clean = singularInterpretationWord(raw);
      if (!clean || clean.length < 3) continue;
      if (INTERPRETATION_SKIP_WORDS.has(clean)) continue;
      if (VERBS.has(clean)) continue;
      if (hasVerbToken(clean) && (!clean.endsWith('ing') || !COMMON_GERUND_NOUNS.has(clean))) continue;
      if (!values.includes(clean)) values.push(clean);
    }
  }
  return values;
}

function interpretationVerb(text) {
  for (const word of wordList(text)) {
    const clean = cleanWord(word);
    if (!clean || GENERIC_INTERPRETATION_VERBS.has(clean)) continue;
    if (VERBS.has(clean)) return clean;
  }
  return '';
}

function superlativeWord(text) {
  for (const word of wordList(text)) {
    const clean = cleanWord(word);
    if (VAGUE_SUPERLATIVE_WORDS.has(clean)) return clean;
  }
  return '';
}

function interpretationContext(text, subject) {
  const nouns = interpretationWords(text, subject);
  const topic = nouns.slice(0, 2).join(' ');
  return {
    words: wordList(text).map(cleanWord).filter(Boolean),
    topicWords: nouns,
    topic,
    topicHead: nouns[0] || '',
    action: interpretationVerb(text),
    superlative: superlativeWord(text),
  };
}

function subjectKindForInterpretation(ctx) {
  const topicWords = Array.isArray(ctx.topicWords) ? ctx.topicWords : [];
  if (!topicWords.length) return 'generic';
  const words = new Set(topicWords);
  for (const [kind, kindWords] of Object.entries(SUBJECT_KIND_WORDS)) {
    if (Array.from(words).some((word) => kindWords.has(word))) return kind;
  }
  return 'generic';
}

function subjectKindInterpretation(kind, ctx) {
  const subjectKind = subjectKindForInterpretation(ctx);
  return (SUBJECT_KIND_INTERPRETATIONS[subjectKind] && SUBJECT_KIND_INTERPRETATIONS[subjectKind][kind])
    || (SUBJECT_KIND_INTERPRETATIONS.generic && SUBJECT_KIND_INTERPRETATIONS.generic[kind])
    || null;
}

function uniqueInterpretations(values) {
  const seen = new Set();
  const unique = [];
  for (const value of values) {
    const clean = String(value || '').trim().replace(/\s+/g, ' ');
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    unique.push(clean);
  }
  return unique;
}

function joinInterpretations(values) {
  if (values.length <= 1) return values[0] || '';
  if (values.length === 2) return `${values[0]} or ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, or ${values[values.length - 1]}`;
}

function interpretationCandidates(kind, ctx) {
  const domain = kind === 'vague-superlative' || kind === 'missing-first-slice'
    ? subjectKindInterpretation(kind, ctx)
    : null;
  const table = domain || AMBIGUITY_INTERPRETATIONS[kind];
  const candidates = table ? [...table.candidates] : [];
  if (kind === 'missing-audience' && ctx.topic) candidates[0] = `${ctx.topic} owner`;
  if (kind === 'missing-first-slice' && domain && ctx.topic && subjectKindForInterpretation(ctx) !== 'generic') {
    candidates[0] = `${ctx.topic} ${candidates[0]}`;
  }
  if (kind === 'missing-first-slice' && !domain && ctx.topic) candidates[0] = `${ctx.topic} capture path`;
  if (kind === 'missing-first-slice' && !domain && ctx.action) candidates[0] = `${ctx.action} path`;
  return uniqueInterpretations(candidates).slice(0, 3);
}

function recommendedInterpretationIndex(kind, ctx, candidates) {
  const words = new Set(ctx.words);
  if (kind === 'missing-audience') {
    if (words.has('team') || words.has('member')) return Math.min(1, candidates.length - 1);
    if (words.has('customer') || words.has('visitor') || words.has('client')) return Math.min(2, candidates.length - 1);
  }
  if (kind === 'vague-superlative' || kind === 'missing-first-slice') {
    if (['fast', 'faster', 'fastest', 'speed', 'quick', 'quickly'].some((word) => words.has(word))) return 0;
    if (['done', 'finish', 'finished', 'close', 'closure', 'complete', 'ship'].some((word) => words.has(word))) {
      return Math.min(2, candidates.length - 1);
    }
    if (['todo', 'task', 'tasks', 'list', 'backlog', 'inbox', 'remind', 'reminder', 'surface', 'resurface'].some((word) => words.has(word))) {
      return Math.min(1, candidates.length - 1);
    }
  }
  const domain = kind === 'vague-superlative' || kind === 'missing-first-slice'
    ? subjectKindInterpretation(kind, ctx)
    : null;
  const table = domain || AMBIGUITY_INTERPRETATIONS[kind];
  return Math.min(table ? table.recommendedIndex : 0, candidates.length - 1);
}

function recommendedInterpretationName(candidate) {
  return String(candidate || '').replace(/^(?:fastest|smartest|most)\s+/i, '').trim();
}

function interpretationLabel(kind, ctx) {
  if (kind === 'vague-superlative') {
    if (ctx.superlative && ctx.topic) return `${capitalizeFirst(ctx.superlative)} ${ctx.topic}`;
    return capitalizeFirst(ctx.superlative || ctx.topic || 'this');
  }
  const topic = ctx.topic ? `${ctx.topic} ` : '';
  if (kind === 'missing-audience') return capitalizeFirst(`${topic}audience`);
  if (kind === 'missing-first-slice') return capitalizeFirst(`${topic}first slice`);
  return capitalizeFirst(ctx.topic || 'this');
}

function buildInterpretationQuestion(text, subject, kind) {
  const table = AMBIGUITY_INTERPRETATIONS[kind];
  const ctx = interpretationContext(text, subject);
  const candidates = interpretationCandidates(kind, ctx);
  const recommended = recommendedInterpretationName(candidates[recommendedInterpretationIndex(kind, ctx, candidates)]);
  const label = interpretationLabel(kind, ctx);
  return `${label} could mean ${joinInterpretations(candidates)}. I would bet on ${recommended}, so ${table.ask}?`;
}

function buildClarityQuestions(text, subject, vague) {
  if (!vague) return [];
  const questions = [
    buildInterpretationQuestion(text, subject, 'vague-superlative'),
  ];
  if (!AUDIENCE_WORDS.test(text)) {
    questions.push(buildInterpretationQuestion(text, subject, 'missing-audience'));
  }
  questions.push(buildInterpretationQuestion(text, subject, 'missing-first-slice'));
  return questions;
}

function priorQuestionRowForAuditTextAnyQuestion(text, root) {
  const rows = readWishAuditEvents(root)
    .filter((row) => Array.isArray(row && row.questions)
      && row.questions.length
      && rowMatchesAuditText(row, text)
      && String(row.text || '').trim());
  return rows.length ? rows[rows.length - 1] : null;
}

function clarityQuestionSourceText(text, root) {
  if (!activeAnswerContext(root)) return text;
  const row = priorQuestionRowForAuditTextAnyQuestion(text, root);
  return row ? row.text : text;
}

function clarityAudit(text, root = process.cwd()) {
  const sourceText = clarityQuestionSourceText(text, root);
  const words = wordList(sourceText);
  const subject = subjectForWish(sourceText);
  const missing = [];
  const vague = words.length < 4 || !hasVerb(sourceText) || !hasMeaningfulContent(sourceText);

  if (vague) {
    missing.push('outcome');
  }
  if (vague && !AUDIENCE_WORDS.test(sourceText)) {
    missing.push('audience');
  }
  if (vague) {
    missing.push('scope');
  }

  return {
    vague,
    missing,
    questions: buildClarityQuestions(sourceText, subject, vague),
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
  const isSentenceStartPlainWord = (word, index) => {
    const clean = cleanToken(word);
    if (!/^[A-Z][a-z]+$/.test(clean)) return false;
    if (!/^[a-z]+$/.test(clean.toLowerCase())) return false;
    if (index === 0) return true;
    return /[.!?]$/.test(cleanToken(words[index - 1] || ''));
  };
  for (const word of words) {
    if (pathLike(word)) addMissing(word, 'path');
  }

  const keywordPattern = /\b(?:member|repo|repository|file|folder|path)\s+[`'"]?([A-Za-z0-9._/-]+)[`'"]?/gi;
  let match;
  while ((match = keywordPattern.exec(text))) {
    const token = String(match[1] || '');
    if (KEYWORD_VALUE_SKIP.has(token.toLowerCase())) continue;
    if (!isNameShapedToken(token)) continue;
    addMissing(match[1], pathLike(match[1]) ? 'path' : 'proper');
  }

  for (let index = 0; index < words.length; index += 1) {
    const clean = cleanToken(words[index]);
    if (!/^[A-Z][A-Za-z0-9_-]{2,}$/.test(clean)) continue;
    if (PROPER_SKIP.has(clean)) continue;
    if (index === 0 && VERBS.has(clean.toLowerCase())) continue;
    if (isSentenceStartPlainWord(words[index], index)) continue;
    addMissing(clean, 'proper');
  }
  return missing;
}

function cleanPartText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/^[,;:\s]+|[,;:\s]+$/g, '')
    .replace(LEADING_PART_CONNECTORS, '')
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

function tokenSpans(text) {
  const spans = [];
  const source = String(text || '');
  for (const match of source.matchAll(/\S+/g)) {
    spans.push({
      raw: match[0],
      clean: cleanWord(match[0]),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return spans;
}

function fixedCompoundAt(tokens, index) {
  const previous = tokens[index - 1] && tokens[index - 1].clean;
  const current = tokens[index] && tokens[index].clean;
  const next = tokens[index + 1] && tokens[index + 1].clean;
  if (current !== 'and' || !previous || !next) return false;
  return FIXED_AND_COMPOUNDS.has(`${previous} and ${next}`);
}

function partStartsWithVerbPronounObject(tokens, index) {
  const first = tokens[index + 1] && tokens[index + 1].clean;
  const second = tokens[index + 2] && tokens[index + 2].clean;
  return Boolean(first && second && VERBS.has(first) && PART_JOINER_PRONOUN_OBJECTS.has(second));
}

function splitSegmentOnJoiners(segment) {
  const tokens = tokenSpans(segment);
  const cuts = [];
  let betweenPending = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.clean) continue;
    if (token.clean === 'between') {
      betweenPending = true;
      continue;
    }
    if (!PART_JOINER_WORDS.has(token.clean)) continue;

    const next = tokens[index + 1] && tokens[index + 1].clean;
    if (!next) continue;
    if (fixedCompoundAt(tokens, index)) continue;
    if (token.clean === 'plus') {
      const previous = tokens[index - 1] && tokens[index - 1].clean;
      if (PART_JOINER_DETERMINERS.has(previous)) continue;
    }
    if ((token.clean === 'and' || token.clean === 'adn' || token.clean === 'nad' || token.clean === 'annd') && betweenPending) {
      betweenPending = false;
      continue;
    }
    if (PART_JOINER_DETERMINERS.has(next)) continue;
    if (partStartsWithVerbPronounObject(tokens, index)) continue;

    cuts.push({ start: token.start, end: token.end });
  }

  if (!cuts.length) return [segment];

  const parts = [];
  let start = 0;
  for (const cut of cuts) {
    parts.push(segment.slice(start, cut.start));
    start = cut.end;
  }
  parts.push(segment.slice(start));
  return parts;
}

function splitWishText(text, root) {
  const source = String(text || '');
  const segments = source.split(';');
  const semicolonSplit = segments.length > 1;
  const parts = [];
  for (const segment of segments) {
    const cleanSegment = cleanPartText(segment);
    if (!cleanSegment) continue;
    const joinerParts = splitSegmentOnJoiners(segment).map(cleanPartText).filter(Boolean);
    if (joinerParts.length > 1 && joinerParts.every((part) => partLooksDeliverable(part, root))) parts.push(...joinerParts);
    else parts.push(cleanSegment);
  }
  return { parts, semicolonSplit };
}

function partLooksDeliverable(text, root) {
  if (outOfScopeReason(text, root)) return true;
  return hasStandaloneInstructionVerb(text) && meaningfulInstructionWordCount(text) >= 2;
}

function partLooksSemicolonDeliverable(text, root) {
  return partLooksDeliverable(text, root) || meaningfulInstructionWordCount(text) >= 2;
}

function analyzeWishParts(text, root) {
  const clean = cleanPartText(text);
  if (!clean) return null;
  const { parts: rough, semicolonSplit } = splitWishText(clean, root);
  if (rough.length > 1) {
    const validator = semicolonSplit ? partLooksSemicolonDeliverable : partLooksDeliverable;
    if (!rough.every((part) => validator(part, root))) return null;
  }
  const parts = (rough.length > 1 ? rough : [clean])
    .map((part, index) => ({
      part: index + 1,
      text: part,
      waiting_reason: outOfScopeReason(part, root),
    }))
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
  const testWord = '(?:test|tests|testing|tets|tesst)';
  const testAction = '(?:add|write|fix|run|improve)';
  const createsTests = new RegExp(`\\b${testAction}\\b.{0,48}\\b${testWord}\\b`).test(compact);
  const testDeliverable = createsTests
    || /\bkeep\b.{0,32}\btests?\b.{0,32}\bgreen\b/.test(compact)
    || /\b(?:smoke|stress|load)\s+tests?\b/.test(compact)
    || /\btest\s+suite\b/.test(compact)
    || /\b(?:unit|integration)\s+tests?\b/.test(compact)
    || /\bcoverage\b/.test(compact);
  if (testDeliverable && !/\btest\s+(?:of|drive)\b/.test(compact)) {
    return {
      command: TEST_VERIFY_COMMAND,
      outcome: 'the tests pass',
      status: 'derived',
    };
  }
  const commandAction = '(?:add|build|create|write|fix|run|update|install|wire|hook)';
  if (new RegExp(`\\b${commandAction}\\b.{0,48}\\b(?:command|commands|subcommand|subcommands|cli)\\b`).test(compact)
    || new RegExp(`\\b(?:command|commands|subcommand|subcommands)\\b.{0,48}\\b${commandAction}\\b`).test(compact)) {
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
  if (verify === TEST_VERIFY_COMMAND) return 'the tests pass';
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
