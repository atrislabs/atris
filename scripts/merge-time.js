'use strict';

const { execFileSync } = require('node:child_process');

const query = `query($owner:String!, $repo:String!, $number:Int!) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      createdAt mergedAt
      timelineItems(last:2, itemTypes:[ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT]) {
        nodes { __typename ... on AddedToMergeQueueEvent { createdAt } ... on RemovedFromMergeQueueEvent { reason } }
      }
    }
  }
}`;

function mergeTimes(pr) {
  if (!pr?.mergedAt) throw new Error('this pull request has not merged');
  const secondsSince = start => {
    const seconds = (Date.parse(pr.mergedAt) - Date.parse(start)) / 1000;
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error('invalid merge timestamps');
    return seconds;
  };
  const events = pr.timelineItems?.nodes || [];
  const last = events.at(-1);
  const event = last?.__typename === 'RemovedFromMergeQueueEvent' && last.reason === 'merged' ? events.at(-2) : last;
  return {
    open_to_merge_seconds: secondsSince(pr.createdAt),
    final_queue_seconds: event?.__typename === 'AddedToMergeQueueEvent' ? secondsSince(event.createdAt) : null,
  };
}

if (require.main === module) {
  try {
    const [number] = process.argv.slice(2);
    if (!/^[1-9]\d*$/.test(number) || process.argv.length !== 3) throw new Error('use node scripts/merge-time.js <pull request number>');
    const result = execFileSync('gh', ['api', 'graphql', '-F', 'owner={owner}', '-F', 'repo={repo}', '-F', `number=${number}`, '-f', `query=${query}`], { encoding: 'utf8' });
    console.log(JSON.stringify(mergeTimes(JSON.parse(result).data.repository.pullRequest)));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

module.exports = { mergeTimes };
