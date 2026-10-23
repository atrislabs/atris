# Independent source review

owned_by: validator
executed_by: claude-opus-5-5
at: 2026-10-23T04:13:44.513Z
read_only: true
status: completed

The following is the independent reviewer’s verbatim response. Full engine
receipt is retained in the executor’s local logs. Tests were executed by a
separate independent witness, not by this read-only reviewer.

**Verdict: PASS for the narrow paused-local scope.** I would approve installing this and applying the $20 limit to the existing paused campaign.

I read the code only. I did not run any tests. The test results are the builder's and the Codex witness's, not mine.

**What I checked and found sound**

The limit check runs inside the same database write lock as the append (`lib/campaign-store.js:134`, `:202`). That lock works across processes, so a reservation or cloud link that commits first is always seen (`commands/campaign.js:708-716`).

Sync's recheck after saving the link closes the race in both orders (`lib/campaign-sync.js:153`, `:162`, `:167`). If the limit commits first, the recheck finds it. If the link commits first, the limit's own check sees the link and refuses.

The fold applies a limit only if it does not raise the total and is not below spend plus reservations (`lib/campaign-core.js:252-258`). It changes only the total, so history and pause stay as they were.

Input checks agree in the command and the schema: whole cents, at least $0.01, below the unlimited marker, exactly one `--limit`, and no `--add` alongside it (`commands/campaign.js:697-702`, `lib/campaign-schema.js:158-161`). The raw `event` command cannot write it (`commands/campaign.js:754`).

`--add` is unchanged. Without `--limit` it goes straight to the old handler (`commands/campaign.js:697`). Adding `--limit` to the value-flag list (`:92`) changes no other command, because no other campaign command reads it.

New missions are held to the lower budget. Mission start checks inside the lock (`commands/mission.js:4630`, `lib/campaign-missions.js:65`), and the later record call reserves nothing more, since `campaignReserve` stays 0 (`commands/mission.js:4727`).

**Findings that do not block this scope**

One. A refused limit fails open, back to unlimited (`lib/campaign-core.js:255-257`). The command checks against the current state, but the fold re-checks the limit at its place in time order. If an existing event carries a later timestamp, say from the clock jumping backwards, the two checks can disagree. The fold then drops the limit with only a warning, and the old total, possibly the unlimited marker, comes back. The success message at `commands/campaign.js:722-723` never compares the saved total to the amount asked for, so it would print "limited to" the unlimited total. This cannot happen to your campaign: with $0 spent and $0 reserved, a $20 limit passes at any point after the start. Before wider use, the command should fail when `after.budget.total !== amount`.

Two. The first-sync path leaves a small gap (`lib/campaign-sync.js:156-181`). For a campaign this computer has never seen, the recheck at `:167` runs before the download, and the link is saved only at `:181`. A limit written in between stays local, gets marked as already sent (`:179`), and blocks every later sync. No new uncapped cloud copy is created, since the cloud already had it, but the comment at `:164-166` claims more than the code delivers. Your campaign is not linked, so this cannot happen here.

Three. Older CLI versions fail open for missions already running (`lib/campaign-missions.js:78`). To an old version, the new event makes the campaign unreadable. Old versions correctly refuse new missions on it, but their per-step check returns "keep going". With zero running missions this has no effect today. Still, every installed copy that shares this campaign database (the global npm install and the fleet clone) should be upgraded before the event is written. An old copy's sync also lacks the refusal, which matters only if the campaign ever gets linked.

Four. This limits new admissions, not spending. One mission can cost more than it reserved, and the campaign only shows out of budget afterward. The contract already says it is not a universal cap.

**What my reading does not cover**

The race tests (`test/campaign-budget-limit.test.js:102-146`, `:178-192`) fake the race within one process by wrapping `append` and `setMeta`. My judgment that it holds across processes comes from reading the write lock, not from a test with two real processes.

No cloud, web, or desktop reader understands this event yet. That matches the contract.

Before resuming, read back the saved state and confirm the total shows $20.00, not the unlimited number. That read-back is what covers finding one.

