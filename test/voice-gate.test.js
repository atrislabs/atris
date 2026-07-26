'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { gateForHuman, numberWord, scanText } = require('../lib/voice-gate');
const { taskReviewLanding, taskReviewLandingLines } = require('../commands/task');
const { missionHumanStatusText } = require('../commands/mission');

const RAW_ULID = '01JABCDEFGHJKMNPQRSTVWXYZ12';

test('scanText names every human voice rule with the offending snippet', () => {
  const text = `review_queue calls reviewQueue for CLI-123 in foo.js:12; npm test -> ${RAW_ULID}\u2014done`;
  const findings = scanText(text);
  assert.deepEqual(new Set(findings.map(finding => finding.rule)), new Set([
    'em-dash',
    'agent-jargon',
    'raw-ulid',
    'file-path',
    'shell-command',
  ]));
  assert.ok(findings.every(finding => finding.why && finding.snippet));
});

test('gateForHuman replaces em dashes with plain punctuation', () => {
  const result = gateForHuman('the review is clear\u2014the decision is safe');
  assert.equal(result.text, 'the review is clear, the decision is safe');
  assert.equal(result.ok, true);
});

test('gateForHuman turns snake case and flags into plain words', () => {
  const result = gateForHuman('review_queue supports --dry-run for safer checks');
  assert.equal(result.text, 'review queue supports dry run for safer checks');
  assert.deepEqual(result.issues, []);
});

test('gateForHuman drops a raw ULID only when a readable title replaces it', () => {
  const withoutTitle = gateForHuman(`receipt ${RAW_ULID} passed`);
  assert.equal(withoutTitle.text, `receipt ${RAW_ULID} passed`);
  assert.ok(withoutTitle.issues.some(issue => issue.rule === 'raw-ulid'));

  const withTitle = gateForHuman(`receipt ${RAW_ULID} passed`, { title: 'readable receipt' });
  assert.equal(withTitle.text, 'receipt passed');
  assert.equal(withTitle.issues.some(issue => issue.rule === 'raw-ulid'), false);
});

test('gateForHuman keeps information without a clean substitute and reports it', () => {
  const input = 'keep CLI-123 proof at foo.js:12 and run npm test';
  const result = gateForHuman(input);
  assert.equal(result.text, input);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(issue => issue.rule === 'agent-jargon' && issue.snippet === 'CLI-123'));
  assert.ok(result.issues.some(issue => issue.rule === 'file-path' && issue.snippet === 'foo.js:12'));
  assert.ok(result.issues.some(issue => issue.rule === 'shell-command' && issue.snippet === 'npm test'));
});

test('numberWord spells compact human counts', () => {
  assert.deepEqual(
    [0, 1, 2, 12, 13].map(numberWord),
    ['no', 'one', 'two', 'twelve', '13'],
  );
});

test('task reviews sends landing prose through the human voice gate', () => {
  const lines = taskReviewLandingLines({
    title: 'readable approval result',
    landing: {
      happened: 'review_queue removed --internal-flag noise\u2014operators decide faster',
      reason: 'the approval_path is easier to read',
      checked: 'the review_queue stayed readable',
      tested: 'the task_reviews command stayed readable',
      decision: 'approve this now',
    },
  });
  assert.deepEqual(lines, [
    "   what's new: review queue removed internal flag noise, operators decide faster",
    '   why it matters: the approval path is easier to read',
    '   checked: the review queue stayed readable; tested: the task reviews command stayed readable.',
  ]);
  assert.doesNotMatch(lines.join('\n'), /decision:/i);
});

test('why it matters comes from the landing sentence itself, not a canned line', () => {
  const landing = taskReviewLanding({
    title: 'wire orb menu',
    status: 'review',
    metadata: {
      result: 'Operators can now pick next moves from a terminal menu, so they keep deciding instead of waiting on each job.',
      latest_agent_proof: 'Checks: node --test passed',
    },
  });
  assert.equal(landing.happened, 'Operators can now pick next moves from a terminal menu.');
  assert.equal(landing.reason, 'they keep deciding instead of waiting on each job.');
});

test('a landing with no real why says nothing instead of boilerplate', () => {
  const landing = taskReviewLanding({
    title: 'Mission XP: Build Mission Room with architect',
    status: 'review',
    metadata: { latest_agent_proof: 'Checks: npm run build passed' },
  });
  assert.equal(landing.reason, '');
  const lines = taskReviewLandingLines({
    title: 'Mission XP: Build Mission Room with architect',
    landing,
  });
  assert.doesNotMatch(lines.join('\n'), /why it matters/);
  assert.doesNotMatch(lines.join('\n'), /repeatable check before approval|concrete result the human can approve/);
});

test('an explicit reason wins and the landing sentence stays whole', () => {
  const landing = taskReviewLanding({
    title: 'harden approvals',
    status: 'review',
    metadata: {
      result: 'Approvals now expire after a day, so stale work cannot land itself.',
      review_reason: 'old approvals stop running after their context changes.',
    },
  });
  assert.equal(landing.happened, 'Approvals now expire after a day, so stale work cannot land itself.');
  assert.equal(landing.reason, 'old approvals stop running after their context changes.');
});

test('a mission-bridged landing lifts the receipt sentence instead of echoing the title', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const pathMod = require('node:path');
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'atris-receipt-lift-'));
  try {
    fs.mkdirSync(pathMod.join(dir, 'atris', 'runs'), { recursive: true });
    fs.writeFileSync(pathMod.join(dir, 'atris', 'runs', 'mission-lift.json'), JSON.stringify({
      mission_id: 'm1',
      result: {
        landing: {
          changed: 'Every pitch number now comes from real records, so nothing in the story is estimated.',
          reason: '',
        },
      },
    }));
    const landing = taskReviewLanding({
      title: 'Mission XP: Build Numbers Pack Mission Room',
      status: 'review',
      workspace_root: dir,
      metadata: {
        mission_id: 'm1',
        latest_agent_proof: 'Mission receipt: atris/runs/mission-lift.json; checks passed',
      },
    });
    assert.equal(landing.happened, 'Every pitch number now comes from real records.');
    assert.equal(landing.reason, 'nothing in the story is estimated.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('missionHumanStatusText sends status prose through the human voice gate', () => {
  assert.equal(missionHumanStatusText({ status: 'waiting_for_human' }), 'waiting for human');
});

test('missionHumanStatusText names paused reason instead of remaining budget', () => {
  assert.equal(
    missionHumanStatusText({
      status: 'paused',
      stop_reason: 'stuck-repeating',
      budget_contract: {
        policy: 'spend_full_budget',
        requested_seconds: 8400,
        budget_label: '140 minutes',
      },
      started_at: new Date().toISOString(),
    }),
    'paused: stuck-repeating',
  );
});
