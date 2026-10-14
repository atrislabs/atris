# Helper launch boundary receipt

- changed: a parent function's recording no longer covers an unrecorded engine launch inside a helper it defines, in both launch checks.
- files: test/engine-resource.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, the member log, and this receipt.
- red first: five new assertions failed on the old check, which returned no findings for a launch inside a helper under a recording parent.
- verify: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`, exit 0, 148 tests, 148 passed, 0 failed.
- real scan: 5 launches by name and 8 launches through a variable, 0 unrecorded.
- real mutation: a helper holding an unrecorded claude launch was planted under the recorded scout run; the real scan failed on `commands/scout.js:72 claude`, exit 1, and the file was restored clean.
- whitespace: `git diff --check`, exit 0.
- prose: `atris slop detect atris/MAP.md atris/refs/MAP-NOTES.md`, clean.
- next_push: let a helper count as recorded when the recording parent calls it by name after recording, so a real local retry helper is not flagged once one appears.
