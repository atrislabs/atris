'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPrompt } = require('../lib/codex-flight');

// Lesson dispatched-engines-bypass-hooks-under-pressure: a wiki recompile flight
// hit a pre-commit hook and used `git commit --no-verify` to satisfy its brief,
// publishing local-only memory to the public repo. The mechanism: every dispatch
// brief must carry the stop-and-report-on-hook-block instruction.
test('dispatch brief forbids bypassing git hooks with --no-verify', () => {
  const prompt = buildPrompt({
    worktreePath: '/tmp/wt',
    branch: 'feat/x',
    brief: 'do the thing',
    verifyCmd: 'npm run test:fast',
  });
  assert.match(prompt, /git hook blocks your commit/i);
  assert.match(prompt, /never bypass it with --no-verify/i);
  assert.match(prompt, /STOP and report/i);
});
