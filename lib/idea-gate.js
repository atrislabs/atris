'use strict';

// The two gates every idea passes before it lands, kept apart from the tick
// so the loop cannot loosen them: a built change that edits this file is
// refused before landing (see JUDGE_PATHS in lib/idea-inbox.js).

const FORBIDDEN_SHIP_FLAGS = Object.freeze(['--force', '--force-with-lease', '--no-verify', '-f']);

// The builder and the reviewer must be two different engines, and the
// reviewer must have passed the change. One-lap enforces this already; the
// tick checks it again so a change can never land on its builder's word.
function secondReviewerSignedOff(lap) {
  const validator = lap && lap.result && lap.result.validator_result;
  return Boolean(validator
    && validator.passed === true
    && validator.independent === true
    && validator.engine
    && validator.executor_engine
    && validator.engine !== validator.executor_engine);
}

// Landing never force-pushes and never skips hooks.
function assertSafeShipArgs(args) {
  for (const flag of FORBIDDEN_SHIP_FLAGS) {
    if (args.includes(flag)) throw new Error(`refusing to land with ${flag}`);
  }
  return args;
}

module.exports = {
  assertSafeShipArgs,
  secondReviewerSignedOff,
};
