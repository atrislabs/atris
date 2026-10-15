'use strict';

// Synthetic source is scanned, never executed or deleted. --require-protection gates it.
// A plain delete after a git removal of the same folder must check the pin first.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

// Runs only when called directly, so loading it during a commit does nothing.
function main() {
  const root = path.resolve(__dirname, '../..');
  const source = fs.readFileSync(path.join(root, 'test/worktree-removal-guard.test.js'), 'utf8');
  const start = source.indexOf('const WORKTREE_REMOVAL =');
  const end = source.indexOf("test('every work folder removal", start);
  assert.ok(start >= 0 && end > start, 'scanner layout changed: update this review before relying on its output');
  const scanner = source.slice(start, end);

  let gaps = 0;
  // Each case names the reason the scan must give; an empty reason means protected.
  for (const [label, pinCheck, wantedReason] of [
    ['pin checked first control', 'if (describePin(worktreePath)) return;', ''],
    ['no pin check', '', 'plain delete of worktreePath after a git removal never checks its pin'],
    ['pin answer ignored', 'describePin(worktreePath);', 'pin check on worktreePath never stops the delete'],
    ['pin of another folder', 'if (describePin(otherPath)) return;', 'plain delete of worktreePath after a git removal never checks its pin'],
  ]) {
    const body = `function cleanup() {
    if (worktreeGitActivity(worktreePath)) return;
    ${pinCheck}
    spawnSync('git', ['worktree', 'remove', '--force', worktreePath]);
    fs.rmSync(worktreePath, { recursive: true, force: true });
    recordWorktreeRemoval(root, { path: worktreePath });
  }`;
    const context = vm.createContext({
      fs: { readFileSync: () => body },
      path,
      __dirname: path.join(root, 'test'),
    });
    vm.runInContext(scanner + '\nthis.sites = worktreeRemovalSites("lib/probe.js");' +
      "\nthis.reason = this.sites.map(removalGap).filter(Boolean).join('; ');", context, { timeout: 1000 });
    assert.equal(context.sites.length, 2, 'the git removal and the plain delete must both be detected');
    if (context.reason !== wantedReason) gaps++;
    console.log(`${label}: detected ${context.sites.length}` + (context.reason ? `; reason: ${context.reason}` : '; protected'));
  }
  console.log(`review gaps: ${gaps}; synthetic source only, never executed`);
  if (process.argv.includes('--require-protection') && gaps) process.exit(1);
}

if (require.main === module) main();
