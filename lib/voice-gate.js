'use strict';

const {
  dejargon,
  hasAgentJargon,
  operatorReady,
  voicePatterns,
} = require('./autoland');

const EM_DASH = /\u2014/;

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

module.exports = {
  gateForHuman,
  scanText,
};
