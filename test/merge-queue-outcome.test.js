'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readMergeQueueOutcome } = require('../lib/merge-queue-outcome');

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const group = 'c'.repeat(40);
const at = '2026-11-17T12:25:42Z';

function example(event, extra = {}) {
  return {
    state: 'OPEN', headRefOid: head, baseRefName: 'master', isInMergeQueue: false, autoMergeRequest: null,
    timelineItems: { nodes: event ? [event] : [] }, ...extra,
  };
}
function removed(reason, commit) {
  return { __typename: 'RemovedFromMergeQueueEvent', createdAt: at, reason, beforeCommit: commit };
}
function failedCommit(checks) {
  return { oid: group, parents: { nodes: [{ oid: base }, { oid: head }] }, statusCheckRollup: { contexts: { nodes: checks } } };
}
function outcome(pr) {
  const runGh = () => ({ ok: true, stdout: JSON.stringify({ data: { repository: { pullRequest: pr } } }) });
  return readMergeQueueOutcome(runGh, '.', {}, 7, head);
}

test('a failed group identifies the tested base, PR head, failing checks and a later retry request', () => {
  const commit = failedCommit([
    { name: 'unit', conclusion: 'FAILURE', detailsUrl: 'https://github.com/test/unit' },
    { context: 'lint', state: 'ERROR', targetUrl: 'https://github.com/test/lint' },
    { name: 'quick', conclusion: 'SUCCESS' },
  ]);
  const pr = example(removed('failed_checks', commit), { autoMergeRequest: { enabledAt: '2026-11-17T13:15:25Z' } });
  assert.deepEqual(outcome(pr), {
    kind: 'failed', baseRefName: 'master', reason: 'failed_checks', at, requested: true, group, base,
    checks: [{ name: 'unit', link: 'https://github.com/test/unit' }, { name: 'lint', link: 'https://github.com/test/lint' }],
  });
  pr.autoMergeRequest.enabledAt = '2026-11-17T12:15:20Z';
  assert.equal(outcome(pr).requested, false);
  commit.statusCheckRollup = null;
  assert.deepEqual(outcome(pr).checks, []);
});

test('current queue membership supersedes old failures and each non-failure retains its reason', () => {
  const event = removed('invalid_merge_commit', null);
  assert.deepEqual(outcome(example(event, { isInMergeQueue: true })), { kind: 'queued', baseRefName: 'master' });
  assert.deepEqual(outcome(example(event)), { kind: 'removed', baseRefName: 'master', reason: 'invalid_merge_commit', at, requested: false });
  assert.deepEqual(outcome(example(null)), { kind: 'outside', baseRefName: 'master', requested: false });
});

test('different heads, ambiguous parents, contradictory and unreadable replies never establish a group failure', () => {
  const commit = failedCommit([]);
  const pr = example(removed('failed_checks', commit));
  assert.equal(outcome({ ...pr, headRefOid: base }).kind, 'unknown');
  assert.equal(outcome({ ...pr, state: 'CLOSED' }).kind, 'unknown');
  commit.parents.nodes.reverse();
  assert.equal(outcome(pr).kind, 'unknown');
  assert.equal(outcome(example({ __typename: 'AddedToMergeQueueEvent' })).kind, 'unknown');
  for (const read of [{ ok: false }, { ok: true, stdout: '{' }, { ok: true, stdout: '{"errors":[{}]}' }]) {
    assert.deepEqual(readMergeQueueOutcome(() => read, '.', {}, 7, head), { kind: 'unknown' });
  }
});
