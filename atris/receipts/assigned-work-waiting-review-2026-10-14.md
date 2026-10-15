# Explain waiting work without changing who can run it

## Verdict

Proceed-with-changes on the proposed next step: explain why a member's job is
waiting when its required check is missing or cannot run.

The single risk is attributing another member's work to the idle member.
`skipReason` checks for a missing check before checking the job type
(`lib/member-task-pick.js:69`). A review member asking about a build job with
no check therefore gets `no_check`, not `other_job`. Reusing that reason alone
would produce a plausible but false explanation.

Before building, restrict explanations to work belonging to that member under
the actual checkout's ownership and job rules. Then reuse the existing hold
decisions, including human decisions, protected work, and existing claims.
Keep selection and claiming unchanged. A reporting function must never claim,
release, edit, or manufacture a check. A database read failure must remain a
read failure rather than become a missing-check explanation.

Require a real CLI regression with two members: only one has an unchecked job.
The other must not be told that job is waiting for its check. Also cover a
prose check and a protected job, and assert all rows remain unchanged.

Hand back to the implementation owner. This is advice, not approval to merge.

## Plan boundary and evidence

```text
member's eligible work -> existing hold decisions -> plain explanation
                     -> existing selection and claiming stay unchanged
```

This follows the supplied member memory's next push, not a review of a finished
diff. The supplied memory names `test/task-owner-pick.test.js`, which is absent
in this checkout. Here `fittingTasks` filters by job and holds, without an
assignment filter. Do not claim the supplied assignment fix is present here.

Current routes: `lib/member-task-pick.js:62` reads checks;
`lib/member-task-pick.js:82` filters candidates;
`commands/member.js:10549` reads or claims work;
`commands/member.js:10696` reports the generic idle reason.

## Real-surface proof

Ran the local CLI, not the installed CLI, with two real SQLite rows in a fresh
temporary workspace and a copy of this checkout's architect member definition:
one review job without a check, one with the prose check `looks good to a reader`.
The fixture invoked the following command through `spawnSync(process.execPath,
...)`, with `ATRIS_TASKS_DB` and `ATRIS_HOME` pointing inside that temporary
workspace:

```sh
node /Users/keshavrao/arena/.agent-worktrees/atris-cli/architect-next-step-toward-improve-the-system-20261015-030116/bin/atris.js member go architect --needs-check --dry-run --json
```

Actual output:

```text
selection reason: no_check
selection reason: check_not_runnable
{
  "ok": true,
  "action": "member_go",
  "mode": "idle",
  "member": "architect",
  "reason": "no task with a check"
}
cli exit: 75
both jobs remain open; no member was launched
```

The fixture asserted exit 75, the JSON reason, and both rows still open. The
fixture itself exited 0. It removed only its own generated temporary workspace.
This proves the current generic explanation and hold behavior, not the proposed
wording or assignment behavior.

The attribution failure was also reproduced directly (exit 0, output
`no_check`) with:

```sh
node -e "const p=require('./lib/member-task-pick'); console.log(p.skipReason({status:'open',title:'Build the upload retry',metadata:{}},'review',{member:'architect',requireCheck:true}));"
```

Reviewer rerun: `npm run test:fast`.

Brain activation and compilation were attempted as instructed. Both returned
exit 2 with `Plan only. Would write:` and requested `--yes`; no generated policy
or brain files were written. Several boot-only brain/wiki files are absent in
this checkout. That does not prevent this read-only plan assessment.

## Scope and rollback

Documentation only: this receipt, the architect's daily log, and navigation in
`atris/MAP.md` and `atris/refs/MAP-NOTES.md`. No runtime, member instructions,
mission configuration, or dependencies changed. Revert this documentation
commit to undo it.

Progress: one advisory verdict, one named failure mode, two real waiting-job
cases reproduced. Implementation remains for a later increment.

## Frozen verification result

`npm run test:fast` ran once, with stdout and stderr captured directly to
`/tmp/architect-waiting-review-test-fast.log`, exit 1. No output filter replaced
the command's exit status.

```text
ℹ tests 1882
ℹ suites 22
ℹ pass 1877
ℹ fail 5
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 55955.821959
```

Three failures in `test/lesson-gate.test.js` invoked real `codex exec` in a
non-trusted temporary directory instead of reaching the expected lesson error.
Two failures in `test/runner-command.test.js` expected Claude flags but received
`codex exec "$(cat /tmp/p.tmp)"`. This is evidence of runtime selection affecting
the checks, not proof of its root cause. No runtime or tests were edited here.

Stop reason: the frozen verification failed. The advisory artifact is saved;
the mission and task must not be marked complete or proof-ready. Repairing
those tests would be a second slice, outside this architect review.

next_push: isolate default engine selection in lesson-gate and runner-command tests so the frozen fast suite runs without depending on the installed roster.

layer: beliefs
