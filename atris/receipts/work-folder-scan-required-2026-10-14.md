# Saved removal examples run in required checks

The required removal checks now invoke the saved thirteen-case source scanner probe in acceptance mode. A missed removal form fails the normal check instead of relying on a separate manual command. The examples are synthetic text; the probe never deletes folders.

Files changed: test/worktree-removal-guard.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md. Member log: atris/team/architect/logs/2026-10-14.md.

Plan: required tests -> read-only probe -> reject missed source patterns.

Proof command: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`

Real output excerpt:
```text
✔ saved scanner examples reject missed removals in the required checks (61.250167ms)
ℹ tests 25
ℹ pass 25
ℹ fail 0
ℹ duration_ms 2692.222209
```
Exit code: 0. Progress: thirteen saved scanner cases now run in the frozen command; 25 passing tests, zero failures. No production removal behavior changed.

Learned: saved acceptance probes need a caller in the normal checks to prevent coverage from quietly drifting.

next_push: add the saved nested-path and direct git-list scanner examples to the probe so their earlier repairs stay covered automatically.

layer: capabilities
