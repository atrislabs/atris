'use strict';

const {
  dejargon,
  hasAgentJargon,
  operatorReady,
  voicePatterns,
} = require('./autoland');

const EM_DASH = /\u2014/;
const NUMBER_WORDS = [
  'no', 'one', 'two', 'three', 'four', 'five', 'six',
  'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
];

function numberWord(n) {
  return NUMBER_WORDS[n] || String(n);
}

function globalPattern(pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}

function findingsFor(text, pattern, rule, why) {
  const findings = [];
  for (const match of String(text || '').matchAll(globalPattern(pattern))) {
    findings.push({ rule, why, snippet: match[0] });
  }
  return findings;
}

function scanText(text) {
  const value = String(text || '');
  const findings = findingsFor(value, EM_DASH, 'em-dash', 'use plain punctuation');
  if (hasAgentJargon(value)) {
    findings.push(...findingsFor(
      value,
      voicePatterns.agentJargon,
      'agent-jargon',
      'replace internal syntax with plain words',
    ));
  }
  findings.push(...findingsFor(
    value,
    voicePatterns.rawUlid,
    'raw-ulid',
    'name the item instead of showing its database id',
  ));
  findings.push(...findingsFor(
    value,
    voicePatterns.filePath,
    'file-path',
    'describe the proof instead of exposing an internal file location',
  ));
  findings.push(...findingsFor(
    value,
    voicePatterns.shellCommand,
    'shell-command',
    'turn command syntax into a human action',
  ));
  return findings;
}

function cleanEmDashes(text) {
  return String(text || '')
    .replace(/\s*\u2014\s*/g, ', ')
    .replace(/^,\s*/, '')
    .replace(/,\s*$/, '.')
    .replace(/([.!?])\s*,\s*/g, '$1 ')
    .replace(/,\s*([,.;:!?])/g, '$1');
}

function cleanAfterRemoval(text) {
  return String(text || '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([:;,])\s*([.!?])/g, '$2')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function titleCanReplaceId(title) {
  const value = String(title || '').trim();
  return Boolean(value) && (operatorReady(value) || !hasAgentJargon(value));
}

function gateForHuman(text, opts = {}) {
  let cleaned = cleanEmDashes(text);
  cleaned = dejargon(cleaned, { preserveTickets: true });
  if (titleCanReplaceId(opts.title)) {
    cleaned = cleaned.replace(globalPattern(voicePatterns.rawUlid), '');
  }
  cleaned = cleanAfterRemoval(cleaned);
  const issues = scanText(cleaned);
  return { ok: issues.length === 0, text: cleaned, issues };
}

const LANDING_PARTICIPLE_WHY = {
  avoiding: 'it avoids',
  cutting: 'it cuts',
  eliminating: 'it eliminates',
  giving: 'it gives',
  keeping: 'it keeps',
  making: 'it makes',
  preventing: 'it prevents',
  reducing: 'it reduces',
  removing: 'it removes',
  saving: 'it saves',
  stopping: 'it stops',
};

// A landing sentence written for a human already carries its own why
// ("..., so operators keep deciding instead of waiting"). Split that clause
// out so "why it matters" quotes the work instead of a canned line; return
// null when the sentence has no real why.
function landingWhyClause(sentence) {
  const text = String(sentence || '').replace(/\s+/g, ' ').trim();
  const finish = (change, why) => {
    const cleanChange = String(change || '').replace(/[,;:]+$/, '').trim();
    const cleanWhy = String(why || '').trim();
    if (!cleanChange || !cleanWhy) return null;
    return {
      change: /[.!?]$/.test(cleanChange) ? cleanChange : `${cleanChange}.`,
      why: /[.!?]$/.test(cleanWhy) ? cleanWhy : `${cleanWhy}.`,
    };
  };
  const connective = text.match(/^(.{12,}?),?\s+(?:so(?:\s+that)?|because|which means)\s+(.{8,}?)[.!?]?$/i);
  if (connective) return finish(connective[1], connective[2]);
  const participles = Object.keys(LANDING_PARTICIPLE_WHY).join('|');
  const participial = text.match(new RegExp(`^(.{12,}?),\\s+(${participles})\\s+(.{4,}?)[.!?]?$`, 'i'));
  if (participial) {
    return finish(participial[1], `${LANDING_PARTICIPLE_WHY[participial[2].toLowerCase()]} ${participial[3]}`);
  }
  return null;
}

// Canned reasons older composers wrote into durable receipts. Treat them as
// absent so the reader sees the work's own why or nothing at all.
const RETIRED_FILLER_REASON = new RegExp([
  '^It makes the result understandable before a human accepts or rejects it\\.$',
  '^It proves the workflow works in the place people actually use it\\.$',
  '^It turns the mission into a concrete result a human can accept, reject, or run again\\.$',
  '^It turns the task title into a concrete result the human can approve\\.$',
  '^It gives the human a repeatable check before approval\\.$',
  '^It keeps real-world side effects behind a clear human decision\\.$',
  '^It keeps private data out of the fast human decision screen\\.$',
  '^It lets the operator see the next command without hunting\\.$',
  '^It stops old approvals from running after their context has gone stale\\.$',
  '^This makes the work easier to judge\\.$',
].join('|'));

function isRetiredFillerReason(text) {
  return RETIRED_FILLER_REASON.test(String(text || '').replace(/\s+/g, ' ').trim());
}

module.exports = {
  gateForHuman,
  isRetiredFillerReason,
  landingWhyClause,
  numberWord,
  scanText,
};
