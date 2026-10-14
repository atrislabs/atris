# One hiding rule receipt

- changed: the runner launch check now uses one rule to decide when a name is hidden. The launcher's own copy of its internal name goes through the same check as copies in other functions, so a copy inside a sibling helper no longer hides a later call.
- files: test/engine-resource.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, the member log, and this receipt.
- red first: the new case failed on the old check, which read the launcher body raw and let a copy inside a nested helper silence a real unrecorded launch.
- verify: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`, exit 0, 148 tests, 148 passed, 0 failed.
- real scan: 5 launches by name and 8 launches through a variable, 0 unrecorded.
- real mutation: a named launcher was appended to the scout command. With the copy of its internal name inside a sibling helper, the real scan failed on `commands/scout.js:172 runner`, exit 1. With the copy directly in the launcher body, it passed, exit 0. The file was restored clean.
- refs: 67 map line refs past the edit moved by two lines; none sat between the two edits.
- whitespace: `git diff --check`, exit 0.
- next_push: let a destructured copy inside another function hide the launcher name, the way a plain local copy does now.
