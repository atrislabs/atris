// Protected paths: files a campaign's agents must not touch, like the judge's
// questions. Start saves the paths and the commit they started from in the
// campaign folder beside the campaign store, outside the checkout, so agents
// cannot edit the list; guard names any of them changed since, committed or not.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return { ok: result.status === 0, out: (result.stdout || '').trim(), err: (result.stderr || '').trim() };
}

function checkoutTop(root) {
  const top = git(root, ['rev-parse', '--show-toplevel']);
  return top.ok ? fs.realpathSync(top.out) : null;
}

// The folder holding every campaign's own files, beside the campaign store.
function campaignHome(store) {
  const { campaignDbPath } = require('./campaign-store');
  return path.dirname((store && store.path) || campaignDbPath());
}

function protectFile(home, campaignId) {
  return path.join(home, 'campaigns', campaignId, 'protect.json');
}

// The commit a checkout sits on, or null outside git or before the first commit.
function headCommit(root) {
  const head = git(root, ['rev-parse', 'HEAD']);
  return head.ok ? head.out : null;
}

// The commit and checkout-relative paths to save, or an error in plain words.
function planProtect(root, paths) {
  const topDir = checkoutTop(root);
  if (!topDir) return { error: '--protect needs a git checkout' };
  const head = git(root, ['rev-parse', 'HEAD']);
  if (!head.ok) return { error: '--protect needs a checkout with at least one commit' };
  const here = fs.realpathSync(root);
  const rels = [];
  for (const given of paths) {
    const rel = path.relative(topDir, path.resolve(here, given)).split(path.sep).join('/');
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { error: `--protect ${given} is not inside this checkout` };
    if (!rels.includes(rel)) rels.push(rel);
  }
  return { paths: rels, base_commit: head.out };
}

function saveProtect(home, campaignId, plan) {
  const file = protectFile(home, campaignId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ paths: plan.paths, base_commit: plan.base_commit }, null, 2)}\n`);
  return file;
}

function readProtect(home, campaignId) {
  try {
    return JSON.parse(fs.readFileSync(protectFile(home, campaignId), 'utf8'));
  } catch {
    return null;
  }
}

// Protected paths that differ from the base commit: committed, staged,
// unstaged, deleted, or new and untracked. Root is the checkout top, since
// the saved paths are relative to it.
function changedProtected(root, saved) {
  const spec = ['--', ...saved.paths.map((rel) => `:(top,literal)${rel}`)];
  const diff = git(root, ['diff', '--name-only', saved.base_commit, ...spec]);
  if (!diff.ok) return { error: `cannot compare with ${String(saved.base_commit).slice(0, 12)}: ${diff.err || 'git diff failed'}` };
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '--full-name', ...spec]);
  const changed = [...diff.out.split('\n'), ...untracked.out.split('\n')].filter(Boolean);
  return { changed: [...new Set(changed)].sort() };
}

module.exports = { campaignHome, changedProtected, checkoutTop, headCommit, planProtect, protectFile, readProtect, saveProtect };
