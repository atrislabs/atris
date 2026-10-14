## Fast smoke checks use their own engine
- shipped: the test supplies its own engine installation and selection, preserving all existing assertions and adding checks for the expected scope and installed state.
- proof: node --test test/smoke.fast.test.js, exit 0; git diff --check, exit 0. Full repeated-run output: atris/runs/2026-10-13-smoke-engine-isolation.md.
- reply: keep / revert
