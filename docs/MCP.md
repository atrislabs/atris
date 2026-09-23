# Atris MCP server

`atris mcp` runs a stdio Model Context Protocol server that gives any MCP client the three design tools. It uses Node's built-in stdin and stdout support for newline-delimited JSON-RPC, with no npm dependencies. The server lives at `mcp/atris-mcp/` and also ships as the `atris-mcp` bin, so `npx atris-mcp` works after the package is installed.

## Tools

| Tool | What it does | Cost |
|------|--------------|------|
| `design_extract(url)` | Pulls a site's design system: colors, typography, layout, voice. Polls until the job finishes. | 10 credits, 2 on a cache hit |
| `design_check(source_url, reference_url)` | Scores how closely a page follows a reference brand. | 20 credits |
| `design_search(query, limit)` | Searches brands already extracted. | 1 credit |

Each tool returns the JSON result plus `credits_charged` and `balance_remaining_usd`.

## Auth

The server resolves the key the same way the CLI does: `ATRIS_API_KEY` env var, then the logged-in `atris login` token, then `~/.atris/design-api-key`. Nothing writes the key file for you; it is an optional place to save a key by hand on machines where env vars and login are awkward. To get set up, set `ATRIS_API_KEY` or run `atris login`.

## Claude Desktop

Add to `claude_desktop_config.json`:

```json
{"mcpServers": {"atris": {"command": "atris", "args": ["mcp"]}}}
```

If the key is not in the login store or the key file, pass it in `env`:

```json
{"mcpServers": {"atris": {"command": "atris", "args": ["mcp"], "env": {"ATRIS_API_KEY": "atris_..."}}}}
```

## Cursor

Add to `.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for all projects:

```json
{"mcpServers": {"atris": {"command": "atris", "args": ["mcp"]}}}
```

Restart the client after editing. The tools then show up as `design_extract`, `design_check`, and `design_search`.
