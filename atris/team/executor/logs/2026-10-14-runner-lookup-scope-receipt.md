# Runner lookup scope receipt

- changed: when the check traces a launch's program back to where it was set, it now skips declarations inside a block or callback that closed before the launch. Before, it took the last same-named declaration even from a closed block, so an engine launch could be read as a plain program and missed, and a plain launch could be read as an engine and wrongly flagged. The brace rule from the previous tick now lives in one shared helper used by both the program lookup and the launcher name check.
- files: test/engine-resource.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, the member log, and this receipt.
- red first: the first new case failed on the old check, which missed an unrecorded engine launch.
- verify: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`, exit 0, 148 tests, 148 passed, 0 failed.
- real scan: 5 launches by name and 8 launches through a variable, 0 unrecorded.
- real mutation, old check against new: a function was appended to the scout command, and the previous commit's check ran from a temporary copy. Engine program outside with a plain program in a closed block: old exit 0 (missed), new exit 1 on `commands/scout.js:172 program`. Plain program outside with an engine program in a closed block: old exit 1 (false warning), new exit 0. The temporary copy was removed and the scout file restored clean.
- refs: 67 map line refs past the edit moved; none sat between the edits.
- whitespace: `git diff --check`, exit 0.
- next_push: apply the same scope rule to the launcher-argument trace, so an argument variable set inside a closed block is not credited to a later call.
