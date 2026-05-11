# Start Here - Validator

1. Run `node bin/atris.js task list --json` and identify the highest-risk claimed or recently completed task.
2. Read the task proof, touched files, `atris/lessons.md`, and any verifier named in the task.
3. Run the verifier plus the narrowest relevant regression test; broaden to `npm test` when shared behavior changed.
4. Return `SIGNOFF` or `REJECT` with residual risk, proof, and the next verifier-backed move.
