'use strict';

const DEFAULT_TASK_RESULT_SENTENCE = 'Operators can now trust completed test work faster because the result is clear.';

function withTaskReadyResult(args, sentence = DEFAULT_TASK_RESULT_SENTENCE) {
  if (Array.isArray(args) && args[0] === 'task' && args[1] === 'ready' && !args.includes('--result')) {
    return [...args, '--result', sentence];
  }
  return args;
}

module.exports = {
  DEFAULT_TASK_RESULT_SENTENCE,
  withTaskReadyResult,
};
