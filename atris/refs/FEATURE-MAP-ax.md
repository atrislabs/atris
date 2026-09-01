# Feature map: ax (terminal chat app)

How to drive the running product. Code navigation lives in `atris/MAP.md`; this file is for operating ax itself: launching it, pressing its keys, and asserting on what it shows. Verify against the real app, not memory. Line refs are into `ax` (repo root) and `test/ax.test.js`.

## Launch

| Goal | Command | Ref |
|---|---|---|
| One prompt, JSON out (agent default) | `ax --print "<message>"` | ax:4751, 3546-3590 |
| One prompt at a tier | `ax --fast\|--pro\|--max\|--rapid\|--alpha "<msg>"` | ax:4732-4744 |
| Auto-pick lane, JSON includes `auto_lane`/`auto_reason` | `ax --auto --print "<msg>"` | ax:4850-4852 |
| Gate the turn on a shell verifier | `ax --verify "<cmd>" "<msg>"` | ax:4721-4730 |
| Interactive chat | `ax --chat` (tier flags compose) | ax:3592-3976 |
| Health report | `ax --doctor` | ax:4897-4903 |
| Harness self-check, no backend | `ax --self-test` | ax:4887-4888 |
| Approvals: list / run / deny / remember | `ax --approvals` · `--approve <id>` · `--deny <id>` · `--grant <id>` | ax:4906-4940 |

Routing: local when the workspace has `.git`, `atris.md`, or `atris/` within 24 parent dirs (ax:930-985). Implicit local falls back to cloud if the backend is unreachable; `--local` shows the real error (ax:3788-3791). Alpha pins local unless `--cloud` (ax:4753-4754).

## Screens (chat mode)

| Screen | Trigger | What it shows | Ref |
|---|---|---|---|
| Header | chat start | tier name, cwd, help hint | ax:3611-3612 |
| Journal line | chat start | `log atris/logs/YYYY/YYYY-MM-DD.md` | ax:226-298 |
| Runtime preflight | first turn | backend/auth health + fix hints | ax:3615-3647 |
| Streamed turn | model reply | text deltas, `● Read(path)` tool lines, `⎿ N lines path` results | ax:3094-3223 |
| Working indicator | turn in flight, no text yet | `Working… (Ns · ctrl-c to interrupt)` + tool verb | ax:3802-3808 |
| Approval overlay | gated tool call | `approve backend_api <method> <endpoint>? yes/no:` blocks input | ax:3853-3926 |
| Slash menu | typing `/` | live command hints under prompt | ax:1379-1425 |
| Done line | turn ends | `Worked for <duration> · <credits>` framed by long dashes | ax:1504-1510 |
| Prompt | idle | `[tier] [bypass permissions]› ` | ax:3957 |

## Keys (chat mode, TTY only)

| Key | Does | Ref |
|---|---|---|
| shift-tab | toggle approve mode auto ↔ stage | ax:1129-1140 |
| tab | complete slash command | ax:1373-1377 |
| ctrl-c | interrupt turn → clear draft → double-press within 2s exits | ax:1427-1487 |
| enter | submit line, clears slash menu first | ax:1409-1414 |

Non-TTY (piped stdin): no keys, no menu, input consumed line by line (ax:3897-3903).

## Slash commands

Registry: `CHAT_COMMANDS` ax:1167-1188 · parser ax:1219-1228 · dispatch ax:1269-1391.

| Command | Does |
|---|---|
| `/fast /pro /max /rapid /alpha` | switch tier next turn |
| `/effort <none\|low\|medium\|high\|xhigh\|default>` | set reasoning effort |
| `/model` `/who` | show current lane + effort |
| `/status` | runtime health block |
| `/context` | turns, chars, est. tokens |
| `/new` `/clear` | fresh conversation id, wipe history |
| `/log <note>` | append to today's journal |
| `/today` `/now` | tail today's journal / head of `atris/now.md` |
| `/auto` | toggle safe git-push bypass |
| `/help` | menu · `/exit` `/quit` leave |

## Driving ax in a test (the verify harness)

Stub the loop, no PTY needed: pass `input: Readable.from([...lines])`, an `output.write` collector with `isTTY:false`, and stub `turnFunction`/`runtimeHealth` into `ax.chat(options)` (ax:3592, pattern at test/ax.test.js:377-403). Single turns go through `ax.runHeadlessTurn` which returns `{ ok, output, durationMs, model, error? }` (ax:3546-3590).

Stream rendering is testable event by event via `ax.handleEvent(event, state, output)` (ax:3094-3223, pattern at test/ax.test.js:516-575). Real-PTY rendering checks use the pyte harness noted in the ax TUI verify lesson; prefer it for anything cursor/paint related.

Env switches: `AX_AUTO_LOG=0` no run log · `AX_LOG_FULL=1` unredacted transcript · `AX_BACKEND_URL` point at a stub · `AX_TIMING=1` per-event latency to stderr (ax:227-303, 3100).

## What to assert on

| Surface | Where | Ref |
|---|---|---|
| JSON result | stdout with `--print`: `ok/output/durationMs/model` | ax:3546-3590 |
| Run log | `~/.atris/runs/ax-play-<ts>.log`: command, mode, exit_code; redacted unless `AX_LOG_FULL=1` | ax:226-298 |
| Lane picks | `~/.atris/ax-auto-picks.jsonl`, one JSON line per prompt + outcome events | ax:4850-4852 |
| Journal | `atris/logs/YYYY/YYYY-MM-DD.md` gets `## HH:MM · Chat` from `/log` | ax:1336-1352 |
| Approvals | `~/.obelisk/approvals/<id>.json` | ax:4906-4940 |
| Exit codes | 0 clean, 1 usage/backend/approval-not-found | ax:4714, 5070 |
| Secrets never in logs | no token or Bearer strings; `redacted_chars:` marker present by default | ax:220-291 |

Keep this file current: any change to ax's flags, screens, keys, or slash commands updates the matching row here in the same change.
