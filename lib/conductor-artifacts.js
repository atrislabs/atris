'use strict';

// Files the conductor itself writes into an agent worktree before the engine runs.
// They are harness plumbing, not work product, so no dirty-checkout check may
// count them as dirt. Both the worktree guard and the sealed-review import read
// this list; keeping it in one place is what stops an engine from being blocked
// by its own prompt file.
const CONDUCTOR_UNTRACKED_PATTERN =
  /^\.atris\/(?:agent-worktree\.json|fleet-prompt-[^/]+\.md|runtime-tmp(?:\/.*)?|state\/briefs\.jsonl)$/;

function isConductorArtifact(file) {
  return CONDUCTOR_UNTRACKED_PATTERN.test(String(file || ''));
}

// Accepts a `git status --porcelain` line ("?? .atris/fleet-prompt-BCK-1.md").
function isConductorStatusLine(line) {
  const text = String(line || '');
  if (!text.startsWith('?? ')) return false;
  return isConductorArtifact(text.slice(3));
}

module.exports = {
  isConductorArtifact,
  isConductorStatusLine,
};
