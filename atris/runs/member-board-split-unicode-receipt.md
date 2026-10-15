# Split multibyte live follow

Live follow now has two real-command regression checks for text split inside a four-byte character, before and after startup. Runtime code already handled it correctly; no runtime edit was needed.

Files edited: test/member-board.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/builder/logs/2026-10-14.md.
Artifacts: atris/runs/member-board-split-unicode-proof.py and this receipt.

Verify: `node --test test/member-board.test.js test/member-result.test.js`
Exit: 0. Exact summary: tests 71; suites 0; pass 71; fail 0; cancelled 0; skipped 0; todo 0; duration_ms 15709.871958.
Progress: two live cases added, 69 to 71 required checks; zero partial or duplicate events, intact non-ASCII text, following result preserved, clean shutdown.

Real proof invocation: `python3 atris/runs/member-board-split-unicode-proof.py`, exit 0.
Underlying command: `node bin/atris.js member board --json --follow`, exit 0 after deliberate SIGINT.
Actual output excerpt:
```text
incomplete character: no event after 1.2 seconds
{"member": "builder", "mission": "m-proof", "at": "2026-10-15T00:47:08.925Z", "kind": "step", "text": "reading caf\u00e9 \ud83e\udded notes"}
completed text: exactly one event
{"member": "builder", "mission": "m-proof", "at": "2026-10-15T00:47:08.925Z", "kind": "finished", "text": "ok", "ok": true}
exit: 0
```

Other commands: atris brain activate --root . --verify; atris; atris mission status mission-2026-10-14-continue-improving-atris-mem-52869ba8; atris mission goal --json; atris task list --status open; atris task new/claim/note; git status/diff/log; atris brain compile --root .; git diff --check; task ready; git add/commit/push.
Brain activation and compilation were plan-only (exit 2); missing compiled files were not generated. Mission task attachment reported a busy lock, so a separate bounded task was created and claimed without changing mission state. Existing unrelated edits were preserved.
Learned: keep writes as bytes when reproducing a split character, and decode stdout across pipe chunks too. The next complete line proves offsets count bytes rather than characters.
Plan: partial bytes -> no event -> complete newline -> intact event once -> next result -> clean exit.
Readiness: supported-runtime check exited 0 and task moved to Review. Local readiness needed a plain explanation of the operator benefit for both result and landing; the first two metadata submissions were rejected, without changing tests or code. The PATH-prefixed readiness command is outside automatic certification, so acceptance remains pending; the frozen command itself was unchanged and passed directly.

next_push: Prove a narrow, short live terminal redraw keeps the failure reason visible after resize.
layer: behaviors
