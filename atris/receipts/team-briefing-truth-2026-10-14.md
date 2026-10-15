# The team briefing tells the truth

The team briefing includes all 30 discovered members instead of seven, names recorded engines or the shared roster choice, and cleans empty commit labels and raw error placeholders without hiding failed checks. Verified by `node --test test/member-room-truth.test.js`, exit 0, seven passed and zero failed, and real text and JSON briefing invocations, both exit 0.

## Plan and risk

Proceed with the shared resolver. The sharp risk is inventing a successful result or engine while cleaning the display. Keep failure status, retain meaningful failure explanations, use recorded engines when named, and fall back through the same roster resolver as member dispatch. Manual and auto are modes, not engine names.

```text
member cards + roster + recorded work
                 |
                 v
all discovered members -> actual engine / roster pick -> clean update + honest check status
                 |
                 v
complete text and JSON briefing
```

## Files changed

- `commands/member.js`: include additional members in stable order, share engine resolution, distinguish engine names from runner modes, remove quoted or empty commit labels and placeholder error summaries, preserve failed-check state, and avoid fabricated fallback engine seats.
- `bin/atris.js`: drain member stdout before exiting so a full team payload is not truncated.
- `test/member-room-truth.test.js`: seven real CLI regression cases for roster picks and models, coverage of newer members, recorded engines and modes, output beyond 64 KiB, commit cleanup, placeholder errors with visible failures, and unavailable engines.
- `atris/MAP.md` and `atris/refs/MAP-NOTES.md`: navigation and implementation references.
- `atris/team/architect/logs/2026-10-14.md`: work and learned pattern.
- `atris/receipts/team-briefing-truth-2026-10-14.md`: this receipt.

## Commands and exact proof

Rerunnable frozen check: `node --test test/member-room-truth.test.js`

```text
tests 7
suites 0
pass 7
fail 0
cancelled 0
skipped 0
todo 0
exit: 0
```

The task's proof gate also ran that same command and recorded exit 0 in `atris/runs/2026-10-15-task-att-1-2026-10-15T02-11-47-411Z.json`.

Related checks: `node --test test/member-fleet.test.js test/member-feed-real-work.test.js`

```text
tests 10
suites 0
pass 10
fail 0
cancelled 0
skipped 0
todo 0
exit: 0
```

Real changed surface: `node bin/atris.js member day`

```text
Your team · workday briefing
Your team runs on claude, codex and grok.
| 5. ARCHITECT (Architect) · queued · engine:codex
| 30. YOUTUBE-LEAD (YouTube Process Owner) · queued · engine:claude
member rows: 30
exit: 0
```

Real JSON surface: `node bin/atris.js member day --json`

```text
json members: 30 standup: 30 bytes: 120653 exit: 0
```

Full local surface artifacts: `.atris/proof/member-room-truth-live.txt` and `.atris/proof/member-room-truth-live.json`.

`git diff --check`: exit 0, no output.

## Progress and limits

Member coverage increased from 7 to 30. All seven mission checks and ten related checks passed. The existing member tests exposed truncated JSON once member coverage grew; the shared stdout drain fixed it and a large-output regression protects it. Initial test fixtures needed valid search engines and fresh unavailable-engine timestamps to respect the real registry's rules.

The parent mission runner owns the live mission lock, so both attach-task attempts refused with exit 3. No lock was removed and no mission settings were changed. A local task was created, claimed as architect, and moved to review with the executable proof gate; no task was self-accepted. The brain activation and compile commands returned preview-only exit 2; their proposed instruction changes were not applied during this bounded code repair. The rendered task list was refreshed by task commands and its generated diff was discarded before staging to avoid replacing the tracked shared backlog with this checkout's local task view.

next_push: Label the recorded job engine and the next roster choice separately in each member briefing row.

layer: behaviors
