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

// Publish without replacing any existing path, including dangling symlinks.
// The temporary copy is private and on the destination filesystem, so link
// publication is exclusive even when source and destination are on different
// devices. If the source cannot be removed, both copies are kept.
function moveFile(from, to) {
  const before = fs.lstatSync(from);
  if (!before.isFile()) throw new Error(`not a regular file: ${from}`);
  let staging;
  try {
    try {
      fs.linkSync(from, to);
    } catch (error) {
      if (error.code !== 'EXDEV') throw error;
      staging = fs.mkdtempSync(path.join(path.dirname(to), '.holdout-copy-'));
      const copy = path.join(staging, 'data');
      fs.copyFileSync(from, copy, fs.constants.COPYFILE_EXCL);
      fs.linkSync(copy, to);
    }
    const after = fs.lstatSync(from);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error(`source changed; both paths were retained: ${from}, ${to}`);
    }
    try { fs.unlinkSync(from); } catch (error) {
      throw new Error(`could not remove source; both paths were retained: ${from}, ${to}: ${error.message}`);
    }
  } finally {
    if (staging) {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    }
  }
}

// Moves the file in and returns its new path, or { error } in plain words.
function moveHoldoutIn(root, campaignId, source) {
  const from = path.resolve(source);
  let stat;
  try { stat = fs.lstatSync(from); } catch (error) {
    if (error.code === 'ENOENT') return { error: `--holdout ${source} is not a file` };
    throw error;
  }
  if (!stat.isFile()) return { error: `--holdout ${source} is not a file` };
  const dir = holdoutDir(root, campaignId);
  try {
    fs.mkdirSync(root, { recursive: true });
    for (const part of [root, path.join(root, 'campaigns'), path.join(root, 'campaigns', campaignId), dir]) {
      try { fs.mkdirSync(part); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      if (!fs.lstatSync(part).isDirectory()) return { error: `holdout directory is not a real directory: ${part}` };
    }
  } catch (error) { return { error: `could not prepare holdout directory: ${error.message}` }; }
  if (fs.readdirSync(dir).length) return { error: `holdout directory is not empty: ${dir}` };
  const to = path.join(dir, path.basename(from));
  try { moveFile(from, to); } catch (error) {
    return { error: `could not move holdout to ${to}: ${error.message}` };
  }
  return { path: to, from };
}

// Never replace a file which appeared at the original source path.
function moveHoldoutBack(moved) {
  if (!moved || !moved.path) return { ok: true };
  try {
    moveFile(moved.path, moved.from);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `holdout remains at ${moved.path}: ${error.message}` };
  }
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
