# Block variable receipt

- changed: the runner launch check now treats a loop variable or an error-handler variable that shares the launcher's name as hiding the launcher, but only for calls inside that loop or handler. A call after the block closes, or a longer name, still counts as a call to the launcher.
- files: test/engine-resource.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, the member log, and this receipt.
- red first: the first new case failed on the old check, which raised a false missing-recording warning for a call through a loop variable.
- verify: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`, exit 0, 148 tests, 148 passed, 0 failed.
- real scan: 5 launches by name and 8 launches through a variable, 0 unrecorded.
- real mutation: a launcher and a helper were appended to the scout command. With the call inside a loop or an error handler whose variable shares the launcher name, the real scan passed, exit 0. With the call placed after the loop closes, it failed on `commands/scout.js:168 runner`, exit 1. The file was restored clean.
- refs: 67 map line refs past the edit moved; none sat between the two edits.
- whitespace: `git diff --check`, exit 0.
- limit: a loop body without braces is not treated as a block, so it still warns; that errs toward a false warning, never a missed launch.
- next_push: let a loop or error handler body without braces hide the launcher name for its single statement.
