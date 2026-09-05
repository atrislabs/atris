# Pack recovery landing receipt

Owner: backend-feature-owner. Landing owner: backend-landing-owner, executed by Codex.
Implementation: Muse Spark through OpenCode at xhigh, plus Codex owner corrections for direct journal/summary consistency and event tool/capability consistency.
Design challenge: Fable. Independent validator: backend-independent-validator, fresh Codex context without product authorship.

Implementation commit: 08689f38aed97bc985608d2eafde336b6042afaa.
Reviewed product diff SHA-256: 2b73d1e2a704f8bbcd152682efc865c50343fb9f73abeb4f6a7526de77066626.
Pull request: https://github.com/atrislabs/atris/pull/930.
Target: origin/master in atrislabs/atris.

Checks: independent pass in validation.md; 192 passed, 0 failed for `node --test test/pack-run.test.js test/pack-safety.test.js test/pack.test.js test/config-guard.test.js test/repo-hygiene.test.js`; whitespace check passed; guarded ship verified, committed and pushed only the scoped implementation, tests, map, and receipts. GitHub CI result is captured in proof/pack-recovery-github-actions.json and .md.

Deployment: not performed. No npm version bump, tag, publication, live model execution, or customer actions.
Residual limits: explicit local file recovery only, confirmed unsuccessful runner exit required, ambiguous history requires manual review; no general exactly-once or power-loss durability claim.
Next pilot move: exercise a newly journaled, eligible failed local Pack via `atris pack run <existing-directory> --recover <receipt.json>`; inspect the linked child receipt. Historical unjournaled runs cannot recover automatically.

## Repeating the delegated build setup

The selected installation was `~/.opencode/bin/opencode` version 1.18.28. A different older OpenCode binary appeared earlier on PATH. The tested profile was `opencode/muse-spark-1.3-contributor-free`, with supported highest variant `xhigh`; OpenCode did not expose a `max` mapping for this profile. The initial connectivity call using max was replaced with xhigh before product edits.

`~/.opencode/bin/opencode run --model opencode/muse-spark-1.3-contributor-free --variant xhigh --auto "<bounded task with files and verification contract>"`

Fable's design approval is summarized in plan.md. Its supplemental finished-code request timed out without an approval. The first independent reviewer surfaced further issues but later hit an automated service flag; the fresh final review in validation.md is the actual approval. Green builder tests were not treated as independent evidence.

## Confirmed landing

Merged into origin/master at 54cea509c7fdbc6ef4adcd3caafee1ba148f2ed3 on 2026-09-04T22:14:05Z. GitHub confirmed the pull request state is MERGED. The three approved product files are byte-identical in the merged commit.

Full GitHub CI passed on prospective merge 7b09551fafbea0ab5272a0403e12fe7b0ef9374f, including the intervening YouTube change: 4,466 passed, 23 skipped, zero failures (4,489 total). Deck lint completed with zero errors and eight warnings. Both push and pull-request checks succeeded. Evidence: https://github.com/atrislabs/atris/actions/runs/33924069802.

A final independent continuity review confirmed all three product blobs exactly match the approved source and the map preserves both the advanced base and this recovery addition. No conflicts or whitespace errors were found. That check did not alter files or repeat the already completed full build.

This receipt-only follow-up adds the landing and CI evidence; it does not change product code. The primary local checkout and unrelated user edits were preserved. Task acceptance and XP remain with the human owner.
