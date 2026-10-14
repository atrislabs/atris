# Hourly replacement cleanup summary

Hourly cleanup now explains younger replacements left alone, verified with a failing-first regression, a real owned ssh-agent, and all 138 required checks passing.

Files: commands/autoland.js, test/engine-resource.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/executor/logs/2026-10-14.md, this receipt.

## Proof

- Before edit: `node --test --test-name-pattern='hourly cleanup summary names younger' test/engine-resource.test.js`, exit 1. Actual summary omitted the younger replacement reason.
- Required check: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`, exit 0. Output: tests 138, pass 138, fail 0, skipped 0.
- Real surface: `node` heredoc invoked exported runSshAgentSweep and sshAgentSweepNote against a real ssh-agent started with `/usr/bin/ssh-agent -s -a <temporary socket>`. Two staged process ages, 3600 then 900 seconds, reproduced replacement. The production stop path used real signals; only the owned agent was eligible. `/usr/bin/ssh-add -l` checked the preserved socket. Exit 0.

```text
hourly cleanup, left 1 younger replacement ssh-agent alone
replacement socket still answers: The agent has no identities.
```

- Real CLI coverage in the required check: `node bin/atris.js engine sweep --apply` ran in an isolated temporary folder with owned agents and staged ages, exit 0. Output: `1 skipped because a younger ssh-agent now has the same process number`.
- `git diff --check`, exit 0, no output.
- Independent cross-model review found no issues; focused regression rerun exited 0.

## Limits

Age readings are staged to reproduce replacement safely. Equal-age reuse and replacement after the final scan remain outside the existing protection. The safety decision itself was unchanged.

Mission attachment returned lock busy, so a separate claimed task records this slice. Brain activation and compile both returned plan-only exit 2 and would rewrite unrelated adapters; those changes were left out of this bounded slice.

next_push: Include failed agent-stop attempts in the hourly cleanup summary so permissions failures cannot look quiet.
layer: capabilities
