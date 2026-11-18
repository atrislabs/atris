'use strict';

const { latestChecks, isFailingCheck } = require('../commands/caretaker');

// Pull request checks cover its quick run. GitHub attaches the final tests
// and their links to the temporary merge commit in the removal event.
const QUERY = `query($owner:String!, $name:String!, $number:Int!) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$number) {
      state headRefOid baseRefName isInMergeQueue autoMergeRequest { enabledAt }
      timelineItems(last:1, itemTypes:[ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT]) {
        nodes {
          __typename
          ... on RemovedFromMergeQueueEvent {
            reason createdAt
            beforeCommit {
              oid parents(first:3) { nodes { oid } }
              statusCheckRollup { contexts(first:100) { nodes {
                ... on CheckRun { name status conclusion detailsUrl startedAt completedAt }
                ... on StatusContext { context state targetUrl submittedAt:createdAt }
              } } }
            }
          }
        }
      }
    }
  }
}`;

const SHA = /^[a-f0-9]{40,64}$/;

function readMergeQueueOutcome(runGh, root, env, number, expectedHead) {
  const unknown = { kind: 'unknown' };
  if (!Number.isSafeInteger(number) || number < 1 || !SHA.test(expectedHead || '')) return unknown;
  let pr;
  try {
    const read = runGh(['api', 'graphql', '-F', 'owner={owner}', '-F', 'name={repo}',
      '-F', `number=${number}`, '-f', `query=${QUERY}`], root, env);
    if (!read.ok) return unknown;
    const response = JSON.parse(read.stdout);
    if (response.errors?.length) return unknown;
    pr = response.data?.repository?.pullRequest;
  } catch {
    return unknown;
  }
  if (pr?.state !== 'OPEN' || pr.headRefOid !== expectedHead || !pr.baseRefName) return unknown;
  const { baseRefName } = pr;
  if (pr.isInMergeQueue === true) return { kind: 'queued', baseRefName };
  if (pr.isInMergeQueue !== false || !Array.isArray(pr.timelineItems?.nodes)) return unknown;
  const requestedAt = Date.parse(pr.autoMergeRequest?.enabledAt);
  if (pr.autoMergeRequest && !Number.isFinite(requestedAt)) return unknown;
  if (!pr.timelineItems.nodes.length) return { kind: 'outside', baseRefName, requested: Boolean(pr.autoMergeRequest) };
  const event = pr.timelineItems.nodes[0];
  if (event?.__typename !== 'RemovedFromMergeQueueEvent' || !event.reason || !Number.isFinite(Date.parse(event.createdAt))) return unknown;
  const fields = { baseRefName, reason: event.reason, at: event.createdAt, requested: requestedAt > Date.parse(event.createdAt) };
  if (event.reason !== 'failed_checks') return { kind: 'removed', ...fields };

  // For a GitHub merge commit its first parent is the tested base (which
  // can contain earlier entries). Its second parent must be this PR head.
  const group = event.beforeCommit;
  const parents = group?.parents?.nodes;
  if (!SHA.test(group?.oid || '') || parents?.length !== 2
      || !SHA.test(parents[0]?.oid || '') || parents[1]?.oid !== expectedHead) return unknown;
  const checks = latestChecks(group.statusCheckRollup?.contexts?.nodes).filter(isFailingCheck)
    .map(check => ({ name: check.name || check.context, link: check.detailsUrl || check.targetUrl || '' }));
  return { kind: 'failed', ...fields, group: group.oid, base: parents[0].oid, checks };
}

module.exports = { readMergeQueueOutcome };
