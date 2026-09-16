# Design CLI + MCP server

## What landed

`atris design` talks to the live design API at api.atris.ai. `atris mcp` runs a
stdio MCP server that hands the same three tools to Claude Desktop, Cursor, and
any other MCP client. Both resolve the developer key the same way:
`ATRIS_API_KEY`, then `~/.atris/design-api-key`, then the logged-in `atris
login` token.

## Files changed

Created:

- `lib/design-api.js` — shared client. Key resolution, `designRequest` (JSON
  over `utils/api.js` `httpRequest`, honors `ATRIS_API_URL`/`ATRIS_BACKEND_URL`),
  `pollDesignJob` (3s interval, 3m cap), and the credits/balance line.
- `commands/design.js` — `extract`, `check`, `search`. Readable card by default
  (brand name, primary hex colors, heading and body fonts, credits charged,
  balance left). `--json` prints the raw API object. Polls with a one-line TTY
  spinner; silent when piped.
- `mcp/atris-mcp/index.mjs` — stdio MCP server on `@modelcontextprotocol/sdk`.
  Tools: `design_extract`, `design_check`, `design_search`. Returns the JSON
  result plus `credits_charged` and `balance_remaining_usd`.
- `test/design.test.js` — mocked HTTP, covers all three commands, the polling
  loop, `--json`, `--sections`, `--limit`, the no-key error, and help.
- `test/mcp.test.js` — offline test: spawns `atris mcp` and runs a real
  `initialize` + `tools/list` handshake over stdio.
- `docs/MCP.md` — Claude Desktop and Cursor config snippets.
- `atris/team/design-cli/work/REPORT.md` — this file.

Edited:

- `bin/atris.js` — dispatch for `design` and `mcp` (mcp spawns the server with
  inherited stdio), two help lines, and `mcp` added to the update-check skip
  list so a stray notice cannot corrupt the JSON-RPC stream.
- `lib/known-commands.js` — registered `design` and `mcp`.
- `package.json` — added dependency `@modelcontextprotocol/sdk@^1.30.0`,
  `atris-mcp` bin entry, `mcp/` in `files`.
- `package-lock.json` — lockfile for the new dependency.
- `test/fast-tests.txt` — registered `test/design.test.js` and
  `test/mcp.test.js` in the fast tier.
- `atris/MAP.md` — feature entry for design + mcp.

## Tests

Command: `npm test`

Result: TEST_RESULT_PLACEHOLDER

Focused runs while building:

```
node --test test/design.test.js test/mcp.test.js
# pass 8, fail 0
```

`atris slop detect docs/MCP.md` — clean, no slop tells.

## Live transcript

`ATRIS_API_KEY` was set in the environment (same value as
`~/.atris/design-api-key`). Real run:

```
$ node bin/atris.js design extract https://stripe.com

  Stripe
  https://stripe.com

  colors    #635bff #00d4ff #4285f4 #000000 #ffffff #f6f9fc
  heading   Stripe Sans (Custom) / System Sans
  body      System Sans-Serif
  line      Financial infrastructure to grow your revenue, from first transaction to billionth.

  2 credits charged. $19407.55 left.
```

Cache hit, so it billed 2 credits instead of 10.
