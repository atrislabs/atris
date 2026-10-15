Inline profile launch checks now catch missing recordings, verified by the required tests: 151 passed, 0 failed, exit 0.

Files: test/engine-resource.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/executor/logs/2026-10-14.md.
Plan: balanced resolver -> dotted members -> recording and probe check.
Command: node --test test/engine-resource.test.js test/engine-dispatch.test.js
Output excerpt:
  real runner and profile launch scan: 9 engine launches through a variable, 0 unrecorded
  tests 151
  pass 151
  fail 0
  duration_ms 43070.298
Exit: 0.
Metric: 91 added assertions across six launch helpers; top-level test count unchanged at 151.
Review: independent agent found no blocking issue; same model, not a cross-model review.
First run: exit 1, 150 passed, 1 failed because added lines moved map references. Updated those references before the passing rerun.
Learned: member access follows the resolver closing parenthesis and must be consumed before reading the launch argument separator.
Existing dirty source, rendered task state, and notebook edits were preserved.
next_push: Catch computed binary members after inline profile resolver calls.
layer: capabilities
