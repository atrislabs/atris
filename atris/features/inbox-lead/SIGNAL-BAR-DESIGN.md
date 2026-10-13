# Signal bar design notes (rung three)

Collected 2026-08-28 from an outside model review (GPT 5.6 Pro) of the verdict log design, judged against our guardrails. Build starts only after a week of real verdicts exists.

## The one bug it caught (fixed same day)

The hourly pass rereads the newest window, so a lingering message got one verdict row per hour and counts measured dwell time, not preference. Triage now skips already-judged ids (CLI 3.57.3). When mining the log, dedupe by message_id anyway: rows before 3.57.3 contain duplicates.

## Architecture: two stages, not one score

One. A suppressibility gate. An email may be silenced only on strong affirmative bulk evidence, ideally two independent signals (list headers plus repeated subject template). Unknown, new, or plausibly human mail bypasses the bar entirely and always pings.

Two. An attention score, only for suppressible mail. Recency-weighted shrunk keep rate per sender, backed off through domain then account priors so sparse senders inherit instead of getting extreme scores from one message:

    p = (keeps_sender + 4 * p_domain + 8 * p_account) / (n_sender + 12)

Adjust modestly for subject novelty, recent explicit keeps, cadence regularity.

## Ground truth rules

- Never use the heuristic verdict as a training label; keep it only as provenance for disagreement analysis.
- Join the user's real mail-client actions by message_id with a 48-hour maturation window.
- Strong positive: reply, star, mark-important, explicit keep. Strong negative: archive with no later positive, especially batch archive.
- No action is NOT a keep label; it is censored data. Treat as positive/unlabeled if negatives are unreliable.
- Once suppression launches, behavior becomes treatment-biased. Ship a nightly digest of suppressed mail with a "should have pinged" correction; those corrections are the real notification labels.

## The named biggest mistake

Equating mailbox disposition with interruption value under one global threshold. An important human mail gets read then archived; a kept newsletter still deserves no ping; and one global score eventually silences rare first-contact humans because they have no history. Only high-confidence bulk classification grants permission to silence.

## Explainability contract

Every silence and every ping renders as one plain sentence from the actual features: "Silenced: mailing-list headers, 11 messages a week, 9 of 10 archived." "Pinged despite newsletter markers: you kept the last four."
