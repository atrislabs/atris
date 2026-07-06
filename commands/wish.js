'use strict';

const {
  analyzeWishParts,
  auditWish,
  deriveVerifyPlan,
  inferBudgetTier,
  missingNamedInputs,
  sharesMeaningfulWords,
  verifyOutcomeText,
} = require('../lib/wish-audit');
const { readWishEvents, readWishes, stateFile } = require('../lib/wish-store');
const {
  captureWishToJournal,
  grantWish,
  printList,
  reviewWish,
  runCapturedWish,
  sweepWishes,
  waitingOperatorWishes,
} = require('../lib/wish-delegate');

function showHelp() {
  console.log('');
  console.log('Usage: atris wish "<plain sentence>" [--engine <id>] [--json] [--no-mission]');
  console.log('       atris wish list');
  console.log('       atris wish grant <n> "<answer>" [--engine <id>] [--json] [--no-mission]');
  console.log('       atris wish review [<id>|latest] "<one sentence>" [--score <-1|0|1 or 1-5>]');
  console.log('');
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
  const parsed = parseFlagArgs(args, ['--engine']);
  return {
    asJson: args.includes('--json'),
    noMission: args.includes('--no-mission'),
    engineOverride: String(parsed.values['--engine'] || '').trim(),
    positionals: parsed.positionals,
  };
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
    const options = wishOptions(args);
    return grantWish(options.positionals, process.cwd(), options);
  }
  if (first === 'review') {
    const options = reviewOptions(args);
    if (!options.score.ok) {
      console.error(options.score.message);
      return 2;
    }
    return reviewWish(options.positionals, process.cwd(), { reviewScore: options.score.value });
  }
  const options = wishOptions(args);
  const text = options.positionals.join(' ').trim();
  if (!text) {
    showHelp();
    return 2;
  }
  return runCapturedWish(text, process.cwd(), options);
}

module.exports = {
  wishCommand,
  analyzeWishParts,
  auditWish,
  captureWishToJournal,
  deriveVerifyPlan,
  inferBudgetTier,
  missingNamedInputs,
  readWishEvents,
  readWishes,
  sharesMeaningfulWords,
  stateFile,
  sweepWishes,
  verifyOutcomeText,
  waitingOperatorWishes,
};
