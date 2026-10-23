'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

// Jobs keep their own checkout for verification. Their durable XP belongs in
// the main checkout, where removing a landed job's checkout cannot erase it.
// Preserve a nested workspace's relative path so customer workspaces stay apart.
function careerXpRoot(workspace) {
  const root = path.resolve(workspace);
  try {
    const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: root, encoding: 'utf8', timeout: 5000,
    });
    if (top.status !== 0 || !top.stdout.trim()) return root;
    const listing = spawnSync('git', ['worktree', 'list', '--porcelain', '-z'], {
      cwd: root, encoding: 'utf8', timeout: 5000,
    });
    const first = String(listing.stdout || '').split('\0')[0];
    if (listing.status !== 0 || !first.startsWith('worktree ')) return root;
    const main = first.slice('worktree '.length);
    // Bare repositories and separate git storage may name the storage folder,
    // not a checkout. Never create an XP ledger inside git's internal files.
    if (!fs.existsSync(path.join(main, '.git'))) return root;
    const relative = path.relative(top.stdout.trim(), root);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return root;
    return path.resolve(main, relative);
  } catch {
    return root;
  }
}

module.exports = { careerXpRoot };
