# Recover recorded Pack file work
owned_by: backend-feature-owner
executed_by: opencode / muse-spark-1.3-contributor-free / xhigh; Codex owner final consistency correction
validated_by: backend-independent-validator (fresh independent context)
task: CLI-1334
repo: /Users/keshavrao/arena/.agent-worktrees/atris-cli/backend-feature-owner-repair-reviewed-pack-recovery-cli-13-20260904-213619

## Goal
A local enforced Pack interrupted after one completed file edit can continue other work through an explicit --recover <receipt.json> without applying the completed file mutation again. Prove with actual temporary file changes through the real CLI hooks, not prompt text assertions alone.

## Evidence and judgment
OpenCode model metadata exposes minimal/low/medium/high/xhigh, not max. The initial --variant max connectivity call returned, but did not establish max reasoning. Execution was restarted at supported xhigh before product edits; no silent maximum-effort claim.
Fable located the active runtime in atris-cli, not backend. Current runPack always begins again; used events have only tool names. Baseline 49 tests passed: node --test test/pack-run.test.js test/config-guard.test.js.
Fable proposed adding a recovery prompt and rewriting launcher-lost to interrupted. The owner rejects both as sufficient guarantees: a prompt cannot enforce no-repeat, and a missing launcher does not prove its child stopped. Preserve classifyPackRunLifecycle and append-only historical truth.

## Bounded design to challenge
record intent -> execute file tool -> record confirmation -> confirmed runner exit
recover -> verify journal + file state -> protect completed files -> continue other files

1. Only commands/pack.js, lib/pack-capabilities.js, and test/pack-run.test.js for product/test edits. Documentation map + this packet/receipts separately.
2. Add explicit local pack run <existing-dir> --recover <receipt.json>. Do not implicitly recover every fresh run. Reject cloud, legacy, host.shell (prior or current), capability widening/change, wrong pack/root/version, active/unknown runner, success exit, missing/malformed journal, missing action identities, mismatched operator input, and any unresolved mutation BEFORE launching. A killed launcher alone is not enough: require a recorded nonzero/signal runner exit. Failed/pending file effects remain unresolved, never assumed safe.
3. New enforced runs journal each Write/Edit intent in PreToolUse AFTER all guards approve but BEFORE execution, keyed by tool_use_id, tool and canonical relative target; no raw content or arguments. Successful PostToolUse confirms same identity with file SHA-256. Missing post remains unresolved. A failed tool counts resolved ONLY with a paired failure event and current bytes matching the last confirmed hash for that target, or an absent never-confirmed target; otherwise refuse. Journal failures block pre via existing exit-2 behavior; post failure leaves pending. Existing ordinary runs stay otherwise compatible. Include explicit journal support/version marker on new launch so old receipts cannot be treated as complete.
4. Recovery reads the authoritative companion events strictly, not just a stale summary; validate shape, root confinement, path safety, and event pairing. Verify current completed-file bytes match most recent confirmed SHA-256. Reject ambiguous/corrupt/missing state with a plain error. Never rewrite the old receipt to claim the child stopped.
5. New recovered run has a new receipt linked to prior run and carries inherited protected completed paths (with hashes). Real PreToolUse denies ALL Write/Edit to those completed paths, not just matching call IDs or arguments. Read remains allowed. The model receives a concise note naming protected files and can complete different files. This deliberately does not support further changes to an already completed file during recovery. No shell escape allowed. Carry protection through subsequent recovery too. Root/symlink confinement remains enforced. Consider aliasing/hardlinks when protecting existing files.
6. The missing-post crash window must refuse automatic recovery rather than risk replay. Do not claim general exactly-once semantics, process-kill recovery, cloud support, or automatic completion.
7. Receipt observability should name confirmed versus unresolved file effects and parent/protected recovery truth without including operator input contents or file contents.
8. A parent receipt must not spawn two recoveries or be reused after a child partly executes. Atomically consume/claim a parent for exactly one child (exclusive-create sibling claim, no automatic stale-claim deletion). Fail closed when already claimed; point to the child receipt when known. Further recovery uses the failed child and inherits all prior protected paths. A crash during claim leaves an explicit manual-review state, never an automatic replay. Keep claims outside the Pack root alongside private receipts.
9. Fable design review SIGNOFF (2026-09-04, canonical ask receipt engine-ask-20260904200543778-35329-0a2c63a7): protect resolved paths AND device/inode identity to catch case aliases on macOS. Refuse recovery if a protected file has nlink > 1; check mutation targets against protected device/inode pairs. Record intents only after guards approve; include tests that denied mutations leave no pending intent. An interactive permission denial may leave a pending intent with no post-hook: refuse safely and document that this recovery primarily serves headless/trusted runs.
10. Owner retains the atomic single-child claim despite Fable considering simultaneous children harmless to original-file protection: partially completed child work must not be replayed from a stale parent. Do not broaden beyond this small claim. Existing pre-hook executable already exits 2 on errors; preserve it. Official Claude hooks reference confirms tool_use_id in PreToolUse and PostToolUse: https://code.claude.com/docs/en/hooks .

## Acceptance / verify
node --test test/pack-run.test.js test/pack-safety.test.js test/pack.test.js test/config-guard.test.js
Regression: a real first Edit appends a line while retaining its marker, real pre and used hooks record it, runner exits unsuccessfully; recover; same Edit is deterministically denied (even new call ID or changed payload), line occurs once; another file action proceeds and successful recovery receipt links back and preserves prior effect truth. Model/runner is simulated at computerLocal, filesystem and hooks are real.
Also pending intent + file effect without post -> no launch; active/launcher-lost/unknown -> no launch; legacy/corrupt/traversal/root mismatch/host.shell/cap escalation -> no launch; changed completed file -> no launch; normal run tests remain green; no raw secrets/content in journal; transitive protected files stay protected. Actual test hook subprocess check blocks with exit 2 on journal failure if feasible.
No network/model calls in tests.

## Scope and delivery
No backend Python edits, new dependencies, generic workflow engine, deployment, real customer actions, or secret access. Preserve unrelated edits. Do not commit/push as executor. Return files, actual tests, branch, limitations. Owner independently reruns tests, fresh reviewer judges finished diff, then landing owner ships if passed. Rollback by reverting only this bounded change.
