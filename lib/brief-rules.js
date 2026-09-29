'use strict';

// Rule lines every builder brief carries (lib/codex-flight.js buildPrompt and
// lib/fleet.js buildFleetPrompt). The text lives here once so the two briefs
// cannot drift apart.
const SHARED_BRIEF_RULES = [
  '- Keep one concern per PR; split anything larger into separate PRs because git history guides future agents and small PRs are cheap to revert and bisect.',
  '- A guard, limit, or cache must hold on every path to the thing it protects; grep for the other callers, templates, and writers, and test at least one path you were not pointed at.',
];

module.exports = { SHARED_BRIEF_RULES };
