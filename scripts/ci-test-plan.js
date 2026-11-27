'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { changedFiles } = require('./ci-quick-check');
const { assign } = require('./ci-test-shard');
const weights = require('../test/ci-file-durations.json');

const sha = /^[0-9a-f]{40}$/;
const groupBudgetMs = 30000;

function comparisonBase(root, eventName, event) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (eventName === 'pull_request') {
    const base = event.pull_request?.base?.sha;
    if (!sha.test(base) || git('rev-parse', 'HEAD^1') !== base ||
        git('rev-parse', 'HEAD^2') !== event.pull_request?.head?.sha) {
      throw new Error('pull request parents do not match the event');
    }
    return base;
  }

  const group = event.merge_group;
  if (eventName !== 'merge_group' || !sha.test(group?.base_sha) || git('rev-parse', 'HEAD') !== group.head_sha ||
      !group.base_ref?.startsWith('refs/heads/')) throw new Error('merge group does not match the checkout');
  git('check-ref-format', group.base_ref);
  git('merge-base', '--is-ancestor', group.base_sha, 'HEAD');
  // The first parent can itself be a speculative group. Include every change
  // that has not reached the target branch, including earlier queued PRs.
  const target = group.base_ref.replace('refs/heads/', 'refs/remotes/origin/');
  const common = git('merge-base', '--all', target, group.base_sha);
  if (!sha.test(common)) throw new Error('merge group has no single verified base on the target branch');
  return common;
}

function buildMatrix(selection, eventName, durations = weights) {
  if (selection.full) {
    const mode = eventName === 'pull_request' ? 'quick' : 'full';
    const count = mode === 'quick' ? 3 : 8;
    return { mode, matrix: { include: Array.from({ length: count }, (_, i) => ({ group: `${i + 1}/${count}`, files: [] })) } };
  }
  const files = [...new Set(selection.files)];
  if (!files.length) throw new Error('no tests selected');
  const totalMs = files.reduce((sum, file) => sum + (durations[file] > 0 ? durations[file] : 1000), 0);
  const count = Math.min(8, files.length, Math.ceil(totalMs / groupBudgetMs));
  const include = assign(files, count, durations).map((shard, i) => ({ group: `${i + 1}/${count}`, files: shard.files }));
  return { mode: 'selected', matrix: { include } };
}

function main() {
  const { GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: output } = process.env;
  const root = process.cwd();
  let base = '';
  let selection = { full: true, reason: 'scheduled or requested full check' };
  if (eventName === 'merge_group' || eventName === 'pull_request') {
    const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
    try {
      if (eventName === 'merge_group' && process.env.TARGET_READ !== 'success') throw new Error('target fetch failed');
      base = comparisonBase(root, eventName, event);
    } catch (err) {
      selection.reason = `could not prove the comparison base: ${err.message.split('\n')[0]}`;
    }
    if (base) selection = require('./ci-impact-check').plan(root, changedFiles(root, base));
  }
  // The quick PR fallback needs a verified comparison base. An unreadable
  // base always runs the full suite.
  const { mode, matrix } = buildMatrix(selection, base ? eventName : 'full');
  console.log(`${mode}: ${selection.reason}; ${matrix.include.length} test group(s).`);
  for (const row of matrix.include) if (row.files.length) console.log(`${row.group}: ${row.files.join(' ')}`);
  fs.appendFileSync(output, `mode=${mode}\nbase=${base}\nmatrix=${JSON.stringify(matrix)}\n`);
}

if (require.main === module) main();
module.exports = { comparisonBase, buildMatrix };
