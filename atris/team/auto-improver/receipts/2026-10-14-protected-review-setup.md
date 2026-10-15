Protected-review test setup now avoids six command launches; the real landing-output checks and the required three files passed together, exit 0.

Files: test/autoland.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md, this receipt.

Change: seedClaimedTask accepts a claimant, defaulting to builder. Three security-tagged fixtures now seed and claim through the real task database as linguist. Their ready, digest, and status commands and behavior assertions remain intact.

Baseline command:
node --test --test-name-pattern='digest reports protected reviews before certification|autoland status does not call one-pass protected work approval-ready|autoland status speaks in plain sentences' test/autoland.test.js
Output: tests 3, pass 3, fail 0, cancelled 0, skipped 0, todo 0, duration_ms 2654.413167. Exit 0.
Case durations: 661.91025, 579.803833, 1324.49875 ms, totaling 2566.212833 ms.

Rerunnable proof command:
node --test test/autoland.test.js test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
Runtime: /opt/homebrew/Cellar/node/25.6.1/bin/node.
Real output excerpt:
✔ digest reports protected reviews before certification (598.704875ms)
✔ autoland status does not call one-pass protected work approval-ready (403.597292ms)
✔ autoland status speaks in plain sentences and puts your decisions first (1270.738834ms)
ℹ tests 104
ℹ pass 104
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 45783.766541
Exit 0. The frozen three-file check is included unchanged in this run.

Metric: six fewer CLI setup launches. The three cases totaled 2273.041001 ms, about 11.4% below baseline; timing is directional because baseline was focused and proof ran all four files concurrently.

Administration: inspected mission status, ran Atris boot and task list, created and claimed AIC-2, recorded objective, and submitted proof to Review. Mission attach-task was refused by a live lock; no lock or mission state was changed. Brain activate/compile were plan-only, exit 2; unrelated generated policy changes were not added. The local task commands replaced the legacy rendered TODO with the isolated database view; restore only that generated change before shipping.

Review submission: free-text proof was refused because the submitting process had not executed the check. Re-ran the exact four files through atris task ready using /opt/homebrew/Cellar/node/25.6.1/bin/node. Passed 104, failed 0, cancelled 0, skipped 0, todo 0, duration_ms 53947.560166, exit 0. Saved executed receipt: atris/runs/2026-10-14-task-aic-2-2026-10-14T15-32-49-849Z.json. Task is in Review; the absolute executable requires an independent review because it is outside the auto-certify allowlist. No task was self-accepted. Restored only the task-command-generated legacy TODO change.

Lesson: pass the original claimant to the real-store setup helper so ownership stays identical while removing launch overhead.
next_push: Replace the three remaining task-creation setup launches in autoland tests while preserving their ready and landing checks.
layer: capabilities
