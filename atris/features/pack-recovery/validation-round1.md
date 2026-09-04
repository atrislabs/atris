---
reviewed_owner: backend-feature-owner
reviewed_execution: opencode / muse-spark-1.3-contributor-free / xhigh
validator: backend-independent-validator
independent: true
decision: block
evidence_class: local and simulated
reviewed_diff_sha256: db8bc3659a0289d5fe4df0aa8f6cf2e1d7d1bfc601fd3e98f2af677fd8998cf2
scope: commands/pack.js, lib/pack-capabilities.js, test/pack-run.test.js
---

# First-pass independent review

The completed first-pass implementation is blocked. I did not author or repair product code. This receipt describes the original reviewed diff only, not the repair now in progress. The original checkout was subsequently removed externally; evidence is preserved under /tmp.

## Checks and evidence

- In the original checkout, `node --test test/pack-run.test.js test/pack-safety.test.js test/pack.test.js test/config-guard.test.js`: exit 0, 180 tests passed, 0 failed, duration 4855.4065 ms.
- `git diff --check`: exit 0, no whitespace findings.
- `git diff -- commands/pack.js lib/pack-capabilities.js test/pack-run.test.js | shasum -a 256`: recorded diff digest above.
- `node /tmp/pack-recovery-independent.cjs > /tmp/pack-recovery-independent.log`: exit 0. This is a diagnostic reproduction, so exit zero means the script completed, not that acceptance passed. Its printed outcomes reproduce the blockers below. The script references the original checkout, which no longer exists; preserve its log as original evidence and use an explicitly updated path for future reruns.
- Reproduction artifacts: `/private/tmp/pack-recovery-independent-k5syZD`. The reproduction uses real temporary files, real receipt/hook functions, and the actual exported `commands/console.js` launchClaude function with a local executable that exits 1. It does not invoke a model, network service, credentials, or customer data.

## Findings

### 1. High: an empty explicit recovery option silently launches fresh work

`commands/pack.js:2712` parses the recovery value, but subsequent checks use its truthiness. `--recover=` becomes an empty string and bypasses all recovery assessment and protection. Independent reproduction printed `explicit empty --recover= launched fresh: 1` using runPack with a counted local runner. An empty receipt variable can therefore replay completed mutations instead of refusing. Track option presence separately and reject empty values before installation or launch; cover both equals and separate-value forms.

### 2. High: recovery trusts stale summary lifecycle and policy over the authoritative journal

`lib/pack-capabilities.js`, assessPackRecoveryJournal beginning at line 560, validates exit and granted capabilities from summary while only lightly checking the journal launch. With a valid failed summary retained, removing the journal exit still produced `missing journal exit: ACCEPTED protected=1`. Changing authoritative launch capabilities to include host.shell also produced `journal grants host.shell: ACCEPTED protected=1`. This violates the required proof of confirmed unsuccessful child exit and rejects neither conflicting nor truncated evidence. Derive lifecycle, identity, capabilities, input, and journal version from strictly validated authoritative events and refuse inconsistent summary/history rather than using summary assertions as proof.

### 3. High: journal pairing accepts corrupted or ambiguous action histories

`lib/pack-capabilities.js:486-524` filters events by recognized tool and pairs primarily by ID without enforcing chronology or identical tool. Independent cases all returned ACCEPTED: post before intent, a Write intent paired with an Edit post, and an unknown mutation tool name hiding a pending intent. The last case adds an `intent` with tool `Writ`, which is silently dropped. Validate event schemas, recognized event/tool values, unique identities, ordering, and exact tool/target pairing, including failure pairs, and refuse ambiguity. Existing green tests do not establish this strict contract.

### 4. High: authoritative receipt storage can be inside the writable Pack root

`lib/pack-capabilities.js`, receiptDirectory/beginPackRunReceipt and claimPackRecoveryParent, does not enforce that receipt, events, and claim files are outside the Pack root. The supported receipt directory override can put them inside it. Independent reproduction created in-root receipt events and called the real pre-hook with Write targeting the authoritative journal; result was `ALLOWED`. The runner can therefore overwrite the evidence used to prove safe continuation. Validate canonical receipt, companion journal, claim, and child storage locations before accepting recovery or starting a journaled run, including aliases. Keep these outside runner-writeable Pack storage.

### 5. Medium: actual console exit prevents recording the child in its parent claim

`commands/pack.js:2804-2815` confirms childReceipt only after startPackLocal returns. The actual `commands/console.js:352` calls process.exit, so it never returns. Independent reproduction used actual launchClaude with a local exit-1 executable: exit status 1, a child receipt was created, but the parent claim retained `childReceipt: null`. All real launches therefore leave a misleading manual-review claim instead of pointing to their known child. Record the child link in the pre-launch receipt callback before invoking the runner; preserve fail-closed handling of genuine interrupted claims. This finding is reproduced beyond the normal-return mocked runner seam.

### 6. Medium: malformed protection metadata silently removes all protection

`lib/pack-capabilities.js`, readProtectedFiles near line 393, returns an empty list when environment JSON is malformed or not an array. After recording a completed Write, setting ATRIS_PACK_PROTECTED_FILES to malformed JSON and invoking the actual pre-hook permitted another Write to that completed file (`malformed protected environment: ALLOWED`). Reject missing or malformed recovery protection metadata instead of treating it as a fresh run. This was fault-injected local evidence, not an assertion that an ordinary model can change its inherited environment.

## Positive coverage and limits

The scoped suite independently verifies the ordinary completed-edit denial and continuation, missing-post refusal, failed-effect handling, changed-file refusal, inherited protection, claim reuse refusal, hardlink/inode protection, path confinement, privacy canaries, and executable pre-hook exit 2 on journal failure. Inspection confirms exclusive `wx` claim creation provides a useful single-claim primitive. Those checks do not cure the findings above.

No live Claude session, network request, deployment, customer action, or secrets were used. Runtime exit behavior was exercised with the actual console launch function and a simulated local runner. Journal corruption and malformed metadata cases were deliberate local fault injections. General exactly-once guarantees, durable power-loss behavior, and production concurrency were not established. Re-review the repaired diff independently before landing.
