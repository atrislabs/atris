'use strict';

const DEFAULT_TASK_RESULT_SENTENCE = 'Operators can now trust completed test work faster because the result is clear.';

function withTaskReadyResult(args, sentence = DEFAULT_TASK_RESULT_SENTENCE) {
  if (!Array.isArray(args) || args[0] !== 'task') return args;
  let next = args;
  if (args[1] === 'ready' && !args.includes('--result')) {
    next = [...next, '--result', sentence];
  }
  // Compact --json omits task/step/handoff fields. Tests that already ask
  // for JSON and then read those fields need the full dump.
  if ((args[1] === 'ready' || args[1] === 'current-step') && next.includes('--json') && !next.includes('--full')) {
    next = [...next, '--full'];
  }
  return next;
}

module.exports = {
  DEFAULT_TASK_RESULT_SENTENCE,
  withTaskReadyResult,
};
