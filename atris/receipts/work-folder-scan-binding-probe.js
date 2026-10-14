'use strict';

// Synthetic source is scanned, never executed or deleted. --require-protection gates it.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'test/worktree-removal-guard.test.js'), 'utf8');
const start = source.indexOf('const WORKTREE_REMOVAL =');
const end = source.indexOf("test('every work folder removal", start);
const predicateStart = source.indexOf('.filter((site) => removalGap(', end);
const predicateEnd = source.indexOf('.map((site)', predicateStart);
assert.ok(start >= 0 && end > start && predicateStart > end && predicateEnd > predicateStart,
  'scanner layout changed: update this review before relying on its output');
const scanner = source.slice(start, end);
const bypassFilter = source.slice(predicateStart, predicateEnd).trim();

let gaps = 0;
const removal = 'fs.rmSync(worktreePath, { recursive: true });';
for (const [label, protectedPath, loggedPath, wantedBypasses, shape] of [
  ['matching folder control', 'worktreePath', 'worktreePath', 0],
  ['resolved same folder control', 'realFolder', 'worktreePath', 0],
  ['unrelated folder guard', 'otherWorktreePath', 'worktreePath', 1],
  ['unrelated folder log', 'worktreePath', 'otherWorktreePath', 1],
  ['unrelated folder protection', 'otherWorktreePath', 'otherWorktreePath', 1],
  ['check only after the delete', 'worktreePath', 'worktreePath', 1, 'after'],
  ['answer ignored', 'worktreePath', 'worktreePath', 1, 'ignored'],
  ['answer stored and never read', 'worktreePath', 'worktreePath', 1, 'unread'],
  ['delete inside the not-busy branch control', 'worktreePath', 'worktreePath', 0, 'wrapped'],
]) {
  const check = `if (worktreeGitActivity(${protectedPath})) return;`;
  const guarded = {
    after: `${removal}\n  ${check}`,
    ignored: `worktreeGitActivity(${protectedPath});\n  ${removal}`,
    unread: `const busy = worktreeGitActivity(${protectedPath});\n  ${removal}`,
    wrapped: `const busy = worktreeGitActivity(${protectedPath});\n  if (!busy) {\n    ${removal}\n  }`,
  }[shape] || `${check}\n  ${removal}`;
  const body = `function cleanup() {
  const realFolder = fs.realpathSync(worktreePath);
  ${guarded}
  recordWorktreeRemoval(root, { path: ${loggedPath} });
}`;
  const context = vm.createContext({
    fs: { readFileSync: () => body },
    path,
    __dirname: path.join(root, 'test'),
  });
  vm.runInContext(scanner + '\nthis.sites = worktreeRemovalSites("lib/probe.js");' +
    `\nthis.bypasses = this.sites${bypassFilter};`, context, { timeout: 1000 });
  assert.equal(context.sites.length, 1, 'the deletion must be detected before judging its protection');
  if (wantedBypasses === 0) assert.equal(context.bypasses.length, 0, 'matching control must stay protected');
  if (context.bypasses.length !== wantedBypasses) gaps++;
  console.log(`${label}: detected ${context.sites.length}, bypasses ${context.bypasses.length}; required 1, ${wantedBypasses}`);
}
console.log(`review gaps: ${gaps}; synthetic source only, never executed`);
// Acceptance mode makes any mismatch a failing check.
if (process.argv.includes('--require-protection') && gaps) process.exitCode = 1;
