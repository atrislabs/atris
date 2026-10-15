The launch check now follows runner arguments through a second local helper. The required tests passed, exit 0.

Changed files: test/engine-resource.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/executor/logs/2026-10-14.md, and this receipt.

Verify command: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`
Output excerpt: tests 148; pass 148; fail 0; cancelled 0; skipped 0; todo 0. Exit 0.
Real repository scan: 5 launches by name and 8 engine launches through variables, 0 unrecorded.
Additional commands: `node --check test/engine-resource.test.js` (exit 0), `git diff --check` (exit 0), `node bin/atris.js slop detect --diff` (exit 0, clean, no slop tells in 6 files).

Progress: 22 regression assertions added inside the existing launch check. Four helper forms cover missing recordings, valid recordings, help probes, unrelated programs, and profiles. Two circular-call cases prove termination and discovery of another engine caller. The existing call filtering and shadow checks are reused; no dependencies added.

The first required test run passed 147 tests and failed only the stale navigation-line check. Updated both maps to the new test start lines, then the same command passed all 148 tests.

Task attachment was unavailable because the running mission holds its lock. No mission settings or unrelated edits were changed. Brain activation and compilation reported planned generated files; no generated policy files were written.

Learned: recursive parameter lookup needs a separate visited-binding set for each call path, so a circular branch cannot suppress another caller that supplies an engine. Captured parameters in nested helpers remain a separate scope case for the next increment.
next_push: Follow a forwarded runner parameter captured by a nested helper with no runner parameter of its own.
layer: capabilities
