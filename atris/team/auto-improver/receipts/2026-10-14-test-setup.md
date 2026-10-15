Landing test setup now avoids two command launches per fixture, verified with the real landing tests and required checks.

Files edited: test/autoland.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md, this receipt.

The test edit was left by the interrupted previous run. This increment inspected it, verified it, added navigation and evidence, and submitted it for review. No assertions or production code changed.

Before: node --test test/.autoland-before-tick10.test.js, an exact temporary copy of HEAD:test/autoland.test.js placed beside the original so its relative imports resolve. Exit 0. The temporary file was removed after the comparison.

After and rerunnable check: node --test test/autoland.test.js test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js. Exit 0.

Metric: baseline 55.59 seconds, updated combined check 49.35 seconds. The runs overlapped, so timing is directional. Two fewer command launches per seeded task is the structural improvement.

Output excerpt:
```text
ℹ tests 104
ℹ pass 104
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 49352.541
```

Full baseline output:
```text
autoland tick: 0 reviews certified, 0 landed, 0 alarms, digest not due, janitor stopped 0 missions + reaped 0 worktrees, wishes: sweep failed (wish sweep exploded), receipt atris/runs/autoland-tick-2026-10-14T15-26-37-364Z.json
✔ digest and alarm compose in plain language (3.73675ms)
✔ digest acceptance history is not capped by the compact done-task projection (308.031542ms)
✔ digest says accepted, not landed, for work without a passed landing proof (0.217292ms)
✔ digest folds unclear landed results across members into one count (0.198292ms)
✔ unclear accepted-but-not-landed results read as plain English, never "accepteds" (0.150333ms)
✔ expanded story excludes a saved landing when its digest result did not clear the headline gate (0.846167ms)
✔ expanded digest points to the full story below instead of rerunning itself (0.162209ms)
✔ operatorReady: a queue sentence earns its digest surface with a why, no agent jargon (0.098542ms)
✔ result gate accepts a complete act-on phrase but rejects a dangling on ending (0.529417ms)
✔ digest falls back to the complete landing when shortening the result removes its why (0.553291ms)
✔ digest reports protected reviews before certification (777.909917ms)
✔ autoland status does not call one-pass protected work approval-ready (823.449291ms)
✔ autoland status speaks in plain sentences and puts your decisions first (2503.934459ms)
✔ digest next moves withhold duplicate objective review until promised time is used (95.104833ms)
✔ clarify: the gate strips agent jargon and closes the thought before an operator reads it (0.482584ms)
✔ live update: a landing texts its capability sentence the moment it lands (0.368625ms)
✔ digest and live update render plain trust labels without scores (2.30575ms)
✔ live update receipt keeps the exact sent text when the daily digest is sent too (2137.687583ms)
✔ heartbeat digest status distinguishes sent, saved, and not due (0.12375ms)
✔ historical digest landing repairs the accepted as-exists fragment (0.161791ms)
✔ due digest without a phone is composed and saved in the durable heartbeat receipt (909.518708ms)
✔ alarm dedupe: a task pings once per window (0.184167ms)
✔ policy file gates live accept authorization (64.658583ms)
✔ status presents default autoland owner as inferred, not configured state (185.984667ms)
✔ cron line is labeled and removable (0.403167ms)
✔ autoland status never probes a stalled crontab (185.79275ms)
✔ autoland status holds probation work without executing recorded verifiers (2.982959ms)
✔ autoland help forms are read-only and do not run a heartbeat (1207.547583ms)
✔ live auto-accept refuses without policy, lands with it, blocks denied lanes (2743.046375ms)
✔ tick blocks uncited suite-green proof and cites the needed run in its receipt (1373.697292ms)
✔ tick lands the same suite-green proof when it cites a fetched CI run URL (2248.505875ms)
✔ tick still lands an ordinary command proof with exit 0 (2141.941791ms)
✔ tick certifies proof-backed reviews by re-running their check, then lands them (2773.7515ms)
✔ tick reuses the certification verifier result at landing (2345.789125ms)
✔ tick runs a failing certification verifier once and never lands it (1737.001291ms)
✔ tick revises certified stale allowlisted verify instead of awarding reward (1613.380458ms)
✔ tick lands certified allowlisted verify when the landing re-run passes (2100.982958ms)
✔ one heartbeat runs an identical verifier once for every matching task (2163.487875ms)
✔ one cached verifier failure revises every matching task (2012.77675ms)
✔ tick never executes a non-allowlisted verify at landing — it bounces the task instead (1399.1085ms)
✔ auto-accept-certified json includes unsafe verify blockers with a reason (1268.957084ms)
✔ tick from an agent session lands under the standing policy with a real-number receipt (1934.223375ms)
✔ tick still certifies when policy contains drain_reviews false (1780.122416ms)
✔ two passes from one actor cannot land until the tick independently re-runs the check (2003.288708ms)
✔ landing sweep auto-lands merged branch residue (219.195959ms)
✔ landing sweep reaps TTL-expired work through the salvage contract (274.227334ms)
✔ landing sweep leaves a recent live worktree untouched (355.768583ms)
✔ landing sweep escalates 48h-stale active work into the digest (261.695416ms)
✔ tick drains the landing hourly: landed branches reap themselves every run (1472.826125ms)
✔ tick janitor keeps fresh worktrees; old residue is salvaged and reaped (1244.2705ms)
✔ accept_all policy: check-less work bounces back for a verify, protected lanes wait (1724.835625ms)
✔ tick is a no-op when the policy is off (662.873875ms)
✔ autoland tick survives a throwing wish sweep (610.410625ms)
✔ tick lock: a live concurrent tick is skipped, a stale lock is not (839.168333ms)
✔ a failed landing sweep is not a secret: receipt, state, status, digest all carry it (872.253583ms)
✔ daily tick expires missions parked for a week, keeps fresh and running ones (748.943375ms)
✔ janitor: a zombie paused mission and a merged worktree disappear on the next tick (1564.041083ms)
✔ janitor: policy janitor:false leaves the zombie mission while landing sweep still protects fresh worktrees (747.738917ms)
✔ digest carries the janitor tally in plain language, silent when it did nothing (0.31625ms)
✔ daily tick verifies planning missions after all linked repair tasks close (1449.556333ms)
✔ daily experiment hook runs when policy allows (741.059209ms)
✔ daily experiment hook is skipped when daily_experiment is false (667.664083ms)
✔ verify commands run without inheriting a shell PATH (53.796417ms)
✔ an unrunnable check is an alarm, never a failing verdict (0.225ms)
✔ a missing verifier binary blocks accept-all instead of landing unchecked (113.227834ms)
✔ a protected lane declared in the task text blocks auto-accept (0.143417ms)
✔ an untagged money-lane task is caught by its text (0.111917ms)
✔ ordinary untagged work is not held by the protected-lane guards (0.098625ms)
✔ status path refuses a disallowed check instead of promising a landing (1.659875ms)
ℹ tests 69
ℹ suites 0
ℹ pass 69
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 55588.078916
```

Full updated output:
```text
✔ digest and alarm compose in plain language (5.343542ms)
✔ digest acceptance history is not capped by the compact done-task projection (383.726958ms)
✔ digest says accepted, not landed, for work without a passed landing proof (0.241084ms)
✔ digest folds unclear landed results across members into one count (0.188792ms)
✔ unclear accepted-but-not-landed results read as plain English, never "accepteds" (0.128792ms)
✔ expanded story excludes a saved landing when its digest result did not clear the headline gate (0.914917ms)
✔ expanded digest points to the full story below instead of rerunning itself (0.167625ms)
✔ operatorReady: a queue sentence earns its digest surface with a why, no agent jargon (0.101917ms)
✔ result gate accepts a complete act-on phrase but rejects a dangling on ending (0.603916ms)
✔ digest falls back to the complete landing when shortening the result removes its why (0.60675ms)
✔ digest reports protected reviews before certification (1029.801792ms)
✔ autoland status does not call one-pass protected work approval-ready (819.498375ms)
✔ autoland status speaks in plain sentences and puts your decisions first (1646.829209ms)
✔ digest next moves withhold duplicate objective review until promised time is used (83.632125ms)
✔ clarify: the gate strips agent jargon and closes the thought before an operator reads it (0.20575ms)
✔ live update: a landing texts its capability sentence the moment it lands (0.355208ms)
✔ digest and live update render plain trust labels without scores (1.826708ms)
✔ live update receipt keeps the exact sent text when the daily digest is sent too (1959.70875ms)
✔ heartbeat digest status distinguishes sent, saved, and not due (0.104583ms)
✔ historical digest landing repairs the accepted as-exists fragment (0.116166ms)
✔ due digest without a phone is composed and saved in the durable heartbeat receipt (864.125041ms)
✔ alarm dedupe: a task pings once per window (0.179208ms)
✔ policy file gates live accept authorization (60.906417ms)
✔ status presents default autoland owner as inferred, not configured state (175.864834ms)
✔ cron line is labeled and removable (0.352542ms)
✔ autoland status never probes a stalled crontab (182.279209ms)
✔ autoland status holds probation work without executing recorded verifiers (3.007208ms)
✔ autoland help forms are read-only and do not run a heartbeat (912.09125ms)
✔ live auto-accept refuses without policy, lands with it, blocks denied lanes (2144.21ms)
✔ tick blocks uncited suite-green proof and cites the needed run in its receipt (1113.921416ms)
✔ tick lands the same suite-green proof when it cites a fetched CI run URL (1989.7045ms)
✔ tick still lands an ordinary command proof with exit 0 (1937.132375ms)
✔ tick certifies proof-backed reviews by re-running their check, then lands them (2275.743375ms)
✔ tick reuses the certification verifier result at landing (2187.654708ms)
✔ tick runs a failing certification verifier once and never lands it (1501.161ms)
✔ tick revises certified stale allowlisted verify instead of awarding reward (1371.130333ms)
✔ tick lands certified allowlisted verify when the landing re-run passes (2046.799125ms)
✔ one heartbeat runs an identical verifier once for every matching task (1534.083083ms)
✔ one cached verifier failure revises every matching task (1465.067125ms)
✔ tick never executes a non-allowlisted verify at landing — it bounces the task instead (1135.469417ms)
✔ auto-accept-certified json includes unsafe verify blockers with a reason (1272.102ms)
✔ tick from an agent session lands under the standing policy with a real-number receipt (1670.916541ms)
✔ tick still certifies when policy contains drain_reviews false (1573.743458ms)
✔ two passes from one actor cannot land until the tick independently re-runs the check (1834.15925ms)
✔ landing sweep auto-lands merged branch residue (220.548583ms)
✔ landing sweep reaps TTL-expired work through the salvage contract (286.889541ms)
✔ landing sweep leaves a recent live worktree untouched (359.775292ms)
✔ landing sweep escalates 48h-stale active work into the digest (242.480583ms)
✔ tick drains the landing hourly: landed branches reap themselves every run (1445.20275ms)
✔ tick janitor keeps fresh worktrees; old residue is salvaged and reaped (1196.959ms)
✔ accept_all policy: check-less work bounces back for a verify, protected lanes wait (1466.6605ms)
✔ tick is a no-op when the policy is off (442.931208ms)
✔ autoland tick survives a throwing wish sweep (610.706292ms)
✔ tick lock: a live concurrent tick is skipped, a stale lock is not (839.190584ms)
✔ a failed landing sweep is not a secret: receipt, state, status, digest all carry it (880.167166ms)
✔ daily tick expires missions parked for a week, keeps fresh and running ones (738.224916ms)
✔ janitor: a zombie paused mission and a merged worktree disappear on the next tick (1535.01375ms)
✔ janitor: policy janitor:false leaves the zombie mission while landing sweep still protects fresh worktrees (740.416625ms)
✔ digest carries the janitor tally in plain language, silent when it did nothing (0.23475ms)
✔ daily tick verifies planning missions after all linked repair tasks close (1501.630333ms)
✔ daily experiment hook runs when policy allows (724.082291ms)
✔ daily experiment hook is skipped when daily_experiment is false (646.994667ms)
✔ verify commands run without inheriting a shell PATH (52.250916ms)
✔ an unrunnable check is an alarm, never a failing verdict (0.197541ms)
✔ a missing verifier binary blocks accept-all instead of landing unchecked (111.419625ms)
✔ a protected lane declared in the task text blocks auto-accept (0.140416ms)
✔ an untagged money-lane task is caught by its text (0.105375ms)
✔ ordinary untagged work is not held by the protected-lane guards (0.090875ms)
✔ status path refuses a disallowed check instead of promising a landing (1.628042ms)
✔ the run record rotates aside at its size cap and every record still reads (223.667959ms)
✔ a rename that fails deletes nothing and the append still lands (153.942875ms)
✔ only the newest rotated files remain after many rotations (138.9865ms)
✔ a record line with odd field types reads cleanly and never crashes the runs view (228.403792ms)
✔ a worker line reads "prep: search" and the roster view notes "prep: search" (156.918375ms)
✔ prep naming its own job warns in plain words and the worker still counts (137.916792ms)
✔ assign --prep writes the field, and refuses a job prepping for itself (163.666042ms)
✔ a worker with prep: search runs the search lead first and gets a prompt with the brief (1031.823709ms)
✔ the brief is capped at its line and size limits (1040.01075ms)
✔ a prep stall or empty answer still runs the heavy worker and records "prep skipped" (4121.952917ms)
✔ prep naming its own job runs the worker without prep (627.767875ms)
✔ a worker without prep runs exactly as before (719.386709ms)
✔ a handover backup preps only when its own line asks (1980.734458ms)
✔ a one-lap reviewer with prep reads the brief before it reviews (417.733417ms)
✔ a fleet build on the build lead honors its prep line (484.632708ms)
✔ a reviewer past a credit wall reuses the brief when the next reviewer also preps (483.524542ms)
✔ an append after rotation lands in the fresh file, and a raced write stays readable (87.289959ms)
✔ "rate limit" in a failed run's own output leaves the engine ready; the same text on stderr marks credit_out (1187.664583ms)
✔ a successful dispatch records landed with its engine, model, time cap, and seconds (716.784167ms)
✔ a stalled lead and a successful backup record two lines: stalled and handed over, then landed (1794.276625ms)
✔ a real task failure records failed with the task reason; "rate limit" in the output is not credit out (1550.627625ms)
✔ tokens come from the tool's own usage line, and stay empty when it prints none (2316.872334ms)
✔ the roster shows each worker's recent record, and nothing when there are no records (105.11175ms)
✔ --runs lists attempts newest first, at most 20, and can pick one job (101.008208ms)
✔ --runs --json gives every run its model and every run that did not land a one-line reason (109.020959ms)
✔ a corrupt line or a missing file is skipped, never an error (123.845083ms)
✔ a mission tick on a roster engine records its outcome, time, and reported usage (129.193959ms)
✔ an autopilot phase on a roster worker records landed with tokens, or stalled at its cap (1408.726375ms)
✔ a one-lap review records each validator attempt, handed over past a credit wall (165.833375ms)
✔ a failed run whose own output says "connection closed" or "overloaded" is not a stall (108.562875ms)
✔ fleet dispatch does not retry a run whose own output looks like a dropped connection (738.926208ms)
✔ the same dropped-connection text in stderr is a stall and benches the engine (101.224541ms)
✔ a failed run whose report says "rate limit" leaves health alone; the same text in stderr marks credit_out (116.13975ms)
✔ a real task failure leaves the engine ready and still resolvable as the roster pick (139.933625ms)
✔ an engine benched at error routes again once the window passes, and with no stamp at once (126.835709ms)
ℹ tests 104
ℹ suites 0
ℹ pass 104
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 49352.541
```

Frozen check: `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`, exit 0. Exact summary: tests 35, pass 35, fail 0, cancelled 0, skipped 0, todo 0, duration_ms 10981.353959.

Review handoff: proof-only submission required an executed check. Its first `node --test` run selected an older Node without `node:sqlite` (35 passed, 1 failed, exit 1). Re-submitted with `/opt/homebrew/Cellar/node/25.6.1/bin/node --test test/autoland.test.js test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`, the runtime used by the successful direct checks. This exited 0 and moved the task to Review; executed proof is saved at atris/runs/2026-10-14-task-aic-1-2026-10-14T15-28-55-127Z.json. No self-acceptance was performed.

Setup tools: atris brain activate --root . --verify and atris brain compile --root . both exited 2 in plan-only mode; no generated policy adapters were written. Mission status and task list were inspected before choosing work.

next_push: Replace the remaining repeated task-creation setup launches in the landing tests while keeping ready and landing checks on the CLI.
layer: capabilities
