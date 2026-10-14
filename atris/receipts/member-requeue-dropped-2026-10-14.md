# Dropped member changes recover

Saved member handoffs now catch up with the main branch and return to GitHub's merge line. The frozen check and actual CLI invocation passed, both exit 0.

## Scope and decision

Proceed with the bounded recovery pass. The sharpest failure mode is enqueueing outside changes using an old review. Recovery requires the original clean checkout and review, current linked-task approval, the exact saved same-repository request, and matching remote head. Conflicts or changed heads leave the branch untouched. GitHub still decides when checks permit merging.

```text
successful reviewed handoff -> saved commit and request
hourly pass -> still open and dropped? -> same remote commit?
            -> original review and current approval valid?
            -> fetch main -> clean merge -> push -> pinned auto-merge
any failed gate -> keep branch and record reason
```

## Files edited

- `lib/member-autoland.js`: durable handoff records and bounded recovery, clean catch-up merge, pinned enqueue.
- `commands/autoland.js`: heartbeat recovery and receipt outcome.
- `test/autoland-requeue-dropped.test.js`: real Git regression cases and actual CLI invocation.
- `atris/MAP.md`, `atris/refs/MAP-NOTES.md`: recovery navigation.
- `atris/team/architect/logs/2026-10-14.md`: work and learned pattern.
- `atris/receipts/member-requeue-dropped-2026-10-14.md`: this receipt.

## Proof

Rerun: `node --test test/autoland-requeue-dropped.test.js`

Exit: 0. Exact summary: tests 9, pass 9, fail 0.

Actual changed surface, invoked by that check in a temporary repository:

```text
node bin/atris.js autoland tick --json
output: {"scanned":1,"requeued":1,"held":[]}
exit: 0
```

Git is real: the remote caught-up commit has the original member commit and latest main commit as parents, and retains both sides' files. The member checkout stays clean at its original commit. GitHub responses are simulated; no live request was requeued for this proof. Already queued requests are left alone; changed, conflicting, dirty, refused, protected, policy-off and closed work is held or skipped without another push or enqueue.

Neighbor check: `node --test test/member-autoland.test.js test/member-autoland-map-clash.test.js test/member-refused-no-pr.test.js test/engine-autoland-validation.test.js`

Exit: 0. Exact summary: tests 37, pass 37, fail 0.

`git diff --check`: exit 0, no output.

Proof was moved to review with `atris task ready AAM-1 --verify "node --test test/autoland-requeue-dropped.test.js"`, exit 0; that gate reran the frozen check.

Progress: one recovery path implemented; one dropped handoff caught up and requeued in the real CLI fixture.

Only handoffs saved after this change are recoverable automatically. The original checkout and review must remain available. Recovery does not bypass GitHub checks or reopen closed requests.

The active parent process owns the mission lock, so attach-task returned exit 3. A dedicated local task records ownership and proof; the parent harness remains responsible for the existing mission's final verify and completion. Brain activation and compile returned plan-only, exit 2; their adapter rewrite was left out of this bounded change.

Reference: [GitHub CLI merge behavior](https://cli.github.com/manual/gh_pr_merge) documents auto-merge, queue behavior and matching the head commit.

next_push: Add retry backoff for repeatedly dropped handoffs so persistent check failures do not monopolize recovery.
layer: behaviors
