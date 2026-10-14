'use strict';

// Advisory only: synthetic source is scanned, never executed or deleted.
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

let gaps = 0;
for (const [label, protectedPath, wantedBypasses] of [
  ['matching folder control', 'worktreePath', 0],
  ['unrelated folder protection', 'otherWorktreePath', 1],
]) {
  const body = `function cleanup() {
  if (worktreeGitActivity(${protectedPath})) return;
  fs.rmSync(worktreePath, { recursive: true });
  recordWorktreeRemoval(root, { path: ${protectedPath} });
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
console.log(`review gaps: ${gaps}; advisory only, synthetic source never executed`);
