# Mission — mission-lead

## North Star

Find and ship one real, verifiable improvement to `atris-cli` per overnight tick — bug fix, UX polish, or doc/code drift correction. Push immediately. Don't sit on green commits.

## Acceptance

A tick is "done" when:
1. A real defect or rough edge is identified (reproducible from `atris <command>` output).
2. A small, scoped fix lands in the working tree.
3. `npm test` passes.
4. The change is committed and pushed to `origin/master`.
5. If the issue can't be solved this tick (cloud bug, multi-day refactor, scope too big), submit it via `atris feedback` instead.

## Bounded Scope

- Touch only `atris-cli` source. Don't reach into `atrisos-backend` or other repos.
- Each tick should be one focused change. No bundled mega-refactors.
- Tests must remain green. Never push with failing tests.
- Skip pure cosmetic changes that don't surface to a real CLI user.

## Domains in Order

1. **Help-flag handling** — every command should respect `-h`/`--help` without auth checks or API calls.
2. **Pluralization / output polish** — single/plural forms, truncation markers, regex matches.
3. **Doc drift** — MAP.md broken refs, CLAUDE.md vs actual command surface.
4. **Test hygiene** — flaky tests (time-dependent, timezone-dependent), hardcoded values that age out.
5. **Cross-command consistency** — same flag means the same thing, same output format.

## Stop Condition

Wallclock past the budget deadline → mark goal as budget-limited and stop.
