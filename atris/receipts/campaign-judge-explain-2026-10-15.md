# Saved judge explanations

Drafted explanations now stay with the campaign and appear beside passed or not yet in explicit judge runs and loop logs. Real shell judges and the frozen check passed.

Plan: draft -> campaign_started.explain -> judge message -> passed/not yet.

Files: commands/campaign.js; lib/campaign-reading.js; lib/campaign-loop.js; test/campaign-draft-judge.test.js; test/campaign-command.test.js (one old wording assertion); atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/validator/logs/2026-10-15.md; this receipt.

Verify command (frozen, unchanged):
```sh
cd /tmp/atris-cli-campaign && grep -q explain lib/campaign-reading.js && test -z "$(git status --short -- test/fixtures/campaign lib/campaign-schema.js)" && /opt/homebrew/bin/node --test test/campaign-command.test.js test/campaign-loop.test.js test/campaign-conformance.test.js test/campaign-draft-judge.test.js
```
Exit: 0. Output: tests 39; pass 39; fail 0; cancelled 0; skipped 0; todo 0.

Additional command:
```sh
/opt/homebrew/bin/node --test test/campaign-reading.test.js test/campaign-core.test.js test/campaign-trace.test.js
```
Exit: 0. Output: tests 60; pass 60; fail 0; cancelled 0; skipped 0; todo 0.

Initial frozen check: exit 1 because an existing real CLI test expected "judge failed". Updated only that assertion to "judge not yet". Final frozen check passed.

Metric: two new real-shell regression cases cover stored explanation, copied script paths, both verdicts, a changed judge, final-line precedence over counts, punctuation-only output, and empty output. Existing numeric reading, summary, schema, and fixture contracts remain intact.

The answer row and already-done messages retain stored summaries; only judge result sentences use the new display helper. No packages added. No fixtures or schema changed.

Missing from prep: the existing CLI copy test pinned "judge failed", so its expectation needed changing. Confirmed /tmp resolves to this checkout and local cloud sync forwards whole event data; no live cloud operation was performed. Mission task attachment was locked by another process, so a separate claimed task records this bounded slice. Brain activation and compilation ran in plan-only mode and proposed unrelated files, so none were written.

Real CLI proof:
```
command: ['/opt/homebrew/bin/node', '/private/tmp/atris-cli-campaign/bin/atris.js', 'campaign', 'start', 'Explain proof', '--judge', "printf '2 failed\\nwaiting for billing\\n'; exit 1", '--id', 'cmp-reading-proof']
stdout:
started Explain proof (cmp-reading-proof)
Explain proof  (cmp-reading-proof)

state     resting · next: plan and run the next missions: atris campaign run cmp-reading-proof
judge     printf '2 failed\nwaiting for billing\n'; exit 1 · last run failed at 2026-10-15T11:23:09.210Z
answer    open: 2 failed
owner     mission-lead
seats     none
missions  none
asks      none

stderr:
running the judge first: printf '2 failed\nwaiting for billing\n'; exit 1

exit: 0

command: ['/opt/homebrew/bin/node', '/private/tmp/atris-cli-campaign/bin/atris.js', 'campaign', 'judge', 'cmp-reading-proof']
stdout:
judge not yet in 0s: waiting for billing
Explain proof  (cmp-reading-proof)

state     resting · next: plan and run the next missions: atris campaign run cmp-reading-proof
judge     printf '2 failed\nwaiting for billing\n'; exit 1 · last run failed at 2026-10-15T11:23:09.426Z
answer    open: 2 failed
owner     mission-lead
seats     none
missions  none
asks      none

stderr:
running the judge: printf '2 failed\nwaiting for billing\n'; exit 1

exit: 1
```

next_push: show the saved explanation in the campaign answer row while preserving the stored judge summary.
layer: behaviors
