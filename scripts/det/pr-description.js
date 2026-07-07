#!/usr/bin/env node
// det/pr-description.js — draft a PR description from the branch's diff vs a base.
// Replaces the "write a PR description" ask: the title comes from the commits,
// the summary bullets from which areas changed, and the test-plan skeleton from
// the touched test files — all read off the diff, so it is exact and never
// invents a rationale or a checklist item that isn't backed by a real change.
//
// Usage:
//   node pr-description.js                     # diff origin/master...HEAD -> markdown
//   node pr-description.js origin/main         # different base
//   node pr-description.js origin/main HEAD    # explicit base + head
//   node pr-description.js --json              # structured {title,summary,testPlan,...}
//
// Reads git itself; no stdin. The pure core build({commits, files}) is exported
// and unit-tested. Reuses parseSubject (changelog) and leadFile (commit-msg) so
// the library stays coherent.

'use strict';

const { execFileSync } = require('child_process');
const { parseSubject, SECTIONS } = require('./changelog');
const { leadFile } = require('./commit-msg');

// --- pure core (no git, no process) ---------------------------------------

function topDir(p) {
  const i = p.indexOf('/');
  return i === -1 ? '.' : p.slice(0, i);
}
function isTest(p) {
  // a test/ dir, a foo.test.js, or a file literally named test.js/test.ts
  return /(^|\/)tests?\//.test(p) || /\.test\.[jt]s$/.test(p) || /(^|\/)tests?\.[jt]s$/.test(p);
}

// title: one commit -> its subject; many -> dominant Conventional type + the
// lead file. Dominant type ties break in SECTIONS order (feat before fix ...).
function pickTitle(commits, files) {
  if (commits.length === 1) return (commits[0].subject || '').trim();
  const counts = {};
  for (const c of commits) {
    const t = parseSubject(c.subject || '').type;
    counts[t] = (counts[t] || 0) + 1;
  }
  let lead = 'other';
  let best = -1;
  for (const [type] of SECTIONS) {
    if ((counts[type] || 0) > best) {
      best = counts[type] || 0;
      lead = type;
    }
  }
  if (!files.length) return `${lead}: ${commits.length} commits`;
  const f = leadFile(files);
  const name = f.path.split('/').pop();
  return `${lead}: ${name}${files.length > 1 ? ` (+${files.length - 1} more)` : ''}`;
}

// one summary bullet per top-level area (first-seen order), with add/change/
// remove counts and exact churn — so a reviewer sees the shape at a glance.
function areaBullets(files) {
  const groups = new Map();
  for (const f of files) {
    const k = topDir(f.path);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  const bullets = [];
  for (const [area, fs] of groups) {
    const counts = { A: 0, M: 0, D: 0 };
    let added = 0;
    let deleted = 0;
    for (const f of fs) {
      counts[f.status] = (counts[f.status] || 0) + 1;
      added += f.added || 0;
      deleted += f.deleted || 0;
    }
    const parts = [];
    if (counts.A) parts.push(`${counts.A} added`);
    if (counts.M) parts.push(`${counts.M} changed`);
    if (counts.D) parts.push(`${counts.D} removed`);
    bullets.push(`- **${area}** — ${parts.join(', ')} (+${added}/-${deleted})`);
  }
  return bullets;
}

// test-plan skeleton: list the touched test files to run, then one check per
// non-test area. Every line is backed by a real change; no invented steps.
function testPlan(files) {
  const lines = [];
  const tests = files.filter((f) => isTest(f.path) && f.status !== 'D').map((f) => f.path);
  if (tests.length) {
    lines.push('- [ ] Run the touched tests:');
    for (const t of tests) lines.push(`  - \`${t}\``);
  }
  const areas = [];
  for (const f of files) {
    if (isTest(f.path)) continue;
    const a = topDir(f.path);
    if (!areas.includes(a)) areas.push(a);
  }
  for (const a of areas) lines.push(`- [ ] Exercise **${a}** and confirm no regression`);
  if (!lines.length) lines.push('- [ ] Manual verification of the changed files');
  return lines;
}

// { commits, files } -> { title, summary, testPlan, total, commits }
function build(input) {
  const commits = (input && input.commits) || [];
  const files = (input && input.files) || [];
  if (!commits.length && !files.length) {
    return { error: 'no commits or files vs base — is the branch ahead of it?' };
  }
  const totals = files.reduce(
    (a, f) => ({ added: a.added + (f.added || 0), deleted: a.deleted + (f.deleted || 0) }),
    { added: 0, deleted: 0 }
  );
  return {
    title: pickTitle(commits, files),
    summary: areaBullets(files),
    testPlan: testPlan(files),
    totals,
    fileCount: files.length,
    commitCount: commits.length,
  };
}

function render(res) {
  const out = [`# ${res.title}`, ''];
  out.push('## Summary');
  out.push(...(res.summary.length ? res.summary : ['- (no file changes)']));
  out.push(`- ${res.commitCount} commit${res.commitCount === 1 ? '' : 's'}, ${res.fileCount} file${
    res.fileCount === 1 ? '' : 's'
  }, +${res.totals.added}/-${res.totals.deleted}`);
  out.push('', '## Test plan');
  out.push(...res.testPlan);
  return out.join('\n');
}

// --- git plumbing (impure, only in main) ----------------------------------

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

// merge-base diff (three-dot) so the PR shows only this branch's changes.
function readFiles(threeDot) {
  const numstat = execFileSync('git', ['diff', '--numstat', threeDot], { encoding: 'utf8' });
  const names = execFileSync('git', ['diff', '--name-status', threeDot], { encoding: 'utf8' });
  const stat = {};
  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue;
    const [added, deleted, path] = line.split('\t');
    stat[path] = {
      added: added === '-' ? 0 : Number(added),
      deleted: deleted === '-' ? 0 : Number(deleted),
    };
  }
  const files = [];
  for (const line of names.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0][0];
    const path = parts[parts.length - 1];
    files.push({
      path,
      status,
      added: (stat[path] || {}).added || 0,
      deleted: (stat[path] || {}).deleted || 0,
    });
  }
  return files;
}

function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--json');
  const wantJson = process.argv.includes('--json');
  const base = args[0] || 'origin/master';
  const head = args[1] || 'HEAD';
  let commits;
  let files;
  try {
    commits = readCommits(`${base}..${head}`);
    files = readFiles(`${base}...${head}`);
  } catch (e) {
    process.stderr.write(`git failed: ${e.message}\n`);
    process.exit(2);
  }
  const res = build({ commits, files });
  if (res.error) {
    process.stderr.write(res.error + '\n');
    process.exit(2);
  }
  if (wantJson) {
    process.stdout.write(JSON.stringify({ base, head, ...res }, null, 2) + '\n');
  } else {
    process.stdout.write(render(res) + '\n');
  }
}

if (require.main === module) {
  main();
}

module.exports = { build, pickTitle, areaBullets, testPlan, render };
