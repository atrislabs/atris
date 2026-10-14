# Destructured copy receipt

- changed: the runner launch check now treats a copy of the launcher's name pulled out of an object or list inside another function as hiding the launcher, the same as a plain local copy. A renamed key or a longer name still counts as a call to the launcher.
- files: test/engine-resource.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, the member log, and this receipt.
- red first: the first new case failed on the old check, which raised a false missing-recording warning for a destructured copy.
- verify: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`, exit 0, 148 tests, 148 passed, 0 failed.
- real scan: 5 launches by name and 8 launches through a variable, 0 unrecorded.
- real mutation: a launcher and a helper calling it with a runner were appended to the scout command. With an object copy or a list copy of the launcher name in the helper, the real scan passed, exit 0. With the name only as a renamed key, it failed on `commands/scout.js:168 runner`, exit 1. The file was restored clean.
- refs: 67 map line refs past the edit moved; none sat between the two edits.
- whitespace: `git diff --check`, exit 0.
- next_push: let a destructured parameter of another function hide the launcher name, the way a plain parameter does now.
