# Member execution failure and explicit shared checkout

Owned by: backend-feature-owner. Executed by: Codex. Parent owns independent review and landing.

Task MAP-2, internal id `01M1Q17C0MVX5YD18HCVVX5YD1`, is ready for review.

## Change

The cloud proof returned a multiline `ok: false` mission error with process exit 0. The dispatcher previously ignored that JSON and reported completion. `scripts/member-operate.mjs` now reads complete multiline objects, preserves explicit failure across later success payloads, and returns the failure reason and detail with exit 1. Separate stdout/stderr buffers keep their JSON chunks from interleaving.

Explicit `--shared-checkout` now flows through member alive and its cron command, the alive library, and the dispatcher to member run. The default still requests isolation where member run normally does so. No cloud execution, billing, engine choice, publish, or deployment changed here.

## Checks

`node --test test/member-alive.test.js`: exit 0, 10 tests passed, 0 failed.

The real dispatcher reads pretty JSON from a fixture CLI returning exit 0. Checks cover failure details containing braces and quotes, a progress line before failure, a success payload after failure, real member alive CLI argument forwarding, default isolation, installed dispatch, override precedence, and existing wait/dry-run behavior. No model is called.

Removing the failure-status guard and the dispatcher flag forwarding makes `node --test --test-name-pattern='pretty JSON failure|forwards explicit shared' test/member-alive.test.js` exit 1, with all three selected checks failing. Both guards were restored before final verification.

`node --test --test-name-pattern='member alive|member run' test/commands.test.js`: exit 0, 9 tests passed, 0 failed. This includes existing worktree-default and cron behavior.

`git diff --check`: exit 0.

Evidence remains local process-level proof with a controlled final CLI boundary. The parent is separately testing the cloud member.
