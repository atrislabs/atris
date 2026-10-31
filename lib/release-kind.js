'use strict';

// Why a claim was let go, as a field the rating can read without reading words.
//
// Two kinds exist. Both ride on the release event as fields; the reason text is
// only for people, and nothing ever parses it.
//
// proof_not_saved. The work is done and its pull request is open for a person to
// land, but the proof that says so could not be saved. The builder did its part,
// so the release is neither a landing nor a drop. A release says this by passing
// the kind and the pull request together. The task db refuses half of a marker,
// and the rating reads a release as this kind only when both are there.
//
// could_not_start. The flight let the claim go before the engine ran, because the
// build machine could not start the job (no room on the disk, a build copy that
// would not open, a lease that would not set, a brief that would not save). The
// builder never touched the work, so the release is neither a drop nor a finished
// job. The kind goes alone, with no pull request, and only the flights pass it.
//
// The kind checks itself. A builder shares the task store with the flight, so
// the store and the rating take it only for a claim whose engine was never
// asked. Right before it asks the assigned engine, the flight writes a
// build_started event on the claim (see markBuildStarted in task-db.js). A
// release that carries could_not_start on a claim with that event is an
// ordinary release, and the rating reads it as a drop. Scout and prep passes
// run before the mark, so they never count as the build starting.

const PROOF_NOT_SAVED = 'proof_not_saved';
const COULD_NOT_START = 'could_not_start';
// The event type of that mark.
const BUILD_STARTED = 'build_started';

// True for a release event payload that carries the kind and an open pull
// request it can point at. Anything less is an ordinary release.
function isProofNotSaved(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (payload.kind !== PROOF_NOT_SAVED) return false;
  const pr = payload.pull_request;
  if (!pr || typeof pr !== 'object' || Array.isArray(pr)) return false;
  if (String(pr.state || '').toLowerCase() !== 'open') return false;
  return (Number.isInteger(pr.number) && pr.number > 0) || /^https?:\/\//i.test(String(pr.url || '').trim());
}

// True for a release event payload that carries the could-not-start kind.
// Anything else, including the same words with no field, is an ordinary release.
function isCouldNotStart(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  return payload.kind === COULD_NOT_START;
}

module.exports = { PROOF_NOT_SAVED, COULD_NOT_START, BUILD_STARTED, isProofNotSaved, isCouldNotStart };
