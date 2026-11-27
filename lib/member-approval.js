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
const NEGATION_BEFORE = /\b(not|never|no|don['’]?t|do\s+not|without|avoid|nor)(?:,?\s+under\s+any\s+circumstances,?)?\s+((?:\w+\s+){0,2})$/i;
// "don't forget to send", "do not hesitate to spend", "avoid delaying the
// email", "not only delete": the negation lands on another word and the act
// is still asked for.
const NEGATION_VOID = /\b(?:forget\w*|fail\w*|hesitat\w*|wait\w*|delay\w*|stop\w*|skip\w*|neglect\w*|hold\w*|omit\w*|miss\w*|postpon\w*|only|just)\b/i;
// A negation earlier in the same sentence turns "without" into an ask:
// "never close a ticket without emailing the customer".
const EARLIER_NEGATION = /\b(?:not|never|no|nobody|nothing|none|cannot|avoid|without|nor)\b|n['’]t\b/i;
// A "no" inside a condition belongs to the condition, not the verb after it:
// "if there is no reply send a follow-up". Any of these earlier in the
// sentence and a negation before the verb is not trusted as a ban.
const CONDITION_BEFORE = /\b(?:if|when|whenever|once|unless|until|after|before|since|because|whether|while|in\s+case|as\s+long\s+as)\b/i;
// The ban can also follow the verb: "send no email", "spend nothing", "delete
// nothing". A cap is still an ask: "spend no more than $50", "send no later
// than Friday".
const NEGATION_AFTER = /^\s+(?:out\s+|off\s+)?(?:no(?!\s+(?:later|sooner|earlier|more|less|fewer|longer|further)\b)|nothing(?!\s+(?:more|less|over|above|beyond|but)\b)|none|nobody|zero|no[- ]one)\b/i;
// A ban with a carve-out asks for the carve-out: "spend nothing except the ad
// budget", "never email anyone but the client". Checked over the rest of the
// sentence; when one of these words is there the mention counts as an ask.
const BAN_EXCEPTION = /\b(?:except|excluding|unless|but|than|besides|apart\s+from|aside\s+from|save\s+for|other\s+than|beyond|up\s+to|at\s+most)\b/i;
// A past fact is not an ask: "6 notes were sent", "the intro was already
// emailed". Only an -ed form right after a past helper counts; "should be
// emailed" or "get it deleted" still asks.
const PAST_BEFORE = /\b(?:was|were|already|had|has\s+been|have\s+been|had\s+been)\s+(?:\w+\s+)?$/i;
// A counted log line with a past date is a fact too: "6 notes sent Nov 16".
const COUNT_BEFORE = /\b\d+\s+(?:\w+\s+){0,2}$/;
const DATE_AFTER = /^\s+(?:on\s+)?(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\d{4}-\d{2}-\d{2}\b|yesterday\b|last\s+\w+)/i;
// "make sure the invoice has been sent", "ensure the notes were sent": a past
// form under an instruction or a modal is an order, not a fact.
const INSTRUCTION_BEFORE = /\b(?:make\s+sure|ensure|insure|be\s+sure|see\s+to\s+it|see\s+that|please|must|should|need\s+to|needs\s+to|has\s+to|have\s+to|will|want|get|got\s+to)\b/i;
// Email as the thing read, not the act of sending: "owners who answer their
// own email", "check the email replies". "Answer the email" on its own is a
// reply, so answer only counts when it describes someone ("who answer").
const READING_BEFORE = /\b(?:(?:who|that)\s+answers?|read|reads|reading|check|checks|checking|open|opens|opening|scan|scans|scanning|triage|triages|review|reviews|reviewing)\s+(?:(?:the|a|an|their|own|his|her|our|your|my|its|this|that|these|those|every|each|any|all|new|incoming|unread)\s+){0,2}$/i;

function sentenceSoFar(before) {
  const re = /[.;!?](?:\s|$)|\n/g;
  let start = 0;
  let match;
  while ((match = re.exec(before))) start = match.index + match[0].length;
  return before.slice(start);
}

function negatedBefore(before) {
  const match = before.match(NEGATION_BEFORE);
  if (!match || NEGATION_VOID.test(match[2] || '')) return false;
  // "do not leave without deleting": a second negation between the first and
  // the verb cancels it.
  if (EARLIER_NEGATION.test(match[2] || '')) return false;
  const lead = sentenceSoFar(before.slice(0, match.index));
  if (CONDITION_BEFORE.test(lead)) return false;
  if (/^without$/i.test(match[1]) && EARLIER_NEGATION.test(lead)) return false;
  return true;
}

function restOfSentence(after) {
  const end = after.search(/[.;!?](?:\s|$)|\n/);
  return end < 0 ? after : after.slice(0, end);
}

// True only when this mention clearly does not ask for the act. Anything not
// recognised as a ban, a past fact, or email being read counts as an ask.
function mentionIsNotAnAsk(text, index) {
  const before = text.slice(0, index);
  const word = (text.slice(index).match(/^\w+/) || [''])[0];
  const after = text.slice(index + word.length);
  const banned = negatedBefore(before) || NEGATION_AFTER.test(after);
  if (banned && !BAN_EXCEPTION.test(restOfSentence(after))) return true;
  if (/(?:ed|^sent|^spent)$/i.test(word) && !INSTRUCTION_BEFORE.test(sentenceSoFar(before))
    && (PAST_BEFORE.test(before) || (COUNT_BEFORE.test(before) && DATE_AFTER.test(after)))) return true;
  if (/^e-?mails?$/i.test(word) && READING_BEFORE.test(before)) return true;
  return false;
}

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
const IRREGULAR_PAST = Object.freeze({ send: 'sent', spend: 'spent' });

// True when the pattern matches somewhere that reads as an ask.
function mentionedWithoutNegation(text, pattern) {
  const re = new RegExp(pattern.source, 'gi');
  let match;
  while ((match = re.exec(text))) {
    if (!mentionIsNotAnAsk(text, match.index)) return true;
    if (match[0] === '') re.lastIndex += 1;
  }
  return false;
}

function objectiveNamesCategory(objective, category) {
  const text = String(objective || '');
  const head = String(category || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)[0] || '';
  const stem = categoryStem(category).replace(/[^a-z0-9]/g, '');
  if (stem && mentionedWithoutNegation(text, new RegExp(`\\b${stem}`))) return true;
  // "sent" and "spent" do not start with their stem, so "make sure the invoice
  // has been sent" used to slip past unread.
  const irregular = [head, ...(CATEGORY_SYNONYMS[head] || [])].map((w) => IRREGULAR_PAST[w]).filter(Boolean);
  if (irregular.length && mentionedWithoutNegation(text, new RegExp(`\\b(?:${irregular.join('|')})\\b`))) return true;
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
