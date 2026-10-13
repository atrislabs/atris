# Mission

<!-- Human-authored purpose file. Keep this durable; runtime state belongs in .atris/state/*.jsonl and now.md. -->

## North Star

The inbox that goes quiet. Learn each user's signal bar from their real keep and archive decisions, ping only when something crosses it, and draft replies in the right voice per account. Silence is the product; the feeling we sell is relief.

## The five W's (set 2026-08-26)

Who: people drowning in email who are not email nerds. Multiple accounts, wants relief, not a faster inbox. The prototype user is Keshav's friend already on it in production.

What: triage that learns from real decisions. Every keep and archive is a labeled preference example; notification rules come only from accumulated real verdicts, never from a survey.

Where: multi-account Gmail is live on backend, CLI, and web (shipped 2026-08-25). One outside user going well. The market is crowded on triage, empty on learned preference plus silence by default.

Why: email is the one universal pain, and this is the wedge into Atris. "Your inbox went quiet" is an easy first conversation; "an AI operating system" is a hard one. The inbox is the front door.

How: slices through the normal machine. Slice one, log every keep and archive verdict per account (CLI-1311). Slice two, propose notification rules only from those logs after about a week of real decisions. In parallel, five users like the friend, watch them, collect "my inbox went quiet" quotes. Launch is one banked day spent with those quotes, never a merge announcement.

## The home (decided 2026-08-26)

The brain runs on the user's Atris computer, the per-user cloud machine with a disk that remembers. The backend shrinks to a doorbell: it taps the computer when mail arrives and stores nothing readable. We own this instead of renting sandboxes because rented boxes forget their disk every run, and a brain that forgets cannot learn a bar.

## The ladder (one wish per rung, 100% before climbing)

1. Access: the Atris computer reads the user's inbox from inside itself. Boring, provable. DONE 2026-08-27: read-only gmail scope on agent keys (backend PR 2614), CLI accepts scoped keys (CLI PR 828, v3.56.1), live proof from the cloud box: inbox read succeeded, archive refused. HARDENED 2026-08-28, recycle-proven with zero hand-fixes: every wake now mints a fresh 7-day gmail-read key server-side and places it at the workspace .atris/agent-token.json (backend PRs 2624, 2627; 600s drop window for cold boots), the CLI prefers a fresh placed key over a stale env token and treats a key-holding workspace as bound (CLI PR 850 + v3.56.3), and the prod user_agent_tokens table now exists so keys survive backend restarts (root cause of the phantom "expired" rejections). Live receipt: box slept to full stop, woke, read both accounts untouched; archive scope-denied server-side (token 247cce79, 02:34:45Z). Production-closed 2026-08-28 late night: the wake script's login-warming block was silently ending the script before the tool update (backend PR 2636), the worker process sometimes never started on boot and now gets revived first thing every wake (PR 2637), and a key that fails to save now refuses to issue instead of dying at the next restart (PR 2629). Final exam passed hands-off: wake at 03:49:25Z, fresh key written 03:49:59Z, tool self-updated to 3.56.3, inbox read clean, archive scope-denied server-side. The box even re-armed its own key unattended two hours later.
2. Habit: scheduled triage on the computer writes keep and archive verdicts to its own disk. A week of real decisions accumulates.
3. First combo: compiler turns verdicts into a per-account signal page; doorbell wakes the computer on new mail; new mail gets checked against the bar.
4. Magic: ping only past the bar, silence otherwise. The first quiet inbox.
5. Combos of combos: ping arrives with a draft in the right voice, plain-words corrections update the bar, the agent acts on its own, then it runs for the next user.

## The three concepts underneath

Always-on: the computer never sleeps, so the same self-improving loops that run our repo run the user's inbox, receipts in, better bar out.

Interfaces anywhere: the brain lives in one place, so web, desktop, phone, or a text message are all just thin windows onto it.

Proactive because everything is saved in the right place: the folder convention means the agent always knows where truth lives, which is what lets the human stay at idea level while the machine handles the details.

## Guardrails

- Build nothing rule-shaped until a week of real verdicts exists in the log.
- Every new surface gets easy account switching and a per-account voice file by default.
- Success metric: zero revisions by the human after a draft or a triage, and the user reporting calm.

## How To Choose Goals

- Read MEMBER.md, MISSION.md, current goals, now.md, and recent logs.
- Choose one useful bounded goal toward the mission.
- Verify the work, write the receipt, and update the log.
- Ask the human when vision, taste, risk, or uncertainty matters.
