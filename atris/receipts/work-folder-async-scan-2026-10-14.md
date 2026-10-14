# Asynchronous deletion coverage review

Saved a reproducible coverage gap: the deletion scan misses two asynchronous removal forms. The required real Git and process checks passed with exit 0, 23 passed and 0 failed.

## Verdict

Proceed with changes before introducing asynchronous cleanup. The named risk is a future unguarded asynchronous removal passing the source scan. Require scanner regressions for callback and promise removal before using either form, while retaining the real Git activity and removal-log tests.

This is a source-scan finding, not evidence of a current runtime deletion bypass. No runtime code changed. The probe evaluates the existing scanner against synthetic source strings without deleting any folder.

## Reproduce

Run from the project root:

```sh
node <<'NODE'
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('test/worktree-removal-guard.test.js', 'utf8');
const scanner = source.slice(source.indexOf('const WORKTREE_REMOVAL ='), source.indexOf("test('every work folder removal"));
for (const call of ['fs.rmSync(worktreePath, { recursive: true });', 'fs.rm(worktreePath, { recursive: true }, () => {});', 'await fs.promises.rm(worktreePath, { recursive: true });']) {
  const context = { fs: { readFileSync: () => `async function cleanup() {\n  ${call}\n}\n` }, path: require('node:path'), __dirname: process.cwd() + '/test' };
  vm.createContext(context);
  vm.runInContext(scanner + '\nthis.sites = worktreeRemovalSites("lib/probe.js");', context);
  console.log(`${call} => ${context.sites.length} detected`);
}
NODE
```

Actual output, exit 0:

```text
fs.rmSync(worktreePath, { recursive: true }); => 1 detected
fs.rm(worktreePath, { recursive: true }, () => {}); => 0 detected
await fs.promises.rm(worktreePath, { recursive: true }); => 0 detected
```

## Behavior proof

Command: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`

Actual output excerpt, exit 0:

```text
✔ every work folder removal goes through the git check and the removal log (108.132458ms)
ℹ tests 23
ℹ suites 0
ℹ pass 23
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3011.504791
```

Files edited: this receipt and `atris/team/architect/logs/2026-10-14.md` (ignored local member log). Existing rendered task changes remain unstaged.

Metric: two demonstrated scan gaps, one synchronous positive control, 23 behavior checks passing. This increment supplies a bounded build handoff, not a coverage repair.

next_push: add failing scanner regressions for callback and promise folder removal, then extend detection to pass them without weakening guard and log requirements.

layer: beliefs
