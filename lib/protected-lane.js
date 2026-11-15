'use strict';

// The protected lanes a task can sit in (money, people, deploys and the rest):
// work in one of them always waits for a person. Moved out of
// lib/auto-accept-certified.js, which re-exports all of it, so light readers
// (the feed list) can ask without loading the landing gate.

const escapeRegExp = require('./escape-regexp');

const DENIED_TAGS = new Set(['billing', 'money', 'payments', 'deploy', 'feedback', 'security', 'customer', 'external']);

// Authors declare protected lanes in the task text, not the tag field. Match
// only explicit, deliberate declarations, an unanchored "security" would
// snag every task that merely mentions the word and wedge the loop shut,
// which is its own failure mode. Kept narrow on purpose.
const PROTECTED_LANE_PHRASES = [
  'protected lane',
  'never self-land',
  'never self land',
  'do not self-land',
  'human accepts',
  'human must accept',
  'human review required',
  'orchestrator reviews pre-land',
  'reviews pre-land',
];

function declaredProtectedLane(task) {
  const haystack = [
    task.title,
    task.objective,
    task.metadata && task.metadata.protected_lane_note,
  ]
    .map((v) => String(v || ''))
    .join('\n')
    .toLowerCase();
  if (!haystack.trim()) return null;
  const phrase = PROTECTED_LANE_PHRASES.find((p) => haystack.includes(p));
  return phrase ? { phrase } : null;
}

// Only consulted when a task carries no tag at all, so this never overrides an
// author who did classify their work. Terms are concrete nouns from the denied
// lanes: things you can only be touching on purpose. Deliberately excludes
// broad words like "auth", "user", or "api" that appear in ordinary frontend
// work and would hold the whole queue.
const PROTECTED_LANE_TERMS = [
  ['billing', ['stripe', 'checkout url', 'checkout_url', 'invoice', 'paywall', 'subscription', 'wallet', 'credit card', 'pricing tier']],
  ['money', ['money', 'refund', 'reimburs', 'expense', 'payment', 'cash', 'bank', 'venmo', 'zelle', 'tax']],
  ['security', ['session minting', 'mints a', 'service token', 'api key', 'credential', 'secret key', 'csrf', 'access token']],
  ['deploy', ['render deploy', 'production deploy', 'deploy to prod', 'migration apply']],
  ['customer', ['send email to', 'customer email', 'outbound email', 'notify users', 'imessage', 'text message', 'send a text', 'reply to', 'outreach', 'cold email', 'send to', 'dm ']],
];

function sniffedProtectedLane(task) {
  const haystack = [task.title, task.objective]
    .map((v) => String(v || ''))
    .join('\n')
    .toLowerCase();
  if (!haystack.trim()) return null;
  for (const [lane, terms] of PROTECTED_LANE_TERMS) {
    const term = terms.find((t) => new RegExp(`\\b${escapeRegExp(t)}`).test(haystack));
    if (term) return { lane, term };
  }
  return null;
}

// The protected lane a task sits in, or null: a denied tag (whole word,
// plural-stripped, the same match the landing gate uses), a lane declared in
// its text, or, for untagged rows, lane terms in its title or objective.
// Every automatic closer must leave these for a human.
function deniedTagOf(task) {
  const tag = String((task && task.tag) || '').trim().toLowerCase();
  return [...DENIED_TAGS].find((d) =>
    tag === d || tag.split(/[^a-z0-9]+/).some((w) => w === d || w.replace(/s$/, '') === d || w === d.replace(/s$/, ''))) || null;
}

function protectedLaneOf(task) {
  if (!task || typeof task !== 'object') return null;
  const metadata = task.metadata && typeof task.metadata === 'object' ? task.metadata : {};
  const view = { ...task, objective: task.objective || metadata.objective || '', metadata };
  const denied = deniedTagOf(view);
  if (denied) return denied;
  if (declaredProtectedLane(view)) return 'declared';
  if (!String(view.tag || '').trim()) {
    const sniffed = sniffedProtectedLane(view);
    if (sniffed) return sniffed.lane;
  }
  return null;
}

module.exports = {
  DENIED_TAGS,
  deniedTagOf,
  declaredProtectedLane,
  sniffedProtectedLane,
  protectedLaneOf,
};
