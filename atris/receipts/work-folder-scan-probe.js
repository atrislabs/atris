'use strict';

// Read-only review of the actual source scanner. Synthetic deletions are text,
// never executed. Default mode reports gaps; --require-protection gates repair.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'test/worktree-removal-guard.test.js'), 'utf8');
const start = source.indexOf('const WORKTREE_REMOVAL =');
const end = source.indexOf("test('every work folder removal", start);
const predicateStart = source.indexOf('.filter((site) => !site.body.includes', end);
const predicateEnd = source.indexOf('.map((site)', predicateStart);
assert.ok(start >= 0 && end > start && predicateStart > end && predicateEnd > predicateStart,
  'scanner layout changed: update this review before relying on its output');
const scanner = source.slice(start, end);
const bypassFilter = source.slice(predicateStart, predicateEnd).trim();

const cases = [
  ['bare synchronous removal', 'fs.rmSync(worktreePath, { recursive: true });', 1, 1],
  ['guarded synchronous control',
    'if (worktreeGitActivity(worktreePath)) return;\n  fs.rmSync(worktreePath, { recursive: true });\n  recordWorktreeRemoval(root, { path: worktreePath });', 1, 0],
  ['callback removal', 'fs.rm(worktreePath, { recursive: true }, () => {});', 1, 1],
  ['promise removal', 'await fs.promises.rm(worktreePath, { recursive: true });', 1, 1],
  ['older synchronous directory removal', 'fs.rmdirSync(worktreePath, { recursive: true });', 1, 1],
  ['older callback directory removal', 'fs.rmdir(worktreePath, { recursive: true }, () => {});', 1, 1],
  ['older promise directory removal', 'await fs.promises.rmdir(worktreePath, { recursive: true });', 1, 1],
  ['older multiline generic directory removal',
    'listWorktrees(root);\n  fs.rmdirSync(\n    target,\n    { recursive: true }\n  );', 1, 1],
  ['comment-only protection',
    '// TODO: call worktreeGitActivity and recordWorktreeRemoval\n  fs.rmSync(worktreePath, { recursive: true });', 1, 1],
  ['multiline generic removal',
    'listWorktrees(root);\n  fs.rmSync(\n    target,\n    { recursive: true }\n  );', 1, 1],
  ['nested generic path removal',
    'listWorktrees(root);\n  fs.rmSync(path.join(root, target), { recursive: true });', 1, 1],
  ['direct git-list generic removal',
    "spawnSync('git', ['worktree', 'list', '--porcelain']);\n  fs.rmSync(target, { recursive: true });", 1, 1],
  ['parsed git-list generic removal',
    'parseWorktrees(output);\n  fs.rmSync(target, { recursive: true });', 1, 1],
  ['typed shell removal', 'execSync(`rm -rf ${worktreePath}`);', 1, 1],
  ['spawned shell removal', "spawnSync('rm', ['-rf', worktreePath]);", 1, 1],
  ['guarded shell control',
    "if (worktreeGitActivity(worktreePath)) return;\n  spawnSync('rm', ['-rf', worktreePath]);\n  recordWorktreeRemoval(root, { path: worktreePath });", 1, 0],
];

let gaps = 0;
for (const [label, body, wantedSites, wantedBypasses] of cases) {
  const context = vm.createContext({
    fs: { readFileSync: () => `async function cleanup() {\n  ${body}\n}\n` },
    path,
    __dirname: path.join(root, 'test'),
  });
  vm.runInContext(scanner + '\nthis.sites = worktreeRemovalSites("lib/probe.js");' +
    `\nthis.bypasses = this.sites${bypassFilter};`, context, { timeout: 1000 });
  const matched = context.sites.length === wantedSites && context.bypasses.length === wantedBypasses;
  if (!matched) gaps++;
  console.log(`${label}: detected ${context.sites.length}, bypasses ${context.bypasses.length}; required ${wantedSites}, ${wantedBypasses}`);
}
console.log(`review gaps: ${gaps}; synthetic source only, no folders removed`);
if (process.argv.includes('--require-protection') && gaps) process.exitCode = 1;
