# Campaign ask wait review

Reviewed the existing real-handler tests, exit 1: two pass, two fail. No implementation or test assertions changed. The late-answer regression now passes on sibling uncommitted source changes, so this is not a release approval.

Flow: existing asks -> real command handler + memory store -> unchanged assertions -> executor handoff.

Verify command (run once, bare):
```sh
cd /tmp/cli-a && test -f test/campaign-ask-wait.test.js && node --test test/campaign-ask-wait.test.js
```
Exit: 1. Output excerpt:
```text
✖ an explicit agent cannot write a default event by hand (2.366292ms)
✔ an explicit agent cannot silently close an ask through answer or a forged person (0.853ms)
✖ a parked ask remains visible in campaign show text and JSON (0.482459ms)
✔ a person may answer after the default without becoming an unknown ask (0.264125ms)
ℹ tests 4
ℹ pass 2
ℹ fail 2
```

Failure evidence: test/campaign-ask-wait.test.js:43 receives exit 0 and ok:true/action:ask_defaulted instead of refusing the append. At :77 show JSON returns parked:false for an overdue ask. Source inspection confirms commands/campaign.js:620 omits ask_defaulted from guarded events and lib/campaign-store.js:354/:363 folds without a read clock.

Progress: one more passing check than the prior receipt. Two implementation failures remain. Requirement four is still missing after “a fresh as”. No new human answer request was created.

Role constraint: atris/team/validator/MEMBER.md says “Judge never patches”. Created executor task CAX-2 with exact files, finish line, rollback and frozen check, and noted the failed review on CAX-1. No task was accepted. Sibling source and map changes were left intact.

Commands: atris mission status m-write-test-campaign-ask-wait-test-js-cov-3941d6; git status --short; atris; atris task list --status open; atris mission goal --json; git diff -- lib/campaign-core.js; atris task show CAX-1; frozen command above; atris task delegate; atris task note. Brain activation returned exit 2, plan only, and was not applied.

Files edited: this receipt and atris/team/validator/logs/2026-10-15.md. Durable task notes stored locally. No route changed, so no map edit needed. Prep brief lacked the explicit reviewer source-edit prohibition; member instructions supplied it.

next_push: executor fixes handwritten default rejection and clock-aware parked display, then validator reruns the unchanged tests.

layer: behaviors
