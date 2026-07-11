'use strict';

const {
  analyzeWishParts,
  auditWish,
  deriveVerifyPlan,
  inferBudgetTier,
  missingNamedInputs,
  sharesMeaningfulWords,
  verifyOutcomeText,
  withWishAnswerAuditContext,
} = require('../lib/wish-audit');
const {
  appendWishRecord,
  improveWishes,
  nextWishNumber,
  readWishEvents,
  readWishes,
  stampIso,
  stateFile,
  wishLessonsSummary,
  wishId,
} = require('../lib/wish-store');
const {
  answerWish,
  captureWishToJournal,
  grantWish,
  printBoard,
  printList,
  printReviewNudges,
  printRewards,
  reviewWish,
  runAgainWish,
  parseMetricExpression,
  runCapturedWish,
  sayWish,
  sweepWishes,
  waitingOperatorWishes,
  REVIEW_WORD_SCORES,
} = require('../lib/wish-delegate');
const { enqueueCloudMission, VALID_CLOUD_LANES } = require('../lib/cloud-mission');
const { printWishStats } = require('../lib/wish-stats');

function showHelp() {
  console.log('');
  console.log('Usage: atris wish "<plain sentence>" [--engine <id>] [--as builder] [--metric "<name><op><target>"] [--json] [--no-mission]');
  console.log('       atris wish "<plain sentence>" --cloud [--lane fast|pro|max] [--agent <id>]');
  console.log('         --metric example: --metric "stripe.active_subs>=10" (ops: >=, >, <=, <, ==)');
  console.log('       atris wish list [--all]');
  console.log('       atris wish show <n|id>');
  console.log('       atris wish board');
  console.log('       atris wish answer "<your answer>" [--engine <id>] [--json] [--no-mission]');
  console.log('       atris wish grant <n> "<answer>" [--engine <id>] [--json] [--no-mission]');
  console.log('       atris wish say "<note>" [wish-id]');
  console.log('       atris wish close <n|id> [<n|id> ...]');
  console.log('       atris wish again <id> "<tweak text>" [--engine <id>]');
  console.log('       atris wish review [<id>|latest] "<one sentence>" [--score <-1|0|1 or 1-5>]');
  console.log('       atris wish rewards');
  console.log('       atris wish stats [--write]');
  console.log('       atris wish improve');
  console.log('       atris wish lessons');
  console.log('');
}

function cleanWishShowRef(value) {
  return String(value || '').trim().replace(/^#/, '');
}

function wishShowHint(value) {
  const suffix = cleanWishShowRef(value);
  return suffix && /^\d+$/.test(suffix)
    ? `Use: atris wish show ${suffix}`
    : 'Usage: atris wish show <n|id>';
}

function wishHistoryRows(root, wish) {
  return readWishEvents(root).filter((event) => {
    if (!event) return false;
    if (event.id && event.id === wish.id) return true;
    return event.wish_id && event.wish_id === wish.id;
  });
}

function printWishShow(root, rawRef) {
  const ref = cleanWishShowRef(rawRef);
  if (!ref) {
    console.error(wishShowHint(rawRef));
    return 2;
  }
  const number = Number(ref);
  const wishes = readWishes(root);
  const wish = Number.isInteger(number) && number > 0
    ? wishes.find((row) => Number(row.n) === number)
    : wishes.find((row) => String(row.id || '') === ref);
  if (!wish) {
    console.error(`No wish found for ${rawRef}. Try: atris wish list --all`);
    return 1;
  }
  const questions = Array.isArray(wish.questions) ? wish.questions.filter(Boolean) : [];
  console.log(`Wish #${wish.n || '?'} ${wish.id}`);
  console.log(`ID: ${wish.id}`);
  console.log(`Status: ${wish.status || 'unknown'}`);
  console.log(`Text: ${wish.text || ''}`);
  console.log('Questions:');
  if (questions.length) questions.forEach((question) => console.log(`- ${question}`));
  else console.log('- none');
  console.log('Rows:');
  const history = wishHistoryRows(root, wish);
  if (!history.length) console.log('- none');
  history.forEach((event, index) => {
    const parts = [event.ts || 'unknown-time', event.kind || event.status || 'event'];
    if (event.answer) parts.push(`answer: ${event.answer}`);
    if (event.review_text) parts.push(`review: ${event.review_text}`);
    if (event.note) parts.push(`note: ${event.note}`);
    if (Array.isArray(event.filled_slots) && event.filled_slots.length) {
      parts.push(`filled: ${event.filled_slots.map((slot) => slot.value).join(', ')}`);
    }
    console.log(`- row ${index + 1}: ${parts.join(' | ')}`);
    console.log(`  text: ${event.text || wish.text || ''}`);
    console.log(`  status: ${event.status || event.kind || 'event'}`);
    const rowQuestions = Array.isArray(event.questions) ? event.questions.filter(Boolean) : [];
    console.log(`  questions: ${rowQuestions.length ? rowQuestions.join(' | ') : 'none'}`);
    console.log(`  history: ${parts.slice(2).join(' | ') || 'none'}`);
  });
  return 0;
}

function closeWishes(root, refs) {
  const cleaned = refs.map(cleanWishShowRef).filter(Boolean);
  if (!cleaned.length) {
    console.error('Usage: atris wish close <n|id> [<n|id> ...]');
    return 2;
  }
  const wishes = readWishes(root);
  const closedBy = process.env.ATRIS_AGENT_ID || process.env.USER || 'operator';
  let missing = 0;
  for (const ref of cleaned) {
    const number = Number(ref);
    const wish = Number.isInteger(number) && number > 0
      ? wishes.find((row) => Number(row.n) === number)
      : wishes.find((row) => String(row.id || '') === ref);
    if (!wish) {
      console.error(`No wish found for ${ref}. Try: atris wish list --all`);
      missing += 1;
      continue;
    }
    if (String(wish.status || '') === 'closed') {
      console.log(`Wish #${wish.n || '?'} is already closed.`);
      continue;
    }
    appendWishRecord(root, {
      id: wish.id,
      n: wish.n || undefined,
      ts: stampIso(),
      text: wish.text || undefined,
      kind: 'close',
      status: 'closed',
      closed_by: closedBy,
    });
    console.log(`Closed wish #${wish.n || '?'}: ${String(wish.text || '').slice(0, 60)}`);
  }
  return missing ? 1 : 0;
}

function appendFilledAnswerSlot(root, context) {
  if (!context || !context.filled_slot || !context.wish_id) return;
  appendWishRecord(root, {
    id: context.wish_id,
    n: context.n || undefined,
    ts: stampIso(),
    text: context.text || undefined,
    kind: 'slot',
    filled_slots: [context.filled_slot],
  });
}

function unquote(value) {
  const text = String(value);
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function parseFlagArgs(args, valueFlagNames = []) {
  const valueFlags = new Set(valueFlagNames);
  const values = {};
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i] || '');
    if (arg.startsWith('--')) {
      const flagName = arg.split('=')[0];
      if (valueFlags.has(flagName)) {
        const prefix = flagName + '=';
        if (arg.startsWith(prefix)) values[flagName] = unquote(arg.slice(prefix.length));
        else if (args[i + 1] && !String(args[i + 1]).startsWith('--')) {
          values[flagName] = unquote(args[i + 1]);
          i += 1;
        }
      }
      continue;
    }
    positionals.push(args[i]);
  }
  return { positionals, values };
}

function wishOptions(args) {
  const cloud = args.includes('--cloud');
  const parsed = parseFlagArgs(args, cloud
    ? ['--engine', '--as', '--metric', '--lane', '--agent']
    : ['--engine', '--as', '--metric']);
  return {
    asJson: args.includes('--json'),
    cloud,
    noMission: args.includes('--no-mission'),
    asMode: String(parsed.values['--as'] || '').trim(),
    agentId: String(parsed.values['--agent'] || '').trim(),
    engineOverride: String(parsed.values['--engine'] || '').trim(),
    lane: String(parsed.values['--lane'] || '').trim() || 'fast',
    metricRaw: String(parsed.values['--metric'] || '').trim(),
    positionals: parsed.positionals,
  };
}

function cloudWishOptionError(args, options) {
  if (args.some((arg) => String(arg) === '--lane=')) {
    return '--lane requires one of: fast, pro, max';
  }
  const laneIndex = args.findIndex((arg) => String(arg) === '--lane');
  if (laneIndex >= 0 && (!args[laneIndex + 1] || String(args[laneIndex + 1]).startsWith('--'))) {
    return '--lane requires one of: fast, pro, max';
  }
  const agentIndex = args.findIndex((arg) => String(arg) === '--agent');
  if (args.some((arg) => String(arg) === '--agent=')) return '--agent requires an agent id';
  if (agentIndex >= 0 && (!args[agentIndex + 1] || String(args[agentIndex + 1]).startsWith('--'))) {
    return '--agent requires an agent id';
  }
  if (!VALID_CLOUD_LANES.has(options.lane)) {
    return `invalid --lane "${options.lane}". expected fast, pro, or max`;
  }
  return '';
}

async function runCloudWish(text, root, options, deps = {}) {
  try {
    const mission = await enqueueCloudMission({
      text,
      lane: options.lane,
      ...(options.agentId ? { agentId: options.agentId } : {}),
    }, deps);
    const ts = deps.ts || stampIso();
    const record = {
      id: deps.wishId || wishId(text, ts),
      n: nextWishNumber(root),
      ts,
      text,
      status: 'delegated',
      dispatched_at: ts,
      cloud: true,
      task_id: mission.task_id,
      lane: mission.lane || options.lane,
    };
    captureWishToJournal(text, root);
    appendWishRecord(root, record);
    const log = deps.log || console.log;
    log(`task_id: ${record.task_id}`);
    log(`watch: atris mission status --cloud ${record.task_id} --watch`);
    return 0;
  } catch (error) {
    (deps.error || console.error)(error.message || String(error));
    return error.exitCode || 1;
  }
}

// Parses --metric into options.metric; returns an error message on malformed input.
function resolveMetricOption(options) {
  if (!options.metricRaw) return null;
  const parsed = parseMetricExpression(options.metricRaw);
  if (!parsed.ok) return parsed.message;
  options.metric = parsed;
  return null;
}

function parseReviewScore(args) {
  const hasScore = args.some((arg) => {
    const text = String(arg || '');
    return text === '--score' || text.startsWith('--score=');
  });
  if (!hasScore) return { ok: true, value: null };
  const parsed = parseFlagArgs(args, ['--score']);
  const raw = String(parsed.values['--score'] || '').trim();
  const allowed = new Set([-1, 0, 1, 2, 3, 4, 5]);
  const value = Number(raw);
  if (!raw || !Number.isInteger(value) || !allowed.has(value)) {
    return {
      ok: false,
      message: 'wish review --score needs one of -1, 0, 1, 2, 3, 4, or 5.',
    };
  }
  return { ok: true, value };
}

function reviewOptions(args) {
  const parsed = parseFlagArgs(args, ['--score']);
  return {
    score: parseReviewScore(args),
    positionals: parsed.positionals,
  };
}

function printLessons(root) {
  const summary = wishLessonsSummary(root);
  console.log('');
  console.log(`Wish lessons: ${summary.reviews} scored reviews, average ${summary.avg_all === null ? 'none yet' : summary.avg_all} (last 5: ${summary.avg_last5 === null ? 'none yet' : summary.avg_last5})`);
  console.log('');
  console.log(summary.lessons.length ? 'Alive:' : 'Alive: none yet. Review a wish and the next run distills your review into a lesson.');
  for (const line of summary.lessons) console.log(`  ${line}`);
  if (summary.pruned.length) {
    console.log('');
    console.log('Pruned (did not move the score):');
    for (const line of summary.pruned) console.log(`  ${line}`);
  }
  if (summary.inbox) {
    console.log('');
    console.log(`Inbox: ${summary.inbox} raw review${summary.inbox === 1 ? '' : 's'} waiting to be distilled on the next wish.`);
  }
  console.log('');
  return 0;
}

function wishCommand(args = [], deps = {}) {
  const first = String(args[0] || '').trim();
  if (!first) {
    showHelp();
    printReviewNudges(process.cwd());
    return 2;
  }
  if (first === '--help' || first === '-h' || first === 'help') {
    showHelp();
    return 0;
  }
  if (first === 'show') {
    return printWishShow(process.cwd(), args[1]);
  }
  if (first === 'close') {
    return closeWishes(process.cwd(), args.slice(1));
  }
  if ((first === 'status' || first === 'get') && /^\#?\d+$/.test(String(args[1] || '').trim())) {
    console.error(wishShowHint(args[1]));
    return 2;
  }
  if (first === 'get') {
    console.error(wishShowHint(args[1]));
    return 2;
  }
  if (first === 'list' || first === 'ls' || first === 'status') {
    return printList(process.cwd(), { all: args.includes('--all') });
  }
  if (first === 'board') {
    return printBoard(process.cwd());
  }
  if (first === 'rewards') {
    return printRewards(process.cwd());
  }
  if (first === 'stats') {
    return printWishStats(process.cwd(), { write: args.includes('--write') });
  }
  if (first === 'improve') {
    return improveWishes(process.cwd());
  }
  if (first === 'lessons') {
    return printLessons(process.cwd());
  }
  if (first === 'again') {
    const options = wishOptions(args);
    if (options.asMode && options.asMode !== 'builder') {
      console.error('wish --as only supports builder.');
      return 2;
    }
    return runAgainWish(options.positionals, process.cwd(), options);
  }
  if (first === 'answer') {
    const options = wishOptions(args);
    const root = process.cwd();
    const context = {
      root,
      answer: options.positionals.slice(1).join(' ').trim(),
    };
    const code = withWishAnswerAuditContext(context, () => answerWish(options.positionals, root, options));
    if (code !== 2) appendFilledAnswerSlot(root, context);
    return code;
  }
  if (first === 'grant') {
    const options = wishOptions(args);
    return grantWish(options.positionals, process.cwd(), options);
  }
  if (first === 'review') {
    const options = reviewOptions(args);
    if (!options.score.ok) {
      console.error(options.score.message);
      return 2;
    }
    const reviewResult = reviewWish(options.positionals, process.cwd(), { reviewScore: options.score.value });
    if (reviewResult === 0) {
      try {
        improveWishes(process.cwd(), { quiet: true });
      } catch {
        // best-effort: lessons ingest must never fail a review
      }
    }
    return reviewResult;
  }
  if (first === 'say') {
    return sayWish(args, process.cwd());
  }
  const options = wishOptions(args);
  if (options.cloud) {
    const optionError = cloudWishOptionError(args, options);
    if (optionError) {
      (deps.error || console.error)(optionError);
      return 2;
    }
  }
  if (options.asMode && options.asMode !== 'builder') {
    console.error('wish --as only supports builder.');
    return 2;
  }
  const metricError = resolveMetricOption(options);
  if (metricError) {
    console.error(metricError);
    return 2;
  }
  // "atris wish claim <text>" is command confusion; the word claim is not part of the wish.
  const positionals = first === 'claim' && options.positionals.length > 1
    ? options.positionals.slice(1)
    : options.positionals;
  const text = positionals.join(' ').trim();
  if (!text) {
    showHelp();
    return 2;
  }
  if (options.cloud) return runCloudWish(text, process.cwd(), options, deps);
  return runCapturedWish(text, process.cwd(), options);
}

module.exports = {
  wishCommand,
  analyzeWishParts,
  auditWish,
  captureWishToJournal,
  deriveVerifyPlan,
  improveWishes,
  inferBudgetTier,
  missingNamedInputs,
  printBoard,
  printReviewNudges,
  printRewards,
  readWishEvents,
  readWishes,
  runCloudWish,
  runAgainWish,
  sayWish,
  sharesMeaningfulWords,
  stateFile,
  sweepWishes,
  verifyOutcomeText,
  withWishAnswerAuditContext,
  waitingOperatorWishes,
  REVIEW_WORD_SCORES,
};
