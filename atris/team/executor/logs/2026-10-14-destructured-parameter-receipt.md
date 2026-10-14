# Destructured parameter receipt

- changed: the runner launch check now reads the names a function's parameters really bind, including names pulled out of an object or list. A function that takes the launcher's name that way hides the launcher, the same as a plain parameter. A renamed key, a default value, or a longer name still counts as a call to the launcher.
- files: test/engine-resource.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, the member log, and this receipt.
- red first: the first new case failed on the old check, which read an object parameter as one odd name and raised a false missing-recording warning.
- verify: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`, exit 0, 148 tests, 148 passed, 0 failed.
- real scan: 5 launches by name and 8 launches through a variable, 0 unrecorded.
- real mutation: a launcher and a helper calling it with a runner were appended to the scout command. With the launcher name as an object parameter or a list parameter of the helper, the real scan passed, exit 0. With the name only as a renamed key or a default value, it failed on `commands/scout.js:168 runner`, exit 1. The file was restored clean.
- refs: 67 map line refs past the edit moved; none sat between the two edits.
- whitespace: `git diff --check`, exit 0.
- next_push: let a catch clause or loop variable named like the launcher hide it inside its own block, the way a local copy does now.
