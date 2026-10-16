# Campaign ask wait test increment

Added test/campaign-ask-wait.test.js; frozen verifier exited 1: 1 pass, 3 failures. Not verified and not approved for feature release.

Plan: agent write attempt -> real command handler -> real memory store -> retained ask and output assertions.

Files: test/campaign-ask-wait.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/validator/logs/2026-10-15.md, this receipt.

Verify: cd /tmp/cli-a && test -f test/campaign-ask-wait.test.js && node --test test/campaign-ask-wait.test.js

Exact captured output:

```text
✖ an explicit agent cannot write a default event by hand (2.2185ms)
✔ an explicit agent cannot silently close an ask through answer or a forged person (0.755542ms)
✖ a parked ask remains visible in campaign show text and JSON (0.446833ms)
✖ a person may answer after the default without becoming an unknown ask (0.251416ms)
ℹ tests 4
ℹ suites 0
ℹ pass 1
ℹ fail 3
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 50.765625

✖ failing tests:

test at test/campaign-ask-wait.test.js:38:1
✖ an explicit agent cannot write a default event by hand (2.2185ms)
  AssertionError [ERR_ASSERTION]: {"ok":true,"action":"ask_defaulted","campaign":{"id":"cmp-ask-wait","title":"Ask wait","judge":"exit 1","owner":"mission-lead","standing":false,"bet":null,"parent":null,"home":"ask-wait-test","created_from":null,"seats":[],"state":"needs_you","stop_reason":null,"answer":{"text":null,"confidence":"open"},"budget":{"total":10,"spent":0,"reserved":0,"available":10},"asks":[{"id":"a-wait","question":"Send the note?","mission_id":null,"default":"no","due_at":"2026-10-01T00:00:01Z","parked":false}],"missions":[],"judge_runs":0,"judge_due":true,"last_judge":null,"warnings":[{"event_id":"evt-b37a1bef-f943-4529-904b-a04894231e1d","code":"ask_not_defaultable"}]},"next":{"action":"wait","reason":"open asks","asks":["a-wait"]}}
      at TestContext.<anonymous> (/private/tmp/cli-a/test/campaign-ask-wait.test.js:43:10)
      at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
      at async Test.run (node:internal/test_runner/test:1069:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:332:3) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: 0,
    expected: 0,
    operator: 'notStrictEqual'
  }

test at test/campaign-ask-wait.test.js:65:1
✖ a parked ask remains visible in campaign show text and JSON (0.446833ms)
  AssertionError [ERR_ASSERTION]: show must recognize a deadline in the past
  
  false !== true
  
      at TestContext.<anonymous> (/private/tmp/cli-a/test/campaign-ask-wait.test.js:77:10)
      at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
      at async Test.run (node:internal/test_runner/test:1069:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:752:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: false,
    expected: true,
    operator: 'strictEqual'
  }

test at test/campaign-ask-wait.test.js:80:1
✖ a person may answer after the default without becoming an unknown ask (0.251416ms)
  AssertionError [ERR_ASSERTION]: the late human answer must replace the default, not be discarded
      at TestContext.<anonymous> (/private/tmp/cli-a/test/campaign-ask-wait.test.js:91:10)
      at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
      at async Test.run (node:internal/test_runner/test:1069:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:752:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: false,
    expected: true,
    operator: '=='
  }

```

Progress: four runnable regressions, no skips. Agent answer/impersonation check passes. Default event write guard, parked display status, and late human replacement fail. The late-answer test detects discarded answers via unknown_ask; a final effective-answer representation still needs an agreed contract.

Missing from prep: schema and fold changes appeared in the shared checkout during this increment. They belong to sibling work and were not edited or staged. The fourth requirement remains truncated after "a fresh as"; clarification requested. Brain activation reported plan-only; generated policy changes were left outside this bounded test task.

next_push: wire default-event authorization and clock-aware campaign display, and preserve a late human answer after defaulting; then rerun these tests.

layer: capabilities

