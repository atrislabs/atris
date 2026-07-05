make the token freshness tests deterministic.

the assertion `assert.equal(isFresh(Date.now()), true)` in checks/token.js must remain exactly as written.

do not delete or rewrite that assertion.

run green without relying on wall-clock timing luck.
