#!/usr/bin/env node
// det/voice.js - score a chat reply against the way of talking (atris.md ## voice).
// Deterministic: same input, same verdict. Used by the engine voice exam and any
// agent that wants to check its own reply before sending it to a human.
//
//   node det.js voice scan < reply.txt      # PASS, or FAIL with one finding per line
//   node det.js voice json < reply.txt      # machine-readable findings

'use strict';

const MODES = ['scan', 'json'];

// Code fences, inline code, and markdown link targets stay literal on purpose:
// the standard allows one copyable command and real references inside backticks.
function stripLiterals(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\]\([^)]*\)/g, '] ');
}

const RULES = [
  ['em-dash', /—/g],
  ['task-code', /\b[A-Z]{2,10}-\d{1,6}\b/g],
  ['raw-id', /\b[0-9A-HJKMNP-TV-Z]{26}\b/g],
  ['system-noun', /\b(?:task plane|mission spine|second reviewer|worktrees?|verifiers?|orchestrat\w*|subagents?|ULIDs?|projections?)\b/gi],
];

function isHexHash(word) {
  return /^[0-9a-f]{7,40}$/.test(word) && /\d/.test(word) && /[a-f]/.test(word);
}

function scanReply(text) {
  const clean = stripLiterals(text);
  const findings = [];
  for (const [rule, pattern] of RULES) {
    for (const match of clean.match(pattern) || []) {
      findings.push({ rule, snippet: match === '—' ? 'U+2014' : match });
    }
  }
  for (const match of clean.match(/\b[0-9a-f]{7,40}\b/g) || []) {
    if (isHexHash(match)) findings.push({ rule: 'commit-hash', snippet: match });
  }
  const bullets = (clean.match(/^\s*[-*•] /gm) || []).length;
  if (bullets > 3) findings.push({ rule: 'bullet-stack', snippet: `${bullets} bullets` });
  const seen = new Set();
  return findings.filter((f) => {
    const key = `${f.rule}:${f.snippet}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function run(mode, input) {
  if (!MODES.includes(mode)) return { error: `unknown mode: ${mode || '(none)'}` };
  const findings = scanReply(input);
  if (mode === 'json') return { text: JSON.stringify({ pass: findings.length === 0, findings }) };
  if (!findings.length) return { text: 'PASS' };
  return {
    text: [`FAIL (${findings.length})`, ...findings.map((f) => `- ${f.rule}: "${f.snippet}"`)].join('\n'),
  };
}

if (require.main === module) {
  let data = '';
  process.stdin.on('data', (chunk) => { data += chunk; });
  process.stdin.on('end', () => {
    const result = run(process.argv[2] || 'scan', data);
    if (result.error) { process.stderr.write(`${result.error}\n`); process.exit(2); }
    process.stdout.write(`${result.text}\n`);
    process.exit(result.text.startsWith('PASS') || result.text.startsWith('{"pass":true') ? 0 : 1);
  });
}

module.exports = { run, scanReply, MODES };
