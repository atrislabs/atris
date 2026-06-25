'use strict';

// The clarity interview. The front door of the product: draw out how the human
// works, write it down once, and let every agent read it so they prompt
// themselves well. A small, high-signal profile, not a survey.

const fs = require('fs');
const path = require('path');

// One or two ideas at a time, plain English. Each answer is free text; the
// parenthetical is a nudge, not a fixed menu.
const QUESTIONS = [
  { key: 'focus', q: 'what are you building, and who is it for?' },
  { key: 'voice', q: 'how should output sound? (plain, terse, warm, formal)' },
  { key: 'cadence', q: 'how do you like to work? (one idea at a time, batch, overnight autonomous)' },
  { key: 'done', q: 'what does "done" mean to you? (tests green, shipped, you reviewed it)' },
  { key: 'leash', q: 'how much should agents do without asking? (ask first, proceed and report, full auto)' },
];

const KEYS = QUESTIONS.map((x) => x.key);

function isEmptyProfile(profile) {
  return !profile || !KEYS.some((k) => profile[k]);
}

function renderClarityMd(profile = {}) {
  const labels = {
    focus: 'Focus',
    voice: 'Voice',
    cadence: 'Cadence',
    done: 'Done means',
    leash: 'Leash',
  };
  const lines = [
    '# Clarity profile',
    '',
    'How the operator works. Agents read this to prompt themselves well,',
    'so the human does not have to repeat themselves.',
    '',
  ];
  for (const key of KEYS) {
    if (profile[key]) lines.push(`- ${labels[key]}: ${profile[key]}`);
  }
  if (isEmptyProfile(profile)) {
    lines.push('- (not set yet, run `atris clarity` to fill this in)');
  }
  lines.push('');
  if (profile.updated_at) lines.push(`Updated: ${profile.updated_at}`);
  lines.push('');
  return lines.join('\n');
}

function profilePaths(root = process.cwd()) {
  return {
    json: path.join(root, '.atris', 'clarity.json'),
    md: path.join(root, 'atris', 'CLARITY.md'),
  };
}

function readProfile(root = process.cwd()) {
  const { json } = profilePaths(root);
  try {
    return JSON.parse(fs.readFileSync(json, 'utf8'));
  } catch {
    return {};
  }
}

function writeProfile(root, profile) {
  const { json, md } = profilePaths(root);
  fs.mkdirSync(path.dirname(json), { recursive: true });
  fs.mkdirSync(path.dirname(md), { recursive: true });
  fs.writeFileSync(json, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
  fs.writeFileSync(md, renderClarityMd(profile), 'utf8');
  return { json, md };
}

// Merge new answers over an existing profile (so --set is incremental).
function mergeProfile(existing, answers, stamp) {
  const merged = { ...existing };
  for (const key of KEYS) {
    if (typeof answers[key] === 'string' && answers[key].trim()) merged[key] = answers[key].trim();
  }
  merged.updated_at = stamp || merged.updated_at || null;
  return merged;
}

module.exports = {
  QUESTIONS,
  KEYS,
  mergeProfile,
  isEmptyProfile,
  renderClarityMd,
  profilePaths,
  readProfile,
  writeProfile,
};
