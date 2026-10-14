# Sweep counts unfinished runs anywhere in the log

The independent check on the last tick failed: a run with no end whose start sat more than a megabyte back was reported as zero. The history reader now reads up to the 4 MB size cap, which covers the whole log once it has been cut back, so those starts are counted.

- test first: the new test failed with 0 counted, 1 expected, matching the check
- verifier: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`, 76 pass, 0 fail, exit 0
- real run, the check's own case: `node bin/atris.js engine sweep --json` on a 1,258,307 byte log with one unfinished run at the top, exit 0, open_runs 1, newest deep-open
- real run, trimmed case: a 5 MB log cut to 2,097,701 bytes on the next append kept the unfinished start; sweep exit 0 reported 2 open runs (that one plus the new run)
- limit: a log that grew past 4 MB before the cap existed is read from its tail until the next append cuts it

next_push: close open runs whose parent is gone with an honest cause line.
