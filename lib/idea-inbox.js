'use strict';

// The idea inbox: the owner drops a plain sentence, walks away, and a tick
// later turns the oldest one into a normal Atris task (through the one-lap
// path) and builds it. This file holds only the raw sentences and what
// happened to each one. The work itself lives in the task DB like any other
// task; an idea that was picked up records its task id.
//
// Storage is an append-only JSONL log in the repo's own `.atris/state/`, so a
// tick and a new `atris idea "..."` can write at the same time without one
// clobbering the other.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STATUSES = Object.freeze(['waiting', 'building', 'landed', 'refused']);

// Version 1 safety rails are plain keyword and path checks, on purpose. They
// refuse too much rather than too little: a refused idea stays on the list as
// "needs owner" with the reason, and nothing is lost. A smarter check can
// replace these later; until then the rule is easy to read and easy to test.
const REFUSE_RULES = Object.freeze([
  {
    area: 'money',
    text: /\b(pay|payments?|payouts?|paid|billing|invoices?|charges?|charging|refunds?|stripe|pricing|prices?|credit\s+cards?|wire\s+transfers?|bank(?:ing)?|payroll|subscriptions?|checkout|trades?|trading)\b/i,
    path: /(?:^|[\/_.-])(?:billing|payments?|payouts?|stripe|invoices?|refunds?|checkout|pricing|wallet|payroll|mercury|brex|robinhood)(?:[\/_.-]|$)/i,
  },
  {
    area: 'sending messages or email',
    text: /\b(send|sends|sending|sent|resend|e-?mails?\s+(?:to|out|users|customers|people|everyone|them|him|her)|e-?mailing|mass\s+e-?mail|cold\s+e-?mail|sms|imessage|text\s+messages?|notify|dm|dms|tweet|tweets|post\s+(?:to|on)|outreach|newsletter)\b/i,
    path: /(?:^|[\/_.-])(?:send|sender|outreach|mailer|smtp|ses|sms|imessage|outbox|notify)(?:[\/_.-]|$)/i,
  },
  {
    area: 'auth',
    text: /\b(auth|oauth|authn|authz|authentication|authori[sz]ation|log\s?in|logins?|sign\s?in|sign\s?up|passwords?|credentials?|secrets?|api\s+keys?|tokens?|sessions?|permissions?|2fa|mfa|sso|jwt|cookies?)\b/i,
    path: /(?:^|[\/_.-])(?:auth|oauth|login|signin|password|passwords|credentials?|secrets?|tokens?|sessions?|sso|jwt|permissions?|keychain|env)(?:[\/_.-]|$)/i,
  },
  {
    area: 'deleting user data',
    text: /\b(?:delete|deleting|drop|dropping|purge|purging|wipe|wiping|truncate|erase|destroy)\b.{0,40}\b(?:users?|customers?|accounts?|data|database|db|tables?|records?|rows?|history|files?)\b|\b(?:drop\s+table|truncate\s+table|delete\s+from|rm\s+-rf)\b/i,
    path: null,
    added: /\b(?:DROP\s+TABLE|TRUNCATE\s+TABLE|DELETE\s+FROM)\b|\brm\s+-rf\s+[~\/$]/i,
  },
  {
    area: 'database migrations',
    text: /\b(migrations?|migrate|migrating|schema\s+changes?|alter\s+table|alembic|add\s+(?:a\s+)?column|drop\s+column)\b/i,
    path: /(?:^|\/)(?:migrations?|alembic)\/|\.sql$/i,
    added: /\bALTER\s+TABLE\b/i,
  },
]);

function stateFile(root) {
  return path.join(path.resolve(root || '.'), '.atris', 'state', 'ideas.jsonl');
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function oneLine(value, limit = 160) {
  const text = cleanText(value);
  return text.length > limit ? `${text.slice(0, limit - 3).trimEnd()}...` : text;
}

// Why an idea in plain words is not safe to build alone, or '' when it is.
function ideaRefusal(text) {
  const words = cleanText(text);
  for (const rule of REFUSE_RULES) {
    const hit = words.match(rule.text);
    if (hit) return `touches ${rule.area} ("${cleanText(hit[0]).toLowerCase()}"), needs owner`;
  }
  return '';
}

// Why a built change is not safe to land alone, or '' when it is. `paths` are
// the changed file paths; `addedLines` are the added lines of the diff.
function changeRefusal({ paths = [], addedLines = [] } = {}) {
  for (const rule of REFUSE_RULES) {
    if (rule.path) {
      const file = paths.find((entry) => rule.path.test(String(entry || '')));
      if (file) return `the change touches ${rule.area} (${file}), needs owner`;
    }
    if (rule.added) {
      const line = addedLines.find((entry) => rule.added.test(String(entry || '')));
      if (line) return `the change touches ${rule.area} (${oneLine(line, 60)}), needs owner`;
    }
  }
  return '';
}

function readEvents(root) {
  let text = '';
  try {
    text = fs.readFileSync(stateFile(root), 'utf8');
  } catch {
    return [];
  }
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object' && row.id) events.push(row);
    } catch {}
  }
  return events;
}

function appendEvent(root, event) {
  const file = stateFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
  return event;
}

// Ideas in the order they arrived, each with its latest status folded in.
function readIdeas(root) {
  const byId = new Map();
  const order = [];
  for (const event of readEvents(root)) {
    if (event.kind === 'idea') {
      if (byId.has(event.id)) continue;
      const idea = {
        id: event.id,
        n: order.length + 1,
        text: cleanText(event.text),
        at: event.at || null,
        status: 'waiting',
        reason: '',
        attempts: 0,
        ...(event.verify ? { verify: event.verify } : {}),
      };
      byId.set(event.id, idea);
      order.push(idea);
    } else if (event.kind === 'update' && byId.has(event.id)) {
      const idea = byId.get(event.id);
      const { kind, id, ...patch } = event;
      Object.assign(idea, patch);
      if (patch.status && patch.status !== 'refused' && !('reason' in patch)) idea.reason = '';
    }
  }
  return order;
}

function newIdeaId(now = new Date()) {
  return `idea-${now.getTime().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
}

// Saves one idea. A sentence that trips a rail is saved as refused right away,
// so the owner sees it on the list with its reason instead of losing it.
function addIdea(root, text, { verify = '', now = new Date() } = {}) {
  const sentence = cleanText(text);
  if (!sentence) throw new Error('an idea needs a sentence');
  const id = newIdeaId(now);
  const at = now.toISOString();
  appendEvent(root, { kind: 'idea', id, text: sentence, at, ...(verify ? { verify: cleanText(verify) } : {}) });
  const refusal = ideaRefusal(sentence);
  if (refusal) appendEvent(root, { kind: 'update', id, at, status: 'refused', reason: refusal });
  return readIdeas(root).find((idea) => idea.id === id);
}

function updateIdea(root, id, patch = {}, { now = new Date() } = {}) {
  if (patch.status && !STATUSES.includes(patch.status)) throw new Error(`unknown idea status: ${patch.status}`);
  appendEvent(root, { kind: 'update', id, at: now.toISOString(), ...patch });
  return readIdeas(root).find((idea) => idea.id === id) || null;
}

function findIdea(ideas, ref) {
  const key = String(ref || '').trim().replace(/^#/, '');
  if (!key) return null;
  if (/^\d+$/.test(key)) return ideas.find((idea) => idea.n === Number(key)) || null;
  return ideas.find((idea) => idea.id === key) || null;
}

// The oldest idea still waiting to be built.
function nextWaitingIdea(ideas) {
  return (ideas || []).find((idea) => idea.status === 'waiting') || null;
}

module.exports = {
  addIdea,
  changeRefusal,
  findIdea,
  ideaRefusal,
  nextWaitingIdea,
  oneLine,
  readIdeas,
  stateFile,
  updateIdea,
};
