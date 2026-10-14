# Comment-only removal protection review

Saved a reproducible false positive in the deletion protection scan. The scanner probe exited 0; the required real Git and process checks exited 0 with 23 passed and 0 failed.

## Verdict

Proceed with changes to the scanner plan. The named risk is that a TODO comment containing the guard and log names makes an unguarded deletion pass. Require a regression showing that comments cannot satisfy protection before accepting a detection-only expansion for asynchronous removal. Keep the actual Git activity and removal-log behavior tests.

This is a synthetic source-check finding, not evidence of a current runtime bypass. No runtime code changed and the probe deletes no folders. Removing comments fixes this demonstrated case, but name presence alone still does not prove that a guard runs before deletion or that logging runs afterward.

## Reproduce

Run from the project root:

```sh
node <<'NODE'
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync('test/worktree-removal-guard.test.js', 'utf8');
const scanner = source.slice(source.indexOf('const WORKTREE_REMOVAL ='), source.indexOf("test('every work folder removal"));
for (const [label, comment] of [['bare deletion', ''], ['comment-only protection', '// TODO: call worktreeGitActivity and recordWorktreeRemoval']]) {
  const context = { fs: { readFileSync: () => `function cleanup() {\n  ${comment}\n  fs.rmSync(worktreePath, { recursive: true });\n}\n` }, path: require('node:path'), __dirname: process.cwd() + '/test' };
  vm.createContext(context);
  vm.runInContext(scanner + '\nthis.sites = worktreeRemovalSites("lib/probe.js");', context);
  assert.equal(context.sites.length, 1);
  const bypasses = context.sites.filter(site => !site.body.includes('worktreeGitActivity') || !site.body.includes('recordWorktreeRemoval'));
  assert.equal(bypasses.length, comment ? 0 : 1);
  console.log(`${label}: ${context.sites.length} deletion detected, ${bypasses.length} bypasses reported`);
}
NODE
```

Actual output, exit 0:

```text
bare deletion: 1 deletion detected, 1 bypasses reported
comment-only protection: 1 deletion detected, 0 bypasses reported
```

## Behavior proof

Command: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`

Actual output excerpt, exit 0:

```text
✔ every work folder removal goes through the git check and the removal log (47.906625ms)
ℹ tests 23
ℹ suites 0
ℹ pass 23
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2944.221083
```

Files edited: this receipt and `atris/team/architect/logs/2026-10-14.md` (ignored local member log). Existing rendered task changes remain unstaged.

Commands run: mission status, brain activation preview (exit 2, no files written), task list/new/claim/note/ready, source reads, scanner probe above, required behavior checks, diff check, git commit and push. No deletion commands or runtime changes were introduced.

Metric: one demonstrated comment-only false positive with a bare-deletion control; 23 behavior checks passing. This review tightens the existing asynchronous scanner build handoff.

next_push: add a scanner regression requiring comment-only guard and log names to remain a reported bypass, then repair detection without weakening runtime checks.

layer: beliefs
