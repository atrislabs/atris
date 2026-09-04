# Pack recovery proof

Owner: backend-feature-owner. Implementation: Muse Spark through OpenCode, supported xhigh variant, with final receipt/journal and tool-record consistency corrections and regressions added by the Codex owner. Design challenge: Fable. Independent reviewer: backend-independent-validator, Codex, no product authorship.

## Behavior

Use `atris pack run <existing-directory> --recover <receipt.json>` to continue an eligible failed local run. Completed file writes become read-only during recovery. Other files can still be written. Each recovery has its own receipt, and its parent can be consumed once.

Recovery requires a journaled, confirmed unsuccessful runner exit and unchanged completed files. Missing confirmations, damaged history, old receipts, shell permissions, changed input, active or unknown processes, and ambiguous file identities refuse before launch. Losing the launcher alone does not establish that its child stopped.

## Evidence

Before the change, a simulated runner using the real file hooks appended a second copy of a line on retry. After the change, regression tests exercise the actual temporary filesystem, journal, CLI entry, pre/post hooks, and the executable pre-hook denial. The model is simulated. An independent probe also exercised the real console launcher exiting with status 1 to check that the parent already names its child.

Runnable check: `node --test test/pack-run.test.js test/pack-safety.test.js test/pack.test.js test/config-guard.test.js`.

GitHub full CI initially found three unused helper exports; the owner removed those exports without changing internal behavior. The expanded local check adds `test/repo-hygiene.test.js` and passes 192 tests.

Final test result and reviewed diff identity are recorded in `validation.md`. Earlier block receipts are retained because the initial green suite missed adversarial cases; they are not approvals.

## Limits

This is explicit local file recovery, not a general exactly-once guarantee. An interrupted write without a matching confirmation requires manual review. Interactive permission denial can leave an unresolved intent. File protection applies to recovery, not a fresh normal run. No power-loss durability, live model session, cloud recovery, customer actions, deployment, or npm publication was tested or performed.

Fable approved the design refinements recorded in plan.md. Its supplemental finished-code review timed out without a verdict. Independent code approval therefore comes only from the separate reviewer, not that timed-out Fable call.
