# Required checks stop leaving fixture folders behind

Every run of the required cleanup checks left about ten temporary Git repositories behind, one or two per real proof script, plus a kept green-landing scratch copy. This mission alone had piled up about 660 of them in the temporary directory.

The guard test now runs each proof through one helper. Once a proof passes, the helper removes each fixture folder the proof printed, only if it sits directly in the temporary directory and its name starts with the Atris prefix. A failing proof keeps its fixture so someone can inspect it. The green-landing proof now also reports the scratch copy it deliberately kept, so that copy is removed too.

## Proof

Previous test file, one full passing run:

```
node --test test/zz-previous-guard.test.js test/member-tidy.test.js   (HEAD copy of the guard test, removed after)
tests 33, pass 33, fail 0
new fixture folders with previous test: 10
```

New test file, one full passing run:

```
node --test test/worktree-removal-guard.test.js test/member-tidy.test.js
verifier exit: 0
tests 33, pass 33, fail 0
fixture folders before: 662, after: 662, new: 0
```

The ten folders from the baseline run were removed by exact path afterward. The older leftovers were left alone.

## Files

- test/worktree-removal-guard.test.js: one proof runner for eight proofs, removes printed fixtures after a pass
- atris/receipts/2026-10-14-land-green-scratch-check.js: reports the kept scratch copy as a fixture
