'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { evaluateAutoAccept, parseVerifyCommand, runVerifyCommand } = require('../lib/auto-accept-certified');

function reviewTask(overrides = {}) {
  return {
    id: 'task-1',
    display_id: 'OBL-TEST',
    status: 'review',
    tag: 'self-improve',
    workspace_root: process.cwd(),
    metadata: {
      approval_status: 'pending',
      agent_certified: true,
      agent_review_pass_count: 2,
      latest_agent_proof: 'npm run test:team-overall passed; git diff --check passed',
      verify: 'npm run test:team-overall',
      ...overrides.metadata,
    },
    review: {
      approval_status: 'pending',
      agent_certified: true,
      agent_review_pass_count: 2,
      proof: 'npm run test:team-overall passed; git diff --check passed',
      ...overrides.review,
    },
    events: overrides.events || [
      { event_type: 'proof_ready', actor: 'codex' },
      { event_type: 'reviewed', actor: 'validator' },
    ],
    ...(overrides.tag ? { tag: overrides.tag } : {}),
  };
}

test('accepts certified review with two actors and meaningful proof', () => {
  const result = evaluateAutoAccept(reviewTask());
  assert.equal(result.eligible, true);
  assert.equal(result.policy, '2_actors_2_passes');
});

test('accepts third pass even with one actor', () => {
  const base = reviewTask();
  const result = evaluateAutoAccept({
    ...base,
    metadata: { ...base.metadata, agent_review_pass_count: 3 },
    review: { ...base.review, agent_review_pass_count: 3 },
    events: [{ event_type: 'proof_ready', actor: 'codex' }],
  });
  assert.equal(result.eligible, true);
  assert.equal(result.policy, '3_passes');
});

test('rejects denied tags and weak proof', () => {
  assert.equal(evaluateAutoAccept(reviewTask({ tag: 'voice' })).eligible, false);
  assert.equal(evaluateAutoAccept(reviewTask({
    metadata: { latest_agent_proof: 'done' },
    review: { proof: 'done' },
  })).eligible, false);
});

test('rejects single actor with only two passes', () => {
  const result = evaluateAutoAccept(reviewTask({
    events: [{ event_type: 'proof_ready', actor: 'codex' }],
  }));
  assert.equal(result.eligible, false);
  assert.match(result.reason, /second_reviewer_or_third_pass/);
});

test('strict verify rejects compound shell commands', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-verify-'));
  const target = path.join(dir, 'pwned');
  const result = runVerifyCommand(`node --check lib/auto-accept-certified.js; echo pwned > ${target}`, process.cwd());
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'verify_command_not_allowed');
  assert.equal(fs.existsSync(target), false);
});

test('strict verify parser rejects path and npm config escapes', () => {
  assert.deepEqual(parseVerifyCommand('node --check lib/auto-accept-certified.js'), {
    ok: true,
    argv: ['node', '--check', 'lib/auto-accept-certified.js'],
  });
  assert.equal(parseVerifyCommand('node scripts/../../tmp/pwn.js').ok, false);
  assert.equal(parseVerifyCommand('node --test ../../tmp/pwn.js').ok, false);
  assert.equal(parseVerifyCommand('npm run --script-shell=/bin/sh').ok, false);
  assert.equal(parseVerifyCommand('npm run test --prefix=/tmp/evil').ok, false);
  assert.equal(parseVerifyCommand('npm test --script-shell=scripts/malsh').ok, false);
  assert.equal(parseVerifyCommand('tsc --project=/tmp/evil/tsconfig.json').ok, false);
  assert.equal(parseVerifyCommand('git diff --check --output=/tmp/x').ok, false);
  assert.equal(parseVerifyCommand('node --test --test-reporter-destination=/tmp/x').ok, false);
  assert.equal(parseVerifyCommand('node --check --require=/tmp/pwn.js').ok, false);
  assert.equal(parseVerifyCommand('node --check file:///tmp/pwn.js').ok, false);
});
