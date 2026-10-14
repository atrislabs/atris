# Block-scoped copy receipt

- changed: a local copy of the launcher's name now hides the launcher only until the block or parentheses around the copy close. Before, a copy inside an if block, a counting loop header, or an inline callback hid the launcher for the rest of the function, so a real unrecorded launch after that block went unflagged.
- files: test/engine-resource.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, the member log, and this receipt.
- red first: the first new case failed on the old check, which stayed quiet about a launch that was never recorded.
- verify: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`, exit 0, 148 tests, 148 passed, 0 failed.
- real scan: 5 launches by name and 8 launches through a variable, 0 unrecorded.
- real mutation, old check against new: a launcher and a helper were appended to the scout command, and the previous commit's check ran from a temporary copy. A copy in a closed if block: old exit 0 (missed), new exit 1 on `commands/scout.js:168 runner`. A copy in an inline callback: old exit 0 (missed), new exit 1 on the same line. A copy and call in the same block: both exit 0. The temporary copy was removed and the scout file restored clean.
- refs: 67 map line refs past the edit moved; none sat between the two edits.
- whitespace: `git diff --check`, exit 0.
- cost: a var copy declared in an inner block now warns on a later call even though var reaches the whole function; that errs toward a warning, never a missed launch.
- next_push: apply the same block rule to the runner variable lookup, so a runner copy declared inside a closed block is not traced into a later launch.
