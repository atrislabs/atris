'use strict';

// Why a claim was let go, as a field the rating can read without reading words.
//
// One kind exists. The work is done and its pull request is open for a person to
// land, but the proof that says so could not be saved. The builder did its part,
// so the release is neither a landing nor a drop. The kind and the pull request
// ride on the release event as fields; the reason text is only for people, and
// nothing ever parses it.
//
// A release says this by passing both fields. The task db refuses half of a
// marker, and the rating reads a release as this kind only when both are there.

const PROOF_NOT_SAVED = 'proof_not_saved';

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

module.exports = { PROOF_NOT_SAVED, isProofNotSaved };
