'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeTimes } = require('../scripts/merge-time');

test('measures open to merge separately from the successful final queue entry', () => {
  const entry = { __typename: 'AddedToMergeQueueEvent', createdAt: '2026-11-18T04:01:12Z' };
  const pr = { createdAt: '2026-11-18T04:00:00Z', mergedAt: '2026-11-18T04:02:30Z', timelineItems: { nodes: [entry] } };
  assert.deepEqual(mergeTimes(pr), { open_to_merge_seconds: 150, final_queue_seconds: 78 });
  pr.timelineItems.nodes.push({ __typename: 'RemovedFromMergeQueueEvent', reason: 'merged' });
  assert.deepEqual(mergeTimes(pr), { open_to_merge_seconds: 150, final_queue_seconds: 78 });
  pr.timelineItems.nodes = [entry, { __typename: 'RemovedFromMergeQueueEvent', reason: 'failed_checks' }];
  assert.deepEqual(mergeTimes(pr), { open_to_merge_seconds: 150, final_queue_seconds: null });
  assert.throws(() => mergeTimes({ ...pr, mergedAt: null }), /has not merged/);
});
