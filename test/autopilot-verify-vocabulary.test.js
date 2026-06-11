const { test } = require('node:test');
const assert = require('node:assert');

const { validateVerifyCommandShape } = require('../commands/autopilot');

// T34: status-vocabulary lint. The task plane's listable statuses are
// open|claimed|review|done|failed; `ready` is a transition, never a listable
// state, so a drafted Verify carrying `--status ready` must be rejected at
// adoption time with the corrected form (--status review) suggested.

test('--status ready is rejected with review suggested', () => {
  const result = validateVerifyCommandShape('atris task list --status ready | grep -q TRR-20');
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /--status ready/);
  assert.match(result.reason, /--status review/);
  assert.match(result.reason, /open\|claimed\|review\|done\|failed/);
});

test('listable statuses pass the lint', () => {
  for (const status of ['open', 'claimed', 'review', 'done', 'failed']) {
    const result = validateVerifyCommandShape(`atris task list --status ${status} | grep -q TRR-20`);
    assert.strictEqual(result.ok, true, `--status ${status} should be listable`);
  }
});

test('unknown status is rejected with the vocabulary listed', () => {
  const result = validateVerifyCommandShape('atris task queue --status pending');
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /--status pending/);
  assert.match(result.reason, /open\|claimed\|review\|done\|failed/);
});

test('Verify with no atris task reference is untouched', () => {
  const result = validateVerifyCommandShape('test -f atris/TODO.md && grep -q ready atris/TODO.md');
  assert.strictEqual(result.ok, true);
});

test('compound Verify with a bad status in a later segment is caught', () => {
  const result = validateVerifyCommandShape(
    'atris task list --status done | grep -q TRR-19 || atris task list --status ready | grep -q TRR-19'
  );
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /--status ready/);
  assert.match(result.reason, /--status review/);
});

test('queue and current subcommands are linted like list', () => {
  for (const sub of ['queue', 'current']) {
    const result = validateVerifyCommandShape(`atris task ${sub} --status ready`);
    assert.strictEqual(result.ok, false, `atris task ${sub} --status ready should be rejected`);
  }
});

test('atris task segment without --status passes', () => {
  const result = validateVerifyCommandShape('atris task list | grep -q TRR-20');
  assert.strictEqual(result.ok, true);
});

test('--status=ready equals form is caught', () => {
  const result = validateVerifyCommandShape('atris task list --status=ready');
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /--status review/);
});
