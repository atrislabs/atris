# Child-cleanup proof uses the supported Node installation

The child-cleanup checks now have saved proof from the supported interpreter, and fixture child commands use the same installation as the test runner. Both affected checks passed, and all 35 required checks passed, exit 0.

Files edited: test/one-lap-runtime.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md, and this receipt. Task commands regenerated atris/TODO.md.

Root cause: direct node is /opt/homebrew/Cellar/node/25.6.1/bin/node; bash -lc selects Node 20.18.0. The original wrapped command fails at CLI initialization with "atris needs Node 22.13 or newer. this is Node 20.18.0." Full captured output: /tmp/atris-tick45-login-proof.txt. Exit 1; pass 0, fail 2. This is an interpreter selection problem, not escaped-child polling.

Change: keep fake engine binaries first on fixture PATH, then the directory of process.execPath, then inherited tools. No product sandbox, authorization, or proof-runner policy changed. Save the targeted proof with the supported executable explicitly. The executable path is specific to this machine; elsewhere use the installed supported Node path.

Verify command: /opt/homebrew/Cellar/node/25.6.1/bin/node --test --test-name-pattern="new session|sandbox group leader" test/one-lap-runtime.test.js
Real invocation through bash -lc, retaining its older default PATH, output:
✔ one lap reaps a detached child that creates a new session (13519.576666ms)
✔ one lap cleanup survives an engine killing its sandbox group leader (7951.486ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 21562.703458
Exit: 0.

Required command: node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
Output excerpt:
✔ an engine benched at error routes again once the window passes, and with no stamp at once (50.326125ms)
ℹ tests 35
ℹ suites 0
ℹ pass 35
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 10796.570084
Exit: 0.

Control: the previous committed test copied to test/.tick45-baseline.test.js also passes when the outer command names Node 25 explicitly (2 passed, exit 0). This proves the saved-command repair is the cause of the restored proof; the fixture PATH change prevents child interpreter drift and is not claimed as a reproduced cleanup bug fix. The temporary baseline was removed.

Saved proof: atris task ready ran the targeted command again and returned exit 0, moving AIC-18 to Review. Receipt: atris/runs/2026-10-14-task-aic-18-2026-10-14T17-33-31-214Z.json. The machine-specific executable path is outside automatic certification, so independent review remains required. No self-accept performed.

Final checks: atris slop detect --diff returned clean, exit 0; git diff --check returned no output, exit 0. Brain activation and compile returned plan-only output, exit 2; absent optional brain files were preserved.

Metric: the failing saved command went from 0/2 passing to 2/2 passing after interpreter selection was corrected. No speed gain is claimed.
Lesson: capture full failing output before suspecting leaked identity variables; a login shell can select a different Node version than the foreground runner.
next_push: Scan test/commands.test.js for the next repeated fixture-only CLI launches and replace one group with in-process setup.
layer: capabilities
