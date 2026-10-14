'use strict';

// Member runs drop receipts and status files under atris/runs/ and
// atris/status/. A project that never ignores them stays dirty forever and
// member self-merge never fires, so init and update pin these entries in the
// project .gitignore. Git repos only: a plain folder gets no new file.

const fs = require('fs');
const path = require('path');

const RUN_IGNORE_COMMENT = '# atris run output';
const RUN_IGNORE_ENTRIES = ['atris/runs/', 'atris/status/'];

// .git can be a directory or a worktree pointer file; either counts.
function isGitRepo(root) {
  return fs.existsSync(path.join(root, '.git'));
}

// What the project .gitignore still needs, or null when it needs nothing
// (not a git repo, or every entry already present). Pure read; callers decide
// whether to write (update's plan-only mode prints the change instead).
function planRunIgnore(root) {
  if (!isGitRepo(root)) return null;
  const file = path.join(root, '.gitignore');
  const exists = fs.existsSync(file);
  const content = exists ? fs.readFileSync(file, 'utf8') : '';
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  const missing = RUN_IGNORE_ENTRIES.filter((entry) => !lines.includes(entry));
  if (missing.length === 0) return null;
  const additions = lines.includes(RUN_IGNORE_COMMENT) ? missing : [RUN_IGNORE_COMMENT, ...missing];
  const gap = content === '' ? '' : content.endsWith('\n') ? '\n' : '\n\n';
  return { file, created: !exists, missing, block: `${gap}${additions.join('\n')}\n` };
}

// Append-only write: existing lines, their order, and the rest of the file
// are never touched. Best-effort: an unreadable or unwritable .gitignore must
// not fail init or update, it just reports nothing changed.
function ensureRunIgnore(root, { dryRun = false } = {}) {
  let plan = null;
  try {
    plan = planRunIgnore(root);
  } catch {
    return { changed: false };
  }
  if (!plan) return { changed: false };
  if (!dryRun) {
    try {
      fs.appendFileSync(plan.file, plan.block);
    } catch {
      return { changed: false };
    }
  }
  return { changed: true, ...plan };
}

module.exports = { ensureRunIgnore };
