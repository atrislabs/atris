# Warm codex sessions on the app-server daemon

`atris engine codex --session <name> "<prompt>"`, `--interactive`, and `--computer-use` now run on the owner's shared Codex app-server daemon instead of a cold `codex exec`. Plain `atris engine codex "<question>"` is unchanged.

Files: `lib/codex-daemon.js` (protocol client), `lib/codex-session.js` (command, session names, fallback, repl), `commands/engine.js` (routing, help), `lib/engine-ask.js` (`rosterJobPin`, ask flag hint), `bin/atris.js` (help lines), tests `test/codex-daemon.test.js`, `test/codex-session.test.js`, fake proxy `test/helpers/fake-codex-proxy.js`, docs `README.md`, `atris/skills/engines/SKILL.md`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, this receipt.

## How the client talks to the daemon

Read from the codex source and confirmed live on codex-cli 0.166.0:

- `codex app-server proxy` relays raw stdio bytes to the daemon's control socket (`codex-rs/stdio-to-uds`). The socket speaks WebSocket (`codex-rs/app-server-transport/src/transport/unix_socket.rs`), so the client sends the HTTP upgrade itself, masks its frames, and sends one JSON-RPC message per text frame. A first probe that wrote plain JSON lines got no answer in 15s.
- Method names come from `codex app-server generate-json-schema`: `initialize`, `initialized`, `thread/start`, `thread/resume`, `thread/name/set`, `turn/start`, `turn/interrupt`, and the notifications `item/agentMessage/delta`, `item/started`, `item/completed`, `error`, `turn/completed`.
- The upgrade path is always `/`. The daemon treats `/daemon/shutdown` as a stop request. The client refuses any method outside that list, so it cannot write config, install plugins, or log out.
- A new connection must call `thread/resume` before it gets turn events. Without it the turn ran, but only `thread/status/changed` arrived, and the client waited until its 120s limit.
- Ephemeral threads disappeared 30 to 60s after their connection closed (`no rollout found` on resume), so named sessions use persisted threads.
- Each new thread starts the owner's MCP servers (`codex_apps`, `cua_repl`, `node_repl`, `openaiDeveloperDocs`); `codex_apps` took about 1.2s before the model saw the prompt.

## Benchmark

Prompt `reply with the word OK`, wall time, one run at a time, rounds interleaved so machine load hits every path alike. Mac with other agents running, Node 25.6.1, codex-cli 0.166.0, 2026-10-29. Every run answered OK.

| path | n | median | min | max |
|------|--:|-------:|----:|----:|
| cold `codex exec`, the argv Atris builds today (`--ignore-user-config`, so model `gpt-6.1-sol`) | 5 | 5.79s | 4.96s | 6.78s |
| cold `codex exec`, owner config (`gpt-6.1-terra`, same as the daemon) | 5 | 4.71s | 4.40s | 7.33s |
| `atris engine codex --session <new>`: new daemon thread, fresh process | 10 | 3.73s | 2.86s | 12.11s |
| `atris engine codex --session <same>`: next turn, fresh process, thread still loaded | 5 | 1.55s | 1.24s | 2.49s |
| second turn on the same connection (what `--interactive` pays per line) | 5 | 1.47s | 1.26s | 1.97s |
| `--session` on a thread the daemon had unloaded (idle for minutes) | 3 | 3.05s | 2.73s | 3.65s |

Phases inside one connection (n=5, median): connect through the proxy and `initialize` 83ms (77 to 325), `thread/start` 103ms (42 to 716), first turn on the new thread 4.20s (2.39 to 5.40), second turn 1.47s (1.26 to 1.97). Atris CLI startup alone (`engine codex --session x --help`, no connection) is 119ms (116 to 121).

What this says: the next turn on a warm thread is about 3x faster than a cold `codex exec` with the same model (1.47s or 1.55s against 4.71s), and about 3.7x faster than today's plain ask argv (5.79s). A brand new thread saves less (3.73s against 4.71s) because the daemon starts the owner's MCP servers for every new thread.

Unknowns, left unknown:
- One new-thread run took 12.11s while its turn took 3.6s; the extra 8.5s was outside the turn and did not repeat in 9 other runs. Cause not found.
- One cold `codex exec` during fallback testing, outside the benchmark, took 27.2s; the 5 benchmark runs of the same argv took 4.96 to 6.78s.
- Token use: cold exec printed 6,826 tokens (Atris argv) and 7,484 (owner config) for this prompt. Daemon turns were not measured.
- n is small (3 to 10 runs per path) on a shared, loaded machine. Treat the ratios as rough.

## Live checks (real daemon, real codex)

- A session remembered a word across two processes: `--session probe "remember the word mango..."`, then `--session probe "what word..."` answered `mango` (1.32s wall).
- `--interactive` with piped input ran two turns on one thread, and `/exit` stopped before the third line.
- Computer use: `--computer-use` on `gpt-6.1-terra` listed `mcp__cua_repl.js` without calling it (3.23s wall). A read-only session lists the same tool too, because the daemon loads the owner's plugins for every thread. The codex sandbox covers shell commands and file edits, not MCP tools, so read-only threads carry instructions to make no changes.
- Fallback: a PATH shim made `codex app-server proxy` fail while `codex exec` stayed real. The read-only fallback printed one line (`codex daemon not reachable (...), so this runs as a one-shot codex exec and is not saved to session probe`) and answered OK. The computer-use fallback ran `codex exec` with the owner's config (`gpt-6.1-terra`, effort medium, sandbox `danger-full-access` from the owner's config) and listed the cua tools. The daemon was never stopped, restarted, or reconfigured.

## Gates

- `node --test test/codex-daemon.test.js test/codex-session.test.js`: exit 0, 28 tests, 28 pass. Both files now sit in `test/fast-tests.txt`.
- `npm run test:fast`: exit 0, 2433 tests, 2433 pass (2405 before the two files were added, also exit 0).
- The 78 engine, codex, help, known-commands, readme, runner-command, and first-minute test files: exit 0, 808 tests, 808 pass.
- Run on Node 25.6.1 only; CI runs Node 24 on Linux and was not run locally.
- `atris slop detect` on the new files and `--diff`: exit 0, clean.
- `atris doc-health`: refs 1866 ok (18 new, all ok), 40 moved and 4 ambiguous, the same set flagged before this change. The one in a touched file, `commands/engine.js:2354` (`unread`), already pointed about 66 lines from its symbol on origin/master. Refs into `lib/engine-ask.js` that this change shifted by 13 lines were moved to the same code; the 1-line shifts in `commands/engine.js` stay inside doc-health's 3-line window.
