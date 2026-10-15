// Held-out judge data: `atris campaign start --holdout <file>` moves the file
// out of the repo into the campaign's own folder beside the campaign store, so
// agents working in the checkout never read it. The judge finds it through
// ATRIS_CAMPAIGN_HOLDOUT, and any of its lines the judge echoes are scrubbed
// before the reading is stored, so show and export cannot print them.

'use strict';

const fs = require('fs');
const path = require('path');

const MASK = '[held out]';

function holdoutDir(root, campaignId) {
  return path.join(root, 'campaigns', campaignId, 'holdout');
}

// The held-out file for a campaign, or null when it has none.
function findHoldout(root, campaignId) {
  const dir = holdoutDir(root, campaignId);
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  const name = names.sort().find((n) => fs.statSync(path.join(dir, n)).isFile());
  return name ? path.join(dir, name) : null;
}

function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

// Moves the file in and returns its new path, or { error } in plain words.
function moveHoldoutIn(root, campaignId, source) {
  const from = path.resolve(source);
  if (!fs.existsSync(from) || !fs.statSync(from).isFile()) return { error: `--holdout ${source} is not a file` };
  const dir = holdoutDir(root, campaignId);
  fs.mkdirSync(dir, { recursive: true });
  const to = path.join(dir, path.basename(from));
  moveFile(from, to);
  return { path: to, from };
}

// Puts the file back where it came from, for a start that was refused.
function moveHoldoutBack(moved) {
  if (moved && moved.path && fs.existsSync(moved.path) && !fs.existsSync(moved.from)) moveFile(moved.path, moved.from);
}

// Replaces every held-out line that shows up in text.
function scrub(text, holdoutPath) {
  if (typeof text !== 'string' || !text || !holdoutPath) return text;
  let content;
  try { content = fs.readFileSync(holdoutPath, 'utf8'); } catch { return text; }
  const lines = [...new Set(content.split('\n').map((line) => line.trim()).filter((line) => line.length >= 4))];
  lines.sort((a, b) => b.length - a.length);
  let out = text;
  for (const line of lines) out = out.split(line).join(MASK);
  return out;
}

module.exports = { findHoldout, holdoutDir, moveHoldoutBack, moveHoldoutIn, scrub };
