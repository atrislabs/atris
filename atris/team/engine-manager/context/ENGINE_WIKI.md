# Engine Wiki

## Purpose

This is the durable operating memory for Atris engines. It records what is
actually proven, how to choose an engine, and what to do when a call fails.
The daily log captures events; this file keeps only reusable facts.

## Current status

| Engine | Honest status | Best current use | Known boundary |
| --- | --- | --- | --- |
| Grok | Proven | Fast second opinions and research | Local support-service warnings may appear before a successful answer. |
| Devin | Proven | Bounded multi-step work and real questions | Use its read-only default unless a safe isolated build is intended. |
| Muse Spark | Proven | Headless Meta-model questions and future orchestration | Not yet registered in the Atris engine roster. |
| Cursor | Proven for read-only asks | Fast second opinions through the ask lane; interactive Cursor work | Answers in seconds now that asks launch from the home directory; any other launch directory adds about a minute of silent workspace setup. It keeps one shared background worker daemon by design. |
| Droid | Access blocked | Future coding and mission work | Needs an active subscription or API key. |
| Fable | Partially proven | High-judgment planning and orchestration | Its worker handoff must report completion or pause reliably. |
| Codex | Proven for code execution | Deep implementation and independent review | A complete job still needs an explicit result and validation handoff. |

## Dispatch contract

1. The operator chooses the engine for the task; engine names do not imply a
   fixed role.
2. Code changes use protected dispatch. Read-only questions use the lightweight
   ask lane.
3. Every run records the engine, task or question, start, end, answer or
   failure, and the repository state when relevant.
4. Completion, failure, and a needed decision are pushed to the operator
   immediately.
5. An engine is only marked ready after a real, captured response.

## Failure playbook

- No response: enforce a timeout, preserve only the process launched for that
  request, capture output, and mark the job paused or failed honestly.
- Missing login or subscription: do not retry blindly; record the requirement
  and offer an available engine.
- Partial code work: preserve the isolated work, name the last known state,
  and give the next agent a recovery brief.
- Adapter drift: verify the official command contract with one bounded smoke
  test before changing routing policy.

## Open problems

1. **Simple Fable handoff is not reliable.** An operator should be able to say
   “Fable, solve this.” The dispatcher must either create a live worker record
   or immediately say why it could not; it must never leave a task claimed with
   no worker or receipt.
2. **Completion is not pushed to the operator.** Every background job must
   report a plain result when it finishes, fails, pauses, or needs a decision.
3. **Solved 2026-08-12: Cursor answers through the ask lane, fast.** Live
   probes returned captured answers with exit 0. The slow-start mystery is
   measured and worked around: Cursor pays about sixty seconds of silent
   workspace setup in every launch directory except the user home, so the
   ask lane now launches Cursor from home and answers arrive in seconds.
4. **Solved 2026-08-12: read-only asks have their own lane.** `atris engine ask`
   runs one question on several engines or different prompts per engine, in
   parallel, with labeled answers, a receipt under `atris/runs/`, concurrency
   and timeout caps, and per-job process cleanup. It never creates worktrees or
   claims tasks. Proven live with a real Grok answer.
5. **Model choice must stay flexible.** Fable, Grok, Devin, Codex, Cursor, and
   others are selectable tools, not fixed job titles. The operator chooses the
   engine for each task.
6. **Droid is not ready.** The command is installed, but the account needs an
   active subscription or API key before it can be routed.
7. **Muse Spark is not in the roster yet.** It passed a real headless response
   test and needs a saved Atris engine profile and a smoke test in the standard
   adapter.
8. **Validation needs a real handoff.** A finished build needs a separate,
   named validator; passing tests alone are not the full approval loop.
9. **Solved 2026-08-12: team presence shows the operator separately.** The
   presence view no longer counts the operator's active work as an awake team
   member; the operator gets their own line and the awake number means real
   members only.
10. **Dispatch can claim a landing that never happened.** On 2026-08-12 a
   dispatch printed self-landed while the restaffed Cursor leg had committed
   nothing; the diff sat uncommitted in the worktree. Dispatch must check for
   an actual commit plus a landing ref before reporting success. Evidence is
   on the task that owns the honest-worker rule.
11. **Grok note, solved 2026-08-12:** Grok 1.0.0 refuses to start when asked
   for a sandbox profile it does not know. The ask lane now uses Grok's
   built-in read-only profile and answers cleanly.
