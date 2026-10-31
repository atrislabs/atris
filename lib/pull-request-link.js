'use strict';

// A pull request link, read the one way everything that compares links reads it. The task store
// (which pull request a job points at) and the held-job sweep (which pull request GitHub answered
// for) both use it, so the two cannot disagree about what a link names.
//
// The link is https://<host>/<owner>/<name>/pull/<number>, however a person decorated it: a
// trailing slash, /files, a query string, a fragment, any case. A link with no number, or a number
// that is not a positive whole number, names no pull request.
//
//   repo      the owner and name, in lower case
//   number    the pull request number
//   repoLink  the repository's own address, as the link spells it

const PULL_REQUEST_LINK = /^(https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+))\/pull\/(\d+)(?:[/?#]\S*)?$/i;

function pullRequestOfLink(link) {
  const match = PULL_REQUEST_LINK.exec(String(link || '').trim());
  if (!match) return null;
  const number = Number(match[4]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { repo: `${match[2]}/${match[3]}`.toLowerCase(), number, repoLink: match[1] };
}

module.exports = { pullRequestOfLink };
