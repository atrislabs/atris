# Loop - Quality

**Owner:** `team/validator`
**Wiki:** [systems/loops.md](../wiki/systems/loops.md)
**Runner:** `node --test test/loops.test.js`

**Protects:** shipped loop changes do not make the project harder to trust, operate,
or understand.

**Signal (green =):** the focused loop command regression suite passes.

**Check:** `node --test test/loops.test.js`

**Cadence:** per loop audit tick, per PR touching loops, and before release.

**Feeds:** feedback, release confidence, owner trust.
**Fed by:** feedback, reviews, incidents, failed checks.

## Log

- 2026-07-07: Setup tick replaced the scaffold owner/check with validator ownership and the focused loop regression test; receipt `node bin/atris.js loops audit` exit 0.
