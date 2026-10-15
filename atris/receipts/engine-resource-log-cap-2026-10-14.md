# Engine resource log size cap

The machine memory log for engine runs now stops growing past 4 MB. Once it passes that size it keeps the newest 2 MB, plus older start lines whose run has no end in the trimmed part, so a long run still pairs with its end.

- test first: the new test failed with "log was not cut back" before the change
- verifier: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`, 74 pass, 0 fail, exit 0
- real run: a 5,242,999 byte log in a scratch project shrank to 2,097,399 bytes after one end line was recorded; the still-running start line was kept; `atris engine sweep` then showed the last SIGKILL on that run
- also: removed two unused exports left by the errored tick

next_push: show the open runs (a start with no end) in atris engine sweep, so a run that died with its parent is visible.
