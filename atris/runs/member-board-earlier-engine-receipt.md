Earlier sign-in failures now name their engine when the footer has spare room. Verified by the real watch command at four terminal sizes and the frozen tests, all passed with exit 0.

Files: lib/member-board.js, test/member-board.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/builder/logs/2026-10-14.md.
Artifacts: atris/runs/member-board-earlier-engine-proof.py and this receipt.
The implementation edit was recovered from the interrupted preceding run, then covered by a new regression test.

Flow: earlier signed out -> same engine running: no sign-in reason; different engine running -> name the old engine only if the same footer fits.

Commands: atris mission status mission-2026-10-14-continue-improving-atris-mem-187401de; atris brain activate --root . --verify; atris; atris mission goal --json; atris task list; atris task new; atris task claim BCI-14 --as builder; atris task note BCI-14; git status --short; git diff; git log; source and notebook reads.

Rerun: node --test test/member-board.test.js test/member-result.test.js
Exact summary: tests 68, suites 0, pass 68, fail 0, cancelled 0, skipped 0, todo 0. Exit 0.

Real surface: python3 atris/runs/member-board-earlier-engine-proof.py, exit 0. It invokes node bin/atris.js member board --watch in a real terminal, with temporary progress logs and project members. Each child exits 0 after ctrl-c.
80 columns, 5 rows:
2 more not shown (1 with earlier failure, signed out of claude, scout working)
70 columns, 5 rows:
2 more not shown (1 with earlier failure, signed out, scout working)
40 columns, 5 rows:
2 hidden (1 earlier failure, signed out)
18 columns, 5 rows:
2 hidden

Metric: one new regression test, four row combinations across 123 widths and two heights, plus mixed/unknown engines and a fixed sign-in. Four actual terminal sizes passed. No new dependencies.
Learned: restoring the original current-failure reason after a rejected longer form is necessary before attempting to name an earlier failure's engine; otherwise the second render can displace unrelated footer information.
Stop: one bounded slice verified; no second slice started. The rendered TODO changes predated this work and are excluded from the commit.
next_push: check whether the JSON follow CLI test remains reliable with a slow Node startup, replacing a fixed cutoff only if it reproduces a failure.
layer: behaviors

Review gate: the login shell resolves node to /usr/local/bin/node v20.18.0, below the CLI's required 22.13. Its repeat check failed with 51 pass, 3 fail and 14 cancelled, exit 1; bash reproduction saved at /tmp/atris-builder-95-bash-test.log. The ordinary shell uses /opt/homebrew/bin/node v25.6.1 and passed all 68.
The task reached Review after atris task ready BCI-14 --verify "/opt/homebrew/bin/node --test test/member-board.test.js test/member-result.test.js" passed, exit 0. Gate receipt: atris/runs/2026-10-15-task-bci-14-2026-10-15T00-23-59-375Z.json. The explicit absolute path cannot be automatically certified, so human acceptance remains pending. No tool policy or frozen mission verifier changed.
