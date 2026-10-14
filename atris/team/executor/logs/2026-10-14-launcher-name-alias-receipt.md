# Launcher name alias receipt

- changed: the runner launch check no longer credits a launcher with a call that really goes to a local copy of the same name declared earlier in another function holding the call.
- files: test/engine-resource.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, the member log, and this receipt.
- red first: the new cases failed on the old check, which flagged a launch fed only by a call through a local copy in another function.
- verify: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`, exit 0, 148 tests, 148 passed, 0 failed.
- real scan: 5 launches by name and 8 launches through a variable, 0 unrecorded.
- real mutation: a launcher plus a helper calling it with a runner was appended to the scout command. With a local copy of the launcher name in the helper, the real scan passed, exit 0. With a longer, different name, it failed on `commands/scout.js:168 runner`, exit 1. The file was restored clean.
- whitespace: `git diff --check`, exit 0.
- prose: `atris slop detect atris/MAP.md atris/refs/MAP-NOTES.md`, clean.
- next_push: fold the separate internal-name local copy check into the shared shadow check, so one rule decides when a name is hidden.
