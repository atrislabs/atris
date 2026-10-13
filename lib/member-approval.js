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
function categoryStem(category) {
  const head = String(category || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)[0] || '';
  if (head.length < 3) return '';
  return head.length > 4 ? head.replace(/(e|es|s|ing|ed)$/, '') : head;
}

function objectiveNamesCategory(objective, category) {
  const stem = categoryStem(category);
  if (!stem) return false;
  return new RegExp(`\\b${stem.replace(/[^a-z0-9]/g, '')}`, 'i').test(String(objective || ''));
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
