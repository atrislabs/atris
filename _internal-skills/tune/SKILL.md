---
name: tune
description: "Live RL tuner for skills. Watches skill invocations, reads user reaction, proposes targeted SKILL.md overlay edits, requires explicit approval, writes scorecards. The in-session half of the skill-RL loop (Path B). Triggers on: tune, sharpen, skill feedback, that was shit, that was great, make X better."
when_to_use: "Use when the user reacts to a skill's output with approval or pushback, or asks to tune/improve/sharpen a skill based on what just happened. Examples: 'that aeo draft was shit, make it better', 'good, keep doing that', 'the cold-email skill keeps hedging', 'tune this'."
version: 0.1.0
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
tags:
  - rl
  - skills
  - self-improvement
---

# Tune — Live Skill RL

Turn the user's reaction into a targeted SKILL.md overlay edit. Human-in-the-loop reinforcement learning for skills.

## Architecture

```
Base SKILL.md (read-only, shared)
    +
Overlay.md (mutable, per-workspace)
    =
Effective skill at invocation time

Path A (cron):  /api/improve ticks weekly, objective reward harvester
Path B (live):  THIS SKILL — user reaction = reward, edits overlay in-session
                Same overlay.md, same scorecard — both paths compound.
```

## The reward schema (non-negotiable)

| Signal | Reward | Source |
|---|---|---|
| Explicit positive | +1 | "good", "perfect", "keep it", "that nailed it" |
| Implicit positive | +0.5 | user kept output unchanged, shipped it, moved on |
| Neutral | 0 | no reaction, switched topic |
| Implicit negative | −0.5 | user edited heavily, reran skill, tweaked params |
| Explicit negative | −1 | "shit", "bad", "nope", "revert", "worse than before" |

**Do not infer reward beyond these.** If you are unsure, classify as **neutral** and log; do NOT propose an edit on neutral.

## The loop (one tick)

```
1. OBSERVE
   - User just invoked skill <X> at turn T
   - Skill produced output Y
   - User reacted with R

2. CLASSIFY
   - Map R to reward from the schema above
   - If reward in {0}: log and stop. Do not propose.

3. DIAGNOSE
   - If reward < 0: what specifically did the user reject?
     (a phrase? a structural choice? a missing section? tone?)
   - If reward > 0: what specifically did the user approve?
     (same questions, positive framing)
   - Write a one-sentence diagnosis.

4. PROPOSE
   - Read /workspace/atris/skills/<X>/SKILL.md   (BASE, read-only)
   - Read /workspace/atris/skills/<X>/overlay.md (if exists, else empty)
   - Propose ONE targeted edit to overlay.md:
     • Max 5 lines of change
     • Must be additive (append) or a bounded replace of existing overlay lines
     • NEVER edits base SKILL.md

5. SHOW THE DIFF
   - Display a unified diff of the proposed overlay change
   - State the diagnosis and expected outcome in one sentence

6. REQUIRE APPROVAL
   - Wait for an explicit "yes" / "apply" / "go" from the user.
   - On anything else: log as rejected. Do not apply.

7. APPLY + LOG
   - Write the approved change to /workspace/atris/skills/<X>/overlay.md
   - Append one line to /workspace/atris/skills/<X>/scorecards.jsonl:
     {"ts": "<iso>", "skill": "<X>", "reward": <n>, "reaction": "<short>",
      "diagnosis": "<short>", "applied": true, "path": "B-live", "turn": <T>}
```

## Validator rules (hard gates)

1. **Base is read-only.** If the skill folder has no overlay.md, create it. Never edit SKILL.md directly.
2. **Diff gate.** A diff must be shown to the user BEFORE any write. No silent edits ever.
3. **Approval gate.** Explicit "yes/apply/go" required. Silence is not approval.
4. **Size cap.** A single tick may add at most 5 lines to overlay.md. Larger changes require the user to re-invoke with a bigger scope confirmed.
5. **Overlay size cap.** If overlay.md exceeds 100 lines, refuse new edits and suggest consolidation (point the user at `/api/improve` or ask them to manually prune).
6. **No ALL CAPS, no em dashes, no "AI" buzzword** in overlay content (matches outbound copy rules).
7. **Log every tick** to scorecards.jsonl — approved, rejected, and neutral. Every tick.

## Reward harvester (Path B side)

```
scorecards.jsonl (append-only):
  {"ts", "skill", "reward", "reaction", "diagnosis", "applied", "path": "B-live", "turn"}

Path A (/api/improve) also writes to the SAME scorecards.jsonl with:
  {"ts", "skill", "reward", "path": "A-cron", "variant_hash", "kept": bool}

Weekly: /api/improve cron tick reads the last 7 days of scorecards.jsonl
        to propose autonomous variants that address patterns Path B caught.
```

## Examples

### Example 1 — explicit negative on aeo

```
User: [runs aeo draft, gets output]
User: "this is too hedgy, it uses 'may' twice"

Tune skill:
1. Reward: −1 (explicit negative, specific complaint)
2. Diagnosis: AEO rule 9 (no hedging) is violated; overlay should strengthen it
3. Propose overlay.md addition:

   ```diff
   --- overlay.md (before)
   +++ overlay.md (after)
   @@ +1,3 @@
   +## Stricter no-hedging (learned 2026-04-17)
   +Before returning, scan the body for: may, might, could, perhaps, possibly, potentially.
   +If found, rewrite the sentence as declarative. No exceptions.
   ```

4. Diagnosis: "strengthens rule 9 by making the scan explicit post-generation"
5. Expected: next draft has zero hedging words

"Apply this?"
User: "yes"
[writes overlay.md + logs scorecard, reward=−1, applied=true]
```

### Example 2 — explicit positive on cold-email

```
User: "damn that cold email hook is sharp, keep doing that"

Tune skill:
1. Reward: +1
2. Diagnosis: the specific hook pattern worked (e.g., "opened with a stat from their 10-K")
3. Propose overlay.md addition:

   +## Hook that worked (2026-04-17)
   +Prefer opening with a verifiable, recent stat from the prospect's own
   +public material (10-K, earnings call, press release) over generic praise.

4. "Apply this as a preferred pattern?"
User: "yes"
[writes overlay.md + logs scorecard, reward=+1, applied=true]
```

### Example 3 — neutral

```
User: [gets output, says nothing, moves on]

Tune skill: does NOT proactively run. Only triggers on user-expressed reaction.
If somehow invoked: log neutral, propose nothing.
```

## Anti-patterns

- **Don't propose on neutral signal.** Silence is not −1 or +1.
- **Don't rewrite the base.** Base SKILL.md is shared across customers. Only overlay diverges.
- **Don't batch multiple changes into one tick.** One tick = one targeted edit. Larger refactors go through `/api/improve` in review mode.
- **Don't claim improvement you can't verify.** "Expected outcome" should be a testable prediction (e.g., "next draft will have zero 'may/might/could'"), not a vibe.
- **Don't run without the user's explicit approval.** Every application is gated. No "this seems good, I'll apply it."

## File layout (what exists where)

```
atris-cli/atris/skills/<name>/SKILL.md              ← base, shared (genotype)
/workspace/atris/skills/<name>/SKILL.md             ← customer copy of base (synced)
/workspace/atris/skills/<name>/overlay.md           ← mutable, RL-tuned (phenotype)
/workspace/atris/skills/<name>/scorecards.jsonl     ← append-only reward log
```

**Invocation-time behavior:** skill callers (backend endpoints like `/aeo/draft`, or Claude Code skill system) read `SKILL.md` AND `overlay.md` and concatenate. If overlay.md is missing, treat as empty.

## Member Spec Overlays

Tune may also propose guarded member-spec changes when the target is `atris/team/<member>/MEMBER.md`.
Keep the same approval gate and write to `atris/team/<member>/overlay.md`; do not silently rewrite the base member spec.
Ground every member overlay proposal in causal evidence from `atris/wiki/.causal.json` or reusable patterns from `atris/wiki/.patterns.json`.
The architect member owns these proposals and must keep them advisory until explicit approval.

## Related

- Base pattern: `atris/skills/autoresearch/SKILL.md` (Karpathy keep/revert)
- Path A tick runner: `/api/improve` (`backend/routers/improve.py`)
- PII sanitizer for cross-customer diffs: `backend/rl/skill_extractor.py`
- Reward compiler: `backend/rl/rewards.py`
- Judge infra: `backend/rl/judges.py`
- Feature: `atris/features/skill-rl/idea.md`

## Rules (non-negotiable summary)

1. Never edit base SKILL.md. Overlay only.
2. Always show the diff before applying.
3. Require explicit user approval.
4. Cap a single tick at 5 lines of change.
5. Log every tick — approved, rejected, neutral.
6. Do not propose on neutral reactions.
7. Strip PII before any cross-customer record (use `skill_extractor`).
