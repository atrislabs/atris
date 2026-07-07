# Loop - Feedback

**Owner:** `team/signal-scout`
**Wiki:** [systems/loops.md](../wiki/systems/loops.md)
**Runner:** `rg -c '^(open|claimed)\s+' tasks.md`

**Protects:** every user pain, bug report, or operator note has a visible intake path
into Atris task state or an explicit no-op decision.

**Signal (green =):** `tasks.md` still documents live `open` and `claimed` intake
states, and the intake-count command exits 0.

**Check:** `rg -c '^(open|claimed)\s+' tasks.md >/dev/null`

**Cadence:** per loop audit tick and before release.

**Feeds:** quality.
**Fed by:** users, support, operators, telemetry.

## Log

- 2026-07-07: Setup tick replaced the scaffold owner/check with signal-scout intake ownership; receipt `node bin/atris.js loops audit` exit 0 after the quality loop was configured.
