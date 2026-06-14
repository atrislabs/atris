'use strict';

// Canonical TODO/journal section classification. The same emoji-brittle logic
// existed (and was bug-fixed) independently in commands/now.js (CLI-287) and
// commands/brain.js (CLI-288); centralizing it here so a third copy can't drift.
//
// Headings may carry trailing decoration ("## In Progress 🔄", "## Completed ✅"),
// so detection uses \b (not \s*$) and section names match by prefix — "In Progress 🔄"
// counts as "In Progress", while "Backlogged Notes" does NOT count as "Backlog".

const RENDERED_SECTION_RE = /^##\s+(Backlog|In Progress|Blocked|Completed)\b/m;

// True when the document uses rendered task sections (vs a flat/legacy bullet list).
function hasRenderedSections(text) {
  return RENDERED_SECTION_RE.test(String(text || ''));
}

// A parsed heading name matches a canonical section if it equals it or is that
// name followed by decoration (a space then emoji/text).
function sectionMatches(name, target) {
  const n = String(name || '');
  return n === target || n.startsWith(`${target} `);
}

function isOpenSection(name) {
  return sectionMatches(name, 'Backlog') || sectionMatches(name, 'In Progress');
}

function isDoneSection(name) {
  return sectionMatches(name, 'Completed');
}

module.exports = { hasRenderedSections, sectionMatches, isOpenSection, isDoneSection, RENDERED_SECTION_RE };
