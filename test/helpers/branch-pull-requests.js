'use strict';

// The green lander reads every branch's pull requests in one gh graphql call
// per run. These build that call's answer for test fakes.

function isPullRequestLookup(args) {
  return Array.isArray(args) && args[0] === 'api' && args[1] === 'graphql'
    && args.some((a) => /^query=.*pullRequests\(headRefName:/.test(String(a)));
}

// Branch name per alias, read from the -f hN=<branch> fields.
function askedBranches(args) {
  const out = {};
  for (const a of args) {
    const m = /^h(\d+)=(.*)$/s.exec(String(a));
    if (m) out[`b${m[1]}`] = m[2];
  }
  return out;
}

// prsFor(branch) returns that branch's pull requests, newest first.
function pullRequestAnswer(args, prsFor = () => []) {
  const repository = {};
  for (const [alias, branch] of Object.entries(askedBranches(args))) {
    repository[alias] = { nodes: prsFor(branch) || [] };
  }
  return { ok: true, stdout: JSON.stringify({ data: { repository } }), stderr: '' };
}

function pr(fields = {}) {
  return { number: 1, state: 'OPEN', isDraft: false, headRefName: '', headRefOid: '', baseRefName: 'master', isCrossRepository: false, labels: { nodes: [] }, ...fields };
}

// A shell gh stub answer for runs that ask about at most `n` branches.
function emptyAnswerJson(n = 20) {
  const repository = {};
  for (let i = 0; i < n; i += 1) repository[`b${i}`] = { nodes: [] };
  return JSON.stringify({ data: { repository } });
}

module.exports = { isPullRequestLookup, pullRequestAnswer, pr, emptyAnswerJson };
