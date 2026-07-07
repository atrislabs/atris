#!/usr/bin/env node
// det/changelog.js — build a grouped changelog from Conventional-Commits history.
// Replaces the "summarize what changed since the last release" ask: the sections,
// order, and bullets come straight from the commit subjects, so the changelog is
// exact and reproducible, not an LLM paraphrase that drops or invents entries.
//
// Usage:
//   node changelog.js                 # since the last tag (or root) -> markdown
//   node changelog.js v3.34.0         # since a specific ref
//   node changelog.js v3.34.0 HEAD    # explicit range
//   node changelog.js --json          # structured {sections,counts,...}
//
// Reads `git log` itself; no stdin needed. The pure core build(commits) is
// exported and unit-tested.

'use strict';

const { execFileSync } = require('child_process');

// --- pure core (no git, no process) ---------------------------------------

// Conventional-Commits types -> human section heading, in display order.
const SECTIONS = [
  ['feat', 'Features'],
  ['fix', 'Fixes'],
  ['perf', 'Performance'],
  ['refactor', 'Refactors'],
  ['docs', 'Docs'],
  ['test', 'Tests'],
  ['build', 'Build'],
  ['ci', 'CI'],
  ['chore', 'Chores'],
  ['other', 'Other'],
];
const KNOWN = new Set(SECTIONS.map((s) => s[0]));

// "feat(scope): subject" or "fix: subject" -> { type, scope, subject }.
// Anything that doesn't match the header grammar lands in the "other" bucket
// with the whole line as the subject, so nothing is silently dropped.
function parseSubject(line) {
  const m = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/.exec(line.trim());
  if (!m) return { type: 'other', scope: '', breaking: false, subject: line.trim() };
  const type = KNOWN.has(m[1]) ? m[1] : 'other';
  return { type, scope: m[2] || '', breaking: Boolean(m[3]), subject: m[4].trim() };
}

// commits: [{ hash, subject }] -> { sections, counts, breaking, total }
function build(commits) {
  if (!Array.isArray(commits)) return { error: 'commits must be an array' };
  const buckets = {};
  const breaking = [];
  for (const c of commits) {
    const p = parseSubject(c.subject || '');
    const entry = { hash: c.hash || '', scope: p.scope, subject: p.subject };
    (buckets[p.type] = buckets[p.type] || []).push(entry);
    if (p.breaking) breaking.push(entry);
  }
  const sections = [];
  const counts = {};
  for (const [type, title] of SECTIONS) {
    const items = buckets[type];
    if (items && items.length) {
      sections.push({ type, title, items });
      counts[type] = items.length;
    }
  }
  return { sections, counts, breaking, total: commits.length };
}

// one bullet: "- subject (scope) [hash]" with the optional bits omitted cleanly.
function fmtItem(it) {
  const scope = it.scope ? ` (${it.scope})` : '';
  const hash = it.hash ? ` [${it.hash}]` : '';
  return `- ${it.subject}${scope}${hash}`;
}

function render(res) {
  const lines = [];
  if (res.breaking.length) {
    lines.push('### ⚠ BREAKING CHANGES');
    for (const it of res.breaking) lines.push(fmtItem(it));
    lines.push('');
  }
  for (const s of res.sections) {
    lines.push(`### ${s.title}`);
    for (const it of s.items) lines.push(fmtItem(it));
    lines.push('');
  }
  if (!lines.length) return 'No changes.';
  return lines.join('\n').trimEnd();
}

// --- git plumbing (impure, only in main) ----------------------------------

function lastTag() {
  try {
    return execFileSync('git', ['describe', '--tags', '--abbrev=0'], {
      encoding: 'utf8',
    }).trim();
  } catch (e) {
    return ''; // no tags yet -> changelog from the root commit
  }
}

// range like "v3.34.0..HEAD" (or just "HEAD" when there's no start ref).
function readCommits(range) {
  const out = execFileSync('git', ['log', '--no-merges', '--pretty=%h%x09%s', range], {
    encoding: 'utf8',
  });
  const commits = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    commits.push({ hash: line.slice(0, tab), subject: line.slice(tab + 1) });
  }
  return commits;
}

function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--json');
  const wantJson = process.argv.includes('--json');
  const start = args[0] || lastTag();
  const end = args[1] || 'HEAD';
  const range = start ? `${start}..${end}` : end;
  let commits;
  try {
    commits = readCommits(range);
  } catch (e) {
    process.stderr.write(`git failed: ${e.message}\n`);
    process.exit(2);
  }
  const res = build(commits);
  if (res.error) {
    process.stderr.write(res.error + '\n');
    process.exit(2);
  }
  if (wantJson) {
    process.stdout.write(JSON.stringify({ range, ...res }, null, 2) + '\n');
  } else {
    process.stdout.write(render(res) + '\n');
  }
}

if (require.main === module) {
  main();
}

module.exports = { build, parseSubject, render, SECTIONS };
