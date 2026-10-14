# Launcher name parameter receipt

- changed: the runner launch check no longer credits a launcher with a call that really goes to a helper's parameter of the same name. This now holds when the assigned and internal names match and for plain declared launchers, not only for distinct internal names.
- files: test/engine-resource.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, the member log, and this receipt.
- red first: the new cases failed on the old check, which flagged a launch fed only by a call through a helper parameter.
- cleanup: the two copies of the parameter reading pattern became one shared reader.
- verify: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`, exit 0, 148 tests, 148 passed, 0 failed.
- real scan: 5 launches by name and 8 launches through a variable, 0 unrecorded.
- real mutation: a launcher plus a helper calling it with a runner was appended to the scout command. With a helper parameter hiding the launcher name, the real scan passed, exit 0. With an unrelated parameter, it failed on `commands/scout.js:168 runner`, exit 1. The file was restored clean.
- whitespace: `git diff --check`, exit 0.
- prose: `atris slop detect atris/MAP.md atris/refs/MAP-NOTES.md`, clean.
- next_push: let a local alias declared inside another function hide the launcher name, the way a parameter now does.
