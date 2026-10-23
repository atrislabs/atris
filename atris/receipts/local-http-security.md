# Local HTTP server security

Fix both confirmed findings in the supplied overnight report, plus the required request, credential, Host and binding behavior across every production HTTP listener. Stop at a local commit for orchestrator review.

```text
request -> valid URL -> local Host -> session credential
        -> same-origin browser write -> bounded JSON object -> route
```

## Fixed

- Phone: malformed request targets return 400 before credential checks, rather than rejecting the unawaited handler and stopping the CLI. The actual listener also catches unexpected handler rejections. Invalid JSON and non-object payloads return 400; requests over 4096 bytes return 413 without destroying the connection before responding.
- Board: reads and changes now share a random 32-byte per-run token. GET accepts the private link token or `x-atris-token`; every mutation requires the header. A loopback Host check runs before routing. Browser writes with a foreign Origin are refused, and JSON content type is required. Invalid URLs and JSON return 400, and bodies over 1,000,000 bytes return 413, measured as bytes, including multibyte text.
- Board: the CLI binds 127.0.0.1 even when `--host localhost` is requested, and refuses other host settings. Responses prevent caching and referrer leakage of the pairing link. Error handling catches failures while responding, too.
- Preview: explicitly read-only GET/HEAD routes; writes return 405, request bodies return 400, and malformed targets return 400. Existing local Host checks and loopback binding remain.

## Complete listener inventory

| Listener | Boundary and coverage |
|---|---|
| `commands/gm.js:1528`, handler `lib/gm-phone.js:304` | Token on all requests; allowlisted bound hosts; same-origin token-header JSON writes; 400/413 malformed input; loopback plus selected LAN interface for phone pairing. Real HTTP and LAN-interface regression tests. |
| `commands/task.js:13517`, gate `commands/task.js:13487` | New shared per-run token, loopback Host and binding, same-origin browser writes, bounded JSON. All mutation paths checked without a token, including accept, revise, claim, creation and review execution. Real database remains unchanged on denied calls. |
| `lib/site.js:104` | Loopback, local Host allowlist, GET/HEAD only, rejects bodies and malformed URLs. Real HTTP tests. |
| `lib/secret-gateway.js:240` | Already loopback, local Host and placeholder credential checks, read-only GET/HEAD grant, no request bodies. New real HTTP tests cover malformed targets, invalid JSON writes, oversized bodies, and continued availability. No production change needed. |
| `scripts/det/xsearch-bench.js:129` | Loopback benchmark stub, unconditional 401 for every request, including foreign hosts, writes and malformed input. No user mutations. Exported its existing factory for real HTTP regression coverage. |

Inventory command: `rg -n 'createServer\s*\(|\.listen\s*\(' --glob '!test/**' --glob '!atris/**' --glob '!node_modules/**' .`. It found only these five production listeners; test fixture listeners are not shipped services.

## User-visible changes

- Open the board using the complete private link printed at startup. Restarting creates a new token, so old links stop working. API callers send `x-atris-token` and JSON for mutations. A browser mutation must come from the board's own origin; native API clients can omit Origin but still need the token.
- The board no longer supports a LAN or wildcard `--host`; it is local only. Its startup labels are lowercase.
- Bad requests return 4xx responses while the session remains available. JSON arrays, scalars and null are refused as request bodies. Static previews no longer serve a page in response to POST/PUT/PATCH/DELETE.
- Phone pairing remains on the documented same-network design: the existing QR code and private link use the selected LAN IPv4 and fresh token; the listener also opens 127.0.0.1. The phone page keeps using `x-gm-token` and its own Origin for actions. A regression opened the real LAN interface and completed an authenticated read and action there. No physical phone was available for a camera/browser test.
- Valid encoded query values still work. No dependencies or package paths were added or removed.

## Files

| Files | Change |
|---|---|
| `commands/gm.js`, `lib/gm-phone.js` | Phone URL, body and rejection handling. |
| `commands/task.js` | Board credential, Host, Origin, JSON, response and binding protections; browser credential forwarding. |
| `lib/site.js` | Read-only methods, body rejection and safe URL parsing. |
| `scripts/det/xsearch-bench.js` | Export existing denial listener for real runtime testing. |
| `test/gm-phone.test.js`, `test/task-api.test.js`, `test/site.test.js`, `test/secret-gateway.test.js`, `test/x-post-check.test.js` | Real HTTP security and compatibility regressions, including LAN pairing and the browser's actual API helper. |
| `test/commands-6.test.js`, `test/commands-7.test.js`, `test/helpers/commands-fixtures.js` | Existing CLI integration tests use the new token; failed startup diagnostics redact private link tokens. |
| `README.md`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, this receipt | API usage, updated navigation and evidence. |

## Verification

Runtime: Node v24.2.0. Test and pack commands ran directly, with their actual exit codes, without filtering pipelines. Full suite output is retained at `/tmp/sec-overnight/cli-servers-final-tests.log`.

| Command | Before | After |
|---|---|---|
| `atris worktree guard` | n/a | exit 0, `atris worktree guard: ok` |
| `node --test --test-name-pattern='malformed phone URLs' test/gm-phone.test.js` | exit 1, `TypeError: Invalid URL` | exit 0, tests 1, pass 1, fail 0 |
| `node --test --test-name-pattern='refuses a cross-site task creation' test/task-api.test.js` | exit 1, `200 !== 403` | exit 0, tests 1, pass 1, fail 0 |
| Combined command below | n/a | exit 0, tests 371, suites 2, pass 371, fail 0, cancelled 0, skipped 0, todo 0 |
| `npm pack --dry-run --json` | exit 0 | exit 0, same 641 package paths |
| Package path comparison below | n/a | exit 0, `package file list unchanged: 641 paths` |
| `git diff --check` | n/a | exit 0, no output |

```sh
node --test test/gm-phone.test.js test/task-api.test.js test/site.test.js test/secret-gateway.test.js test/x-post-check.test.js test/commands-6.test.js test/commands-7.test.js test/gm-bet.test.js test/gm-target.test.js test/gm-season.test.js test/gm.test.js test/task-board-html.test.js test/task-explanation.test.js test/secret-gateway-no-hang.test.js test/site-publish.test.js test/site-deploy.test.js test/api-redirect.test.js test/serve.test.js
```

Both package snapshots were taken using `npm pack --dry-run --json`, with stdout saved as `cli-servers-pack-before.json` and `cli-servers-pack-after.json` under `/tmp/sec-overnight`. The file path comparison was:

```sh
python3 -c 'import json; from pathlib import Path; a=json.loads(Path("/tmp/sec-overnight/cli-servers-pack-before.json").read_text())[0]; b=json.loads(Path("/tmp/sec-overnight/cli-servers-pack-after.json").read_text())[0]; assert {f["path"] for f in a["files"]} == {f["path"] for f in b["files"]}; print("package file list unchanged:", len(a["files"]), "paths")'
```

## Deferred

No required fixes deferred. Physical-phone testing was unavailable, as noted above; real HTTP pairing on the LAN interface passed. Security review and landing remain with the orchestrator. No push, merge, deployment, release or publication was performed.
