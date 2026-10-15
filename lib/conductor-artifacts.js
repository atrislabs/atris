'use strict';

// Files the conductor itself writes into an agent worktree before the engine runs.
// They are harness plumbing, not work product, so no dirty-checkout check may
// count them as dirt. Both the worktree guard and the sealed-review import read
// this list; keeping it in one place is what stops an engine from being blocked
// by its own prompt file.
const CONDUCTOR_UNTRACKED_PATTERN =
  /^\.atris\/(?:agent-worktree\.json|fleet-prompt-[^/]+\.md|codex-watchdog\.js|codex-watchdog-[^/]+\.json|runtime-tmp(?:\/.*)?|state\/briefs\.jsonl)$/;
const CONDUCTOR_ROOT_OUTPUT_PATTERN = /^\.codex-last-message\.txt$/;
const CONDUCTOR_RUN_OUTPUT_PATTERN = /^atris\/runs\/[^/]+\.(?:json|live\.log)$/;

// Every atris call inside a work folder can write more of its own state under
// .atris/ (engine health, usage, briefs). A list of names always lagged: on
// 2026-10-15 .atris/state/engines.json and usage.jsonl made every dispatch
// guard fail on a fresh repo. A NEW file under .atris/ is always the tool's
// own, so untracked checks skip the whole folder. Tracked .atris/ files keep
// the exact list, since a repo may commit some of them on purpose.
const ATRIS_OWN_DIR_PATTERN = /^\.atris\//;

function isConductorArtifact(file) {
  const value = String(file || '');
  return CONDUCTOR_UNTRACKED_PATTERN.test(value) || CONDUCTOR_ROOT_OUTPUT_PATTERN.test(value)
    || CONDUCTOR_RUN_OUTPUT_PATTERN.test(value);
}

// For files git does not track yet.
function isConductorUntracked(file) {
  return isConductorArtifact(file) || ATRIS_OWN_DIR_PATTERN.test(String(file || ''));
}

// Accepts a `git status --porcelain` line ("?? .atris/fleet-prompt-BCK-1.md").
function isConductorStatusLine(line) {
  const text = String(line || '');
  if (!text.startsWith('?? ')) return false;
  return isConductorUntracked(text.slice(3));
}

module.exports = {
  isConductorArtifact,
  isConductorStatusLine,
  isConductorUntracked,
};
