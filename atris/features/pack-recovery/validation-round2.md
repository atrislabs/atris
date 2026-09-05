---
reviewed_owner: backend-feature-owner
reviewed_execution: opencode / muse-spark-1.3-contributor-free / xhigh
validator: backend-independent-validator
independent: true
decision: block
reviewed_diff_sha256: deb5ade8c4ba832a57175f5d1ec47e37ebbf3f8e4b7bd83468a237a63e72f62f
scope: commands/pack.js, lib/pack-capabilities.js, test/pack-run.test.js
evidence_class: local and simulated
---

# Independent repaired-diff review

The repair resolves the six original reproduction cases, but two gaps in strict history validation still block landing. I did not author or repair the product diff. The first review remains at `/tmp/pack-recovery-validation-round1.md`.

## Remaining actionable findings

1. **High: malformed or missing inherited protection becomes an empty list and permits repeating completed work.** In `lib/pack-capabilities.js`, assessPackRecoveryJournal derives `inherited` with `launch.recovery && Array.isArray(launch.recovery.protectedFiles) ? ... : []`. A recovered launch with `protectedFiles: {}` or no protectedFiles is therefore accepted. The reproduction starts from the real console-produced failed child containing a completed inherited done.txt, changes only its launch protection field, and observes assessment return `[]`. Calling actual runPack on that history then invokes the real pre-hook; Write to done.txt returns null (allowed). Output: `runPack from malformed inherited history permits completed Write: true`. Validate the entire launch recovery discriminated shape before deriving inherited protection: recovered mode requires valid parent identity and an array of well-formed protected identities; absent/malformed recovered state must refuse. Cover transitive recovery with damaged protection, and check consistency with recorded recovery identity rather than silently treating it as fresh.

2. **High: the recorded tool ceiling is checked only for being an array.** assessPackRecoveryJournal accepts a launch whose grantedTools includes Bash while grantedCapabilities and current policy remain only pack.write. The independent probe prints `journal tool ceiling includes Bash ACCEPTED` with the protected file. This is a conflicting authoritative history in which the original runner may have had an unjournaled shell tool, violating the required refusal of prior shell effects. Validate grantedTools against the exact tools implied by validated canonical capabilities and compare stable summary/launch ceiling evidence; reject extra, unknown, duplicate, or conflicting entries. Mere array shape does not establish the original permission boundary.

## Exact checks and results

- `node --test test/pack-run.test.js test/pack-safety.test.js test/pack.test.js test/config-guard.test.js > /tmp/pack-recovery-independent-final-tests.log`: exit 0, 184 passed, 0 failed, duration 4376.170083 ms. No exit-code-hiding pipeline.
- `git diff --check`: exit 0, no whitespace errors.
- `git diff -- commands/pack.js lib/pack-capabilities.js test/pack-run.test.js | shasum -a 256`: digest recorded above.
- `node /tmp/pack-recovery-independent-restored.cjs > /tmp/pack-recovery-independent-round2.log`: exit 1 because the old diagnostic's final empty --recover call now correctly throws and was not caught. Earlier output independently confirms missing exit, mismatched shell capabilities, post-before-intent, mismatched tool pair, and unknown pending tool all refuse; malformed protection denies; real launchClaude exits 1 and parent claim now names the child; authoritative journal Write is denied. This script's nonzero result is explained, not counted as a product regression.
- `node /tmp/pack-recovery-independent-round2-extra.cjs > /tmp/pack-recovery-independent-round2-extra.log`: exit 0 (diagnostic completion, not acceptance). Confirms both findings and the actual runPack/pre-hook completed-file permission bypass. Also confirms a paired failed action with unchanged bytes resolves against its inherited confirmation. Artifacts are under `/private/tmp/pack-recovery-independent-O1pS67`; the script restores the modified parent journal after each probe. The final bypass probe consumes a temporary fixture claim, so rerunning that final step requires a fresh fixture or an isolated copy.

## Resolved cases and residual limits

The receipt callback now confirms the child before invoking the runner; the independent probe used actual commands/console.js launchClaude with an executable that exits 1, so this proof reaches the real non-returning process exit. Empty explicit recovery flags reject. Canonical receipt/claim/child placement checks reject locations within the Pack root before recovery claiming; hardlinked evidence is refused. The mutation hook denies authoritative journal path/inode aliases and malformed protection. Existing suite coverage for missing-post crash gaps, changed files, concurrent/repeated claim refusal, transitive protection, hardlinked completed files, inode aliases, privacy canaries, and pre-hook exit 2 remains green. Inherited failed no-op handling also passed the independent probe.

Evidence is local: real filesystem and hooks, simulated runner/model, deliberate journal-corruption probes. No production, model, network, credentials, customer actions, or live Claude session was used. No general exactly-once or power-loss durability claim is supported. These two remaining acceptance failures need repair and an independent re-review before landing.
