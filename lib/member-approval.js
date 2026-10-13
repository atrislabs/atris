'use strict';

const fs = require('fs');
const path = require('path');

// MEMBER.md frontmatter can carry `approval-required: [merge, delete]` (the
// scaffold nests it under `permissions:`). Nothing in the CLI ever read it.
// This reader is deliberately tolerant: inline list, block list, nested or
// top-level, quotes optional. It returns [] for anything it cannot read, so a
// malformed file never blocks a mission, it just seeds no ask.

const MEMBER_SLUG = /^[a-zA-Z0-9._-]+$/;

function frontmatterOf(text) {
  const match = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? match[1].split(/\r?\n/) : null;
}

function cleanItem(value) {
  return String(value || '').trim().replace(/^["']|["']$/g, '').trim();
}

function parseApprovalRequired(text) {
  const lines = frontmatterOf(text);
  if (!lines) return [];
  const index = lines.findIndex((line) => /^\s*approval-required\s*:/.test(line));
  if (index < 0) return [];
  const rest = lines[index].replace(/^\s*approval-required\s*:/, '').replace(/\s+#.*$/, '').trim();
  let items = [];
  if (rest.startsWith('[')) {
    const end = rest.lastIndexOf(']');
    items = rest.slice(1, end > 0 ? end : undefined).split(',');
  } else if (rest) {
    items = [rest];
  } else {
    const indent = lines[index].match(/^\s*/)[0].length;
    for (let i = index + 1; i < lines.length; i += 1) {
      const item = lines[i].match(/^(\s*)-\s+(.+)$/);
      if (!item || item[1].length < indent) break;
      items.push(item[2].replace(/\s+#.*$/, ''));
    }
  }
  return Array.from(new Set(items.map(cleanItem).filter(Boolean)));
}

function memberApprovalRequired(owner, root = process.cwd()) {
  const slug = String(owner || '').trim();
  if (!slug || !MEMBER_SLUG.test(slug)) return [];
  try {
    const file = path.join(root, 'atris', 'team', slug, 'MEMBER.md');
    if (!fs.existsSync(file)) return [];
    return parseApprovalRequired(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

// Categories are action classes ("delete", "publish"), not mission-level
// gates. Seeding an ask for every listed category would stop every mission of
// a member whose template lists any (the shipped executor lists delete), so a
// category only seeds an ask when the mission objective names it. The head
// word of the category is matched as a stem: "delete" catches deleting/deletion,
// "destructive-file-action" catches destructive, "spend" catches spending.
function wordStem(word) {
  const head = String(word || '').toLowerCase();
  if (head.length < 3) return '';
  return head.length > 4 ? head.replace(/(e|es|s|ing|ed)$/, '') : head;
}

function categoryStem(category) {
  return wordStem(String(category || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)[0] || '');
}

// A mention under a negation ("do not edit files", "without deleting") forbids
// the action instead of asking for it, so it seeds no ask. Any plain mention
// elsewhere in the objective still does.
const NEGATION_BEFORE = /\b(?:not|never|no|don'?t|do\s+not|without|avoid|nor)\s+(?:\w+\s+){0,2}$/i;

// Categories are written in policy words ("destructive-file-action",
// "external-send"), objectives in plain ones ("delete the old logs", "email
// the client"). Each head word below also matches the plain words that mean
// it. Kept short on purpose: every word added is a chance to hold a mission
// that did nothing risky, so only words that name the action itself go here
// (not "message", "post", "clean", "update").
const CATEGORY_SYNONYMS = Object.freeze({
  destructive: ['delete', 'remove', 'erase', 'wipe', 'purge', 'destroy'],
  external: ['send', 'email', 'publish'],
  billing: ['charge', 'refund', 'spend', 'invoice'],
  spend: ['charge', 'refund', 'purchase'],
  send: ['email'],
  delete: ['erase', 'purge'],
});

// A category's own head word matches as a prefix (existing behavior); a
// synonym matches only as that word with an ordinary ending, so "send" does
// not fire on "sender" or "remove" on "removable".
const SYNONYM_ENDINGS = '(?:e|es|s|ed|ing|al|ion|ions)?';

// True when the pattern matches somewhere that is not under a negation.
function mentionedWithoutNegation(text, pattern) {
  const re = new RegExp(pattern.source, 'gi');
  let match;
  while ((match = re.exec(text))) {
    if (!NEGATION_BEFORE.test(text.slice(0, match.index))) return true;
    if (match[0] === '') re.lastIndex += 1;
  }
  return false;
}

function objectiveNamesCategory(objective, category) {
  const text = String(objective || '');
  const head = String(category || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)[0] || '';
  const stem = categoryStem(category).replace(/[^a-z0-9]/g, '');
  if (stem && mentionedWithoutNegation(text, new RegExp(`\\b${stem}`))) return true;
  // "wipe" reads as wip(ing), "delete" as delet(ion): drop the trailing e.
  const words = (CATEGORY_SYNONYMS[head] || []).map((w) => w.replace(/e$/, '')).filter(Boolean);
  if (!words.length) return false;
  return mentionedWithoutNegation(text, new RegExp(`\\b(?:${words.join('|')})${SYNONYM_ENDINGS}\\b`));
}

// One open human ask per mission covering every implicated category, so a
// single yes answers it. Tagged so a "no" can be told apart from a plain
// answered ask.
const APPROVAL_ASK_SOURCE = 'member_approval_required';

function memberApprovalAsks(owner, root = process.cwd(), objective = '') {
  const categories = memberApprovalRequired(owner, root)
    .filter((category) => objectiveNamesCategory(objective, category));
  if (!categories.length) return [];
  return [{
    text: `Approve ${owner} acting on: ${categories.join(', ')} (MEMBER.md approval-required, named in the objective)`,
    answered_at: null,
    source: APPROVAL_ASK_SOURCE,
    categories,
  }];
}

// Asks that stop an explicit `mission run`: every open ask, plus a seeded
// approval ask that was answered "no" (a denial must not read as clearance).
function runBlockingAsks(asks) {
  const list = Array.isArray(asks) ? asks : [];
  return list
    .map((ask) => (typeof ask === 'string' ? { text: ask, answered_at: null } : ask))
    .filter((ask) => ask && String(ask.text || '').trim())
    .filter((ask) => !ask.answered_at || (ask.source === APPROVAL_ASK_SOURCE && ask.answer !== 'yes'));
}

module.exports = {
  memberApprovalAsks,
  objectiveNamesCategory,
  parseApprovalRequired,
  runBlockingAsks,
};
