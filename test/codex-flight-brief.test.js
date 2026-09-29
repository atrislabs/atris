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

test('dispatch brief orders one concern per PR', () => {
  const prompt = buildPrompt({
    worktreePath: '/tmp/wt',
    branch: 'feat/x',
    brief: 'do the thing',
    verifyCmd: 'npm run test:fast',
  });
  assert.match(prompt, /one concern per PR/i);
  assert.match(prompt, /split anything larger into separate PRs/i);
  assert.match(prompt, /git history guides future agents/i);
  assert.match(prompt, /small PRs are cheap to revert and bisect/i);
});

// Tonight every builder's first draft fixed the path it was pointed at and
// broke a neighbor (another template, a second shell, a sibling writer).
// Both dispatch briefs carry one shared rule list; the text lives once.
test('both dispatch briefs carry the every-path rule from one shared list', () => {
  const fs = require('fs');
  const path = require('path');
  const { SHARED_BRIEF_RULES } = require('../lib/brief-rules');
  const { buildFleetPrompt } = require('../lib/fleet');
  const everyPath = SHARED_BRIEF_RULES.find((rule) => /every path to the thing it protects/.test(rule));
  assert.ok(everyPath, 'shared rules include the every-path line');
  assert.match(everyPath, /test at least one path you were not pointed at/);
  assert.ok(!everyPath.includes(String.fromCharCode(0x2014)), 'no em dash in the rule');
  const codexBrief = buildPrompt({ worktreePath: '/tmp/wt', branch: 'feat/x', brief: 'do the thing' });
  const fleetBrief = buildFleetPrompt({ id: 'T-1', title: 'do the thing. Check: true' }, { worktreePath: '/tmp/wt' });
  for (const rule of SHARED_BRIEF_RULES) {
    assert.ok(codexBrief.split('\n').includes(rule), `codex brief carries: ${rule}`);
    assert.ok(fleetBrief.split('\n').includes(rule), `fleet brief carries: ${rule}`);
    for (const file of ['lib/codex-flight.js', 'lib/fleet.js']) {
      const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      assert.ok(!source.includes(rule.slice(2)), `${file} must not restate shared rule: ${rule}`);
    }
  }
});
