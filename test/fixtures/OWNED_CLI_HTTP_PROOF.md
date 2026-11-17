# Local cross-repository HTTP/process proof

Run only the added test, selecting the real helper explicitly:

ATRIS_OWNED_CLI_PATH=/path/to/atrisos-backend/backend/execution/owned_cli.py node --test test/computer-pr-owned-integration.test.js

Observed: 3 passed in approximately 7 seconds. When the environment variable is absent, tests skip with a clear setup message.
An explicitly supplied invalid path fails the test process. The test never
silently chooses a shared-workspace module or vendors a replacement.

Uses actual utils/api.js apiRequestJson and lib/computer-pr-bounded.js
runBoundedPrRound against a Python asyncio HTTP fixture on 127.0.0.1, ephemeral
port. Fixture imports real owned_cli and runs real Python sleep children in
separate process groups. No auth token is supplied; fixture rejects Authorization.

1. TCP response deliberately dropped after starting child: exactly one start POST,
   outcome unknown, no retry/cancel without captured ID. Finally cleans child.
2. Captured ID, elapsed client deadline: exactly one scoped cancel; real helper
   raises OwnedCliCancelled; owned group gone; unrelated child still alive.
3. Injected inability to inspect process group: helper raises CleanupUnconfirmed;
   failed event with cleanup unknown is never treated as terminal proof.

Each fixture shuts down in finally, cancels/awaits owned jobs, kills/reaps unrelated
child, and closes server. JS teardown checks groups disappeared, with bounded
fixture timeout and defensive group-kill fallback. No whole test suite was run.

Limits: test protocol adapter is NOT production FastAPI routes, auth middleware,
runner admission, durable acceptance/recovery, credentials, Codex/Claude login or
model execution. It does not prove billing policy, deployed version compatibility,
escaped descendant containment, power-loss recovery, or full-runner end-to-end
behavior. Group inspection failure is deliberately injected; ordinary child exit
and cancellation are real. No production network calls or live tasks were made.

Follow-up hardening: real receiptWriter writes/fsyncs/renames JSON in a temporary
directory. Every returned receipt is compared exactly with disk JSON, including
execution ID, and mode0600 is checked before cleanup. Fixture waits for numeric
PID-file contents. Cancellation validates exact execution and workspace IDs;
a wrong execution ID returns404 while both children remain alive. The successful
cancel records the queried IDs and assertions verify them. Fallback fixture kill
awaits exit before reading exitCode. In-flight round is awaited even if a negative
assertion fails, before restoring the HTTP base URL.

Verified selected helper SHA-256:
5a51db1036956655d922aa824a368bf5717ce0143ae491d4728ad5c0f0acf410

Local test result after these changes:3 passed; no production authentication,
backend routing, runner dispatch or Codex subscription login was verified.

Setup failure coverage: child creation and all later fixture setup now sit inside
one outer try/finally with nullable server/child handles. A fourth test holds a
real127.0.0.1 listening port open, asks fixture to bind it, and observes actual
address-in-use failure after unrelated child creation. A PID audit file lets Node
verify process-group ESRCH after fixture exits1. No ready message appears before
successful binding. Cleanup closes the occupied socket and deletes test files.
Four tests pass with the same explicit helper selection; only added tests ran.

Teardown waits for graceful fixture exit after /shutdown before a 2.5-second
SIGTERM fallback; a separate 6-second fallback kills and awaits the fixture.
This avoids signaling during Python's natural signal-handler teardown.
