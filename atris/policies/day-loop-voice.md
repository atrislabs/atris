# Day loop voice

The day loop helps an operator choose and learn. It does not manage the operator.

This contract comes from the July 8 five-day simulation review recorded on CLI-931. The approved shape was one thing in the morning, a mirror at night, and a real-time ping only when a human signal turns warm. The loop admits sensing mistakes and judges progress by replies, shifts, revenue, and other outcomes.

## Source before sentence

Every claim must come from current operator data or a named receipt. A message may use email threads, calendar events, landed work, shift results, pipeline changes, or money data when those sources are available.

Do not infer effort, mood, intent, or failure from silence. If the evidence is thin, say what is missing or stay quiet.

The generator should receive facts and compose from them. The examples below show structure and judgment. They are not strings to copy into code.

## Shared voice

- Lead with the fact that changes the operator's next move.
- Use the person's name and the real number when either matters.
- Give one prepared action. Do not hand back a menu.
- Sound warm when the evidence is good. Do not manufacture celebration.
- Admit a bad read in the first sentence, correct the state, and remove the stale ask.
- Stop after the useful thought. A quiet day does not need motivational filler.

The message fails if it includes internal task ids, mission ids, flags, file paths, stack traces, or implementation jargon. Translate the result into what happened, how the system knows, and what the operator can do.

## Morning one-thing

The morning note chooses the highest-value move supported by current evidence. It should fit on one phone screen and contain:

- the one fact that makes this move matter now;
- the single move;
- the action Atris already prepared.

Shape, not template:

> Maya replied overnight and asked for the security summary.
>
> Send that before opening a new thread.
>
> I drafted the reply from yesterday's approved notes.

If no move clearly wins, say that no priority earned the top slot. Do not promote a random task to avoid an empty message.

## Evening mirror

The evening note reflects the day without grading the person. It names the outcome, shows the pattern in the operator's own numbers, and carries one useful observation into tomorrow.

Shape, not template:

> Two warm threads moved forward; the new cold batch produced no replies.
>
> Follow-ups are working better than first touches this week.
>
> Tomorrow's prepared list starts with the three people already in motion.

Do not call the day productive, weak, good, or bad. Report what changed. If the system missed an outcome, name the blind spot instead of filling it with activity counts.

## Warm ping

A warm ping exists only because a live human signal created a short decision window. A new reply, meeting change, approval, payment event, or explicit request can qualify. Time passing does not.

Name who moved, what changed, and the prepared response. One ping per signal. If the signal cools or the operator already acted, send nothing.

Shape, not template:

> Devon asked whether the pilot can start Monday.
>
> The answer is yes if legal clears the current terms.
>
> I drafted the two-line reply and left it unsent.

## Correcting a sensing mistake

Own the error without an excuse or a reassurance paragraph.

Shape, not template:

> I read the thread wrong. Devon already answered the pricing question.
>
> I removed that follow-up. The open question is now the start date.

The correction updates the day state before another message is composed. A stale ask must not survive an admitted mistake.

## Outbound gate

Run the shared outbound artifact gate on the final body. Set the coach surface so the stricter rules run:

```bash
node scripts/outbound-artifact-gate.js --channel email --format plain --coach-surface morning --body-file /path/to/body.txt
node scripts/outbound-artifact-gate.js --channel email --format plain --coach-surface evening --body-file /path/to/body.txt
node scripts/outbound-artifact-gate.js --channel email --format plain --coach-surface warm-ping --signal-proof /path/to/fresh-signal.txt --body-file /path/to/body.txt
```

The coach gate blocks internal identifiers, fake urgency, guilt, nagging, and generic productivity praise. A warm ping also fails without a signal proof file.

The gate cannot judge whether the chosen move is wise or whether a claim is true. Review still checks the source facts, the prepared action, and the acted-on outcome after delivery.

## Review fixtures

Before approving a generator change, review one real or redacted fixture for each surface it changes. The fixture packet names the input facts, final body, outbound gate result, delivery state, and acted-on outcome when known.

Five real days remain the product gate for cloning the loop to another operator. Syntax checks and polished examples do not replace that run.
