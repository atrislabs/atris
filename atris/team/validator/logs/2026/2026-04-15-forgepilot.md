### Tick 1 — 2026-04-15

**Horizon:** Always-on CodeOps agent workspace where forge ticks against atris-cli have a real RL signal (not noise).

**Task:** Build `scripts/smoke.sh` — the scorecard that gates auto-merge. Without a pass/fail signal, every forge tick is random edit, not RL.

**Metric:**
- Master: PASS 14/14, exit 0
- Falsifier #1 (syntax break in bin/atris.js): FAIL 4/14, exit 1
- Falsifier #2 (remove +x from bin/atris.js): FAIL 4/14, exit 1
- Falsifier #3 (inject `fake-ref-test.js:99999` into MAP.md): FAIL 1/14, exit 1

**BS check:** Pass. Three independent falsifiers all caught with clear failure naming.

**Codex plan review:** N/A (background codex run hung — output empty after 60s).

**Codex output review (sync, completed):** Flagged 4 real gaps, all addressed:
1. Was running `node bin/atris.js` not the bin file → switched to `./bin/atris.js` + added shebang + exec-bit checks.
2. Was using `node --check` (parse only) → switched to `node -e "require('./...')"` (catches load errors).
3. MAP gate was theater (sample 5) → now validates ALL refs + line-in-range check.
4. Conflict-marker scan missed test/, .github/, scripts/, json/yml → expanded surface.

**Gap closed:** Forge bot now has a deterministic gate. Without smoke.sh, a green CI on atris-cli would have been meaningless (no tests existed for the CLI surface — `test/` files exist but require sandbox perms macOS denies).

**Next:** Tick 2 — wire smoke.sh into CI (.github/workflows/smoke.yml) so `gh pr checks` actually returns it. Without CI invocation, the forge auto-merge gate has nothing to read.

**Signal:** [TICK_COMPLETE] metric=smoke_pass_on_master=14/14 falsifiers_caught=3/3
