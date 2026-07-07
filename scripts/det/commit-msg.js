#!/usr/bin/env node
// det/commit-msg.js — draft a Conventional-Commits message from the STAGED diff.
// Replaces the "write me a commit message" ask: the type/scope come from the
// file paths and the body from the diff stats, so it is exact and reproducible,
// not an LLM guess about intent.
//
// Usage:
//   git add -A && node commit-msg.js          # print the drafted message
//   node commit-msg.js --json                 # structured {type,scope,subject,body,...}
//
// Reads `git diff --cached` itself; no stdin needed. Exit 2 if nothing staged.
// The pure core draft(files) is exported and unit-tested.

'use strict';

const { execFileSync } = require('child_process');

// --- pure core (no git, no process) ---------------------------------------

const VERB = { A: 'add', M: 'update', D: 'remove', R: 'rename', C: 'copy' };

function isMd(p) {
  return /\.md$/i.test(p);
}
function isTest(p) {
  return /(^|\/)tests?\//.test(p) || /\.test\.[jt]s$/.test(p);
}
function isChore(p) {
  return (
    /^(scripts|\.github)\//.test(p) ||
    /(^|\/)(package(-lock)?\.json|\.eslintrc.*|\.gitignore|\.npmignore)$/.test(p) ||
    /\.ya?ml$/.test(p)
  );
}

// scope = basename of the deepest directory common to every changed file.
function commonDirScope(paths) {
  if (paths.length === 0) return '';
  const dirSegs = paths.map((p) => p.split('/').slice(0, -1));
  let common = dirSegs[0];
  for (const segs of dirSegs.slice(1)) {
    let i = 0;
    while (i < common.length && i < segs.length && common[i] === segs[i]) i += 1;
    common = common.slice(0, i);
  }
  return common.length ? common[common.length - 1] : '';
}

function pickType(files) {
  const paths = files.map((f) => f.path);
  if (paths.every(isMd)) return 'docs';
  if (paths.every(isTest)) return 'test';
  if (paths.every(isChore)) return 'chore';
  if (files.some((f) => f.status === 'A')) return 'feat';
  return 'fix';
}

function summarize(files) {
  if (files.length === 1) {
    const f = files[0];
    const verb = VERB[f.status] || 'update';
    return `${verb} ${f.path.split('/').pop()}`;
  }
  const added = files.filter((f) => f.status === 'A').length;
  if (added === files.length) return `add ${files.length} files`;
  if (added === 0) return `update ${files.length} files`;
  return `update ${files.length} files`;
}

// files: [{ path, status, added, deleted }] -> { type, scope, summary, subject, body, totals }
function draft(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return { error: 'no staged changes' };
  }
  const type = pickType(files);
  let scope = commonDirScope(files.map((f) => f.path));
  if (scope === type) scope = ''; // avoid redundant test(test): / docs(docs):
  const summary = summarize(files);
  const subject = `${type}${scope ? `(${scope})` : ''}: ${summary}`;
  const totals = files.reduce(
    (a, f) => ({ added: a.added + (f.added || 0), deleted: a.deleted + (f.deleted || 0) }),
    { added: 0, deleted: 0 }
  );
  const lines = files.map(
    (f) => `- ${f.status} ${f.path} (+${f.added || 0}/-${f.deleted || 0})`
  );
  const body = `${lines.join('\n')}\n\n${files.length} file${
    files.length === 1 ? '' : 's'
  } changed, +${totals.added}/-${totals.deleted}`;
  return { type, scope, summary, subject, body, totals, files };
}

// --- git plumbing (impure, only in main) ----------------------------------

// Merge `--numstat` (added/deleted) with `--name-status` (A/M/D) by path.
function readStaged() {
  const numstat = execFileSync('git', ['diff', '--cached', '--numstat'], { encoding: 'utf8' });
  const names = execFileSync('git', ['diff', '--cached', '--name-status'], { encoding: 'utf8' });
  const stat = {};
  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue;
    const [added, deleted, path] = line.split('\t');
    stat[path] = { added: added === '-' ? 0 : Number(added), deleted: deleted === '-' ? 0 : Number(deleted) };
  }
  const files = [];
  for (const line of names.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0][0]; // R100 -> R
    const path = parts[parts.length - 1];
    files.push({ path, status, added: (stat[path] || {}).added || 0, deleted: (stat[path] || {}).deleted || 0 });
  }
  return files;
}

function main() {
  const wantJson = process.argv.includes('--json');
  let files;
  try {
    files = readStaged();
  } catch (e) {
    process.stderr.write(`git failed: ${e.message}\n`);
    process.exit(2);
  }
  const res = draft(files);
  if (res.error) {
    process.stderr.write(res.error + '\n');
    process.exit(2);
  }
  if (wantJson) {
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
  } else {
    process.stdout.write(`${res.subject}\n\n${res.body}\n`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { draft, commonDirScope, pickType, summarize };
