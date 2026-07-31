# Atris CLI test failure triage, 2026-07-30

## Scope and isolation

Triage used a detached worktree at `/private/tmp/atris-cli-triage-d0958557-20260730` on exact commit `d0958557e64d53b36baecbd42201e8a8e577af3f`. The worktree was clean before and after the reproductions. No code, tests, package metadata, or task state were edited.

| Failure | Classification | User-visible regression? |
|---|---|---|
| absolute venv python outside workspace arena | environment-specific | no current product regression |
| member wake refuses to pile onto open work | stale test | no; the old expectation would restore a real deadlock |
| member loop repeats wake and skips active lease | genuine product bug | yes; repeated ticks stack duplicate proposed work |
| no export is unnamed by the rest of the repo | genuine product bug, with two detector false positives | mostly no, but a blind fix would break the protected-lane git guard |
| package version and lockfile aligned | genuine product bug | release and package integrity, not normal runtime behavior |

## 1. Strict verify runtime rejects absolute venv python outside the workspace arena

**Classification:** environment-specific.

**Reproduction:** `node --test test/auto-accept-certified.test.js` passed all 29 tests in the detached `/private/tmp` checkout. Running the same file with `HOME=/private/tmp TMPDIR=/private/tmp` reproduced the reported assertion:

```text
actual:   verify_unrunnable
expected: verify_command_not_allowed
test/auto-accept-certified.test.js:392
```

**Root cause:** the test creates `workspace` under `os.tmpdir()` and constructs `outsidePython` under `os.homedir()`. `parentArenaDir()` in `lib/auto-accept-certified.js` uses the nearest `arena` ancestor, or falls back to the workspace's parent. When `HOME` and `TMPDIR` resolve under the same fallback parent, the path named "outside" is inside the permitted sibling arena, so validation correctly allows it and execution later reports the nonexistent binary as `verify_unrunnable`.

**Smallest fix:** make the fixture location-invariant. Create a private temp root containing `arena/workspace` and a sibling `outside/venv/bin/python`; pass `arena/workspace` as the workspace so `outside` is provably outside the allowed root on every machine. Product code does not need to change.

**Would this mask a regression a real user feels?** No current regression was found. The security coverage is valuable, but this failure is the fixture disagreeing with the configured path boundary, not strict verify escaping that boundary.

## 2. Member wake returns one finite decision and refuses to pile onto open work

**Classification:** stale test.

**Reproduction:** `node --test --test-name-pattern='member wake returns one finite decision and refuses to pile onto open work' test/commands.test.js` failed with:

```text
actual:   tick
expected: wait
test/commands.test.js:1559
```

**Root cause:** commit `87a649b9` intentionally changed `wakeDecision()` so a proposed fallback experiment with no verifier does not return `wait` forever. `experimentIsUnreviewable()` identifies exactly that shape, based on `status=proposed`, `generation.mode=fallback`, and no verifier. After the first executed wake creates such a fallback, the next dry run now returns `tick / safe_next_bounded_step`; the test still expects the pre-change `wait / open_experiment_proposed` contract.

**Smallest fix:** update the post-fallback dry-run assertions to the intended nonblocking decision and keep an assertion that dry-run does not mutate the experiment array. Keep duplicate-open-work coverage in the two-tick loop test rather than restoring the obsolete wait behavior.

**Would this mask a regression a real user feels?** No. Restoring the test's old expectation would restore the product deadlock that commit `87a649b9` documented in live members blocked for 22 to 52 days.

## 3. Member loop repeats wake quickly and skips an active lease

**Classification:** genuine product bug.

**Reproduction:** `node --test test/commands.test.js` failed at the loop assertion:

```text
actual:   2
expected: 1
test/commands.test.js:3622
```

A direct two-tick reproduction returned only `wait:tick_executed_experiment_proposed: 2` and left two experiments, both with `status=proposed`.

**Root cause:** the nonblocking change from `87a649b9` is incomplete. `wakeDecision()` ignores the current unreviewable fallback as a gate, but `runMemberWake()` then calls `goal.experiments.push(experiment)` on every execute tick. The loop therefore treats the same fallback condition as fresh work and piles up duplicate open proposals; the lease acquisition and active-lease skip code itself is not the failing part.

**Smallest fix:** make fallback handling idempotent. Carry the current unreviewable fallback into the planned tick and replace or reuse that record instead of pushing another open experiment. Update the test to assert the intended nonblocking decision sequence while retaining the stronger invariant that two execute ticks leave exactly one open fallback, then continue to exercise active and stale lease behavior.

**Would this mask a regression a real user feels?** Yes. Always-on members can create duplicate proposed work every cadence, inflate queues and logs, and appear productive while making no new progress.

## 4. No export in commands/ or lib/ is unnamed by the rest of the repo

**Classification:** genuine product bug, with two detector false positives that require a safe fix.

**Reproduction:** `node --test test/repo-hygiene.test.js` reported 15 orphaned exports:

```text
commands/teach.js: buildArgs
lib/accept-verify-gate.js: TEMPLATE_PLACEHOLDERS, NON_FALSIFYING_COMMANDS
lib/claude-boot-block.js: ATRIS_START_MARKER, ATRIS_END_MARKER, renderAtrisClaudeBootBlock
lib/conductor-artifacts.js: CONDUCTOR_UNTRACKED_PATTERN
lib/mission-protected-lane.js: PATH_SURFACES, CONTENT_SURFACES,
  changedPathsFromDiff, changedCodeLinesFromDiff, isCodeFile, readMissionDiff,
  gitSubcommand, defaultGit
```

**Root cause:** the zero-orphan ratchet landed in `8db66502`; these exports were added later and 13 are used only inside their defining module. However, `gitSubcommand` and `defaultGit` are real runtime exports: `prepareMissionGitGuard()` writes a generated wrapper that requires `lib/mission-protected-lane.js` and calls both. `findOrphanedExports()` searches only other checked-in JavaScript files, so it cannot see that generated consumer and falsely labels those two.

**Smallest fix:** remove the 13 genuinely unnecessary export entries while leaving their internal definitions intact. Preserve `gitSubcommand` and `defaultGit` through a narrow documented allowlist, or move the generated wrapper consumer into a checked-in module so the scanner can see the cross-file references.

**Would this mask a regression a real user feels?** The 13 accidental exports are hygiene drift rather than user-visible behavior. Blindly dropping all 15 would create a real protected-lane regression because generated mission git wrappers would call undefined functions and fail at commit time.

## 5. Npm package metadata keeps version and lockfile aligned

**Classification:** genuine product bug.

**Reproduction:** `node --test test/repo-shape.test.js` failed with:

```text
package-lock.json: 3.37.1
package.json:      3.38.0
test/repo-shape.test.js:34
```

**Root cause:** commit `b85f1ea6` changed only `package.json` from `3.37.1` to `3.38.0`; both the top-level lockfile version and `packages[""].version` remained `3.37.1`. The test is a correct release-integrity ratchet.

**Smallest fix:** update the two root version fields in `package-lock.json` to `3.38.0`, preferably via the package manager's lockfile-only update. A follow-up should make the release/version-bump path update and verify both files atomically so this cannot recur.

**Would this mask a regression a real user feels?** Not in ordinary CLI runtime, which reads `package.json`, but it is a genuine package and release integrity defect that can mislead automation and keep CI red.

## Ranked fix order

1. Fix the member-loop duplicate proposal bug. It is the only confirmed active behavior that directly harms always-on users.
2. Split the hygiene findings safely: remove the 13 accidental exports and explicitly preserve the two generated-wrapper exports. This unblocks the ratchet without weakening the protected-lane guard.
3. Align `package-lock.json` to `3.38.0` and harden the version-bump path.
4. Make the absolute-venv test fixture location-invariant.
5. Refresh the stale single-wake assertions to the intentional nonblocking contract.

## Post-landing correction (2026-07-31)

Section 4 overstated the generated-wrapper risk: `prepareMissionGitGuard` inlines
`gitSubcommand.toString()` and `defaultGit.toString()` into the wrapper source, so
removing their export entries (landed on master in #573) does not break the guard.
Verified against origin/master before repairing a non-bug.
