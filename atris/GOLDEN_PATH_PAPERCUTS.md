# Golden Path Papercuts

## Open

None in the latest packed pass: `/tmp/atris-golden-zero-hhFUPA`.

## Ready for Human Approval

- **CLI-889** - Landed fresh-init path reaches a starter task but never prints the first mission command.
  - Receipt: `/tmp/atris-golden-landed-picMA5`
  - Fixed receipt: `/tmp/atris-golden-zero-hhFUPA`
  - Repro: clean temp `HOME`, clean detached `origin/master` at `6705da8`, `npm pack`, `npm install -g --prefix <temp> atris-3.35.0.tgz`, new toy repo, then follow printed commands: `atris` -> `atris init` -> `atris "help me choose the first useful step for this project"`.
  - Evidence: the printed path reaches `First task: TOY-1` and `Next: atris task claim TOY-1 --as keshavrao`; no first mission start/tick/complete command appears before an operator invents one.
  - Fixed evidence: `atris init` now prints `Next: atris mission start "Create FIRST_PROOF.md in this project" --owner executor ... --verify "test -f FIRST_PROOF.md"` and `Then: atris "help me choose the first useful step for this project"`. Following the mission prints the verifier tick command, the successful tick prints the exact `atris mission complete ... --proof "<receipt>"` command, and mission complete succeeds.
  - Why it blocks success: the goal requires install -> init -> first mission -> first self-landed task using only CLI prints, but the landed path skips the mission recipe.
  - Done when: the fresh printed path includes a copy-paste first mission recipe or explicitly explains task-first vs mission-first ordering, with packed-install regression.
- **CLI-890** - Starter task claim prints verifier placeholders that can miss autoland, so the first self-landed task stalls.
  - Receipt: `/tmp/atris-golden-landed-picMA5`
  - Fixed receipt: `/tmp/atris-golden-zero-hhFUPA`
  - Repro: follow the landed printed path through `TOY-1`, make `FIRST_PROOF.md`, then run the printed ready shape with `--verify "test -f FIRST_PROOF.md"` and the printed `atris autoland tick`.
  - Evidence: `07-task-ready` verifies successfully, then warns the verifier is outside the auto-certify allowlist; `08-autoland` lands 0. Control: `TOY-2` with `--verify "git diff --check"` self-lands in `13-control-autoland`, proving the gap is guidance, not autoland.
  - Fixed evidence: claim now prints `atris task ready TOY-1 --verify "git diff --check" --result "<who can do what now and why>"`; following that shape produces the autoland promise, and `atris autoland tick` lands `TOY-1`.
  - Why it blocks success: a zero-knowledge user can follow the printed placeholder honestly and still miss the first self-landed task.
  - Done when: claim or ready guidance gives a self-land-safe verifier path, or ready output does not promise autoland when the verifier cannot be rerun, with regression and packed receipt.

- **CLI-886** - Packed master `atris init` still dead-ends on agent-only MAP bootstrap.
  - Receipt: `/tmp/atris-golden-pack-AMABZ3`
  - Fixed receipt: `/tmp/atris-golden-landed-picMA5`
  - Repro: clean temp `HOME`, `npm pack` from `origin/master`, `npm install -g --prefix <temp> atris-3.35.0.tgz`, new toy repo, then follow printed commands: `atris` -> `atris init`.
  - Evidence: `atris` in the toy repo prints `atris init`, but `atris init` ends with `BOOTSTRAP REQUIRED` and asks an agent to read `atris/atris.md` and generate a complete `atris/MAP.md`, then rerun `atris`.
  - Fixed evidence: landed rerun prints `context gatherer skipped (non-interactive).` and `Next: atris "help me choose the first useful step for this project"` instead of MAP bootstrap.
  - Why it blocks success: a zero-knowledge consumer cannot reach first mission or first self-landed task using only CLI-printed instructions; the path requires insider/agent-only MAP work.
  - Done when: fresh `atris init` ends with one human-runnable next command toward first mission/task, not agent-only MAP homework, and the packed-install walk reaches the next step.
- **CLI-887** - After the first printed task claim, `atris task claim` gives no next command.
  - Receipt: `/tmp/atris-golden-patched-YFTiVo`
  - Fixed receipts: `/tmp/atris-golden-allfix-ms4osp`, `/tmp/atris-golden-landed-picMA5`
  - Repro: patched packed install, follow printed commands through `Next: atris task claim TOY-1 --as keshavrao`.
  - Evidence: claim exits 0 and prints only `claimed TOY-1 as keshavrao`; `atris task show TOY-1` also gives no ready/autoland next command.
  - Fixed evidence: rerun claim output now prints `Next: make the change, then run: atris task ready TOY-1 --verify "<check command>" --result "<who can do what now and why>"` and `Then: atris autoland tick`.
  - Why it blocks success: a zero-knowledge user cannot discover the first self-landed task path from the claim output.
  - Done when: task claim output names the next proof command or points to the zero-human golden path for the claimed task, with regression.
- **CLI-888** - `atris mission start` with a verifier prints a tick command without `--verify`.
  - Receipt: `/tmp/atris-golden-mission-recipe-gccoeg` and `/tmp/atris-golden-mission-verify-MaXieJ`
  - Fixed receipts: `/tmp/atris-golden-allfix-ms4osp`, `/tmp/atris-golden-landed-picMA5`
  - Repro: run `atris mission start "Create the first proof note for this workspace" --owner executor --runner manual --lane workspace --verify "test -f FIRST_PROOF.md" --stop "first proof task landed"`, then follow the printed `Next: atris mission tick <id>`.
  - Evidence: following the printed tick records `How I checked: Tick recorded; no verifier was run` even though the mission has a verifier. Running the unprinted `--verify` path correctly checks `test -f FIRST_PROOF.md`.
  - Fixed evidence: mission start now prints `Next: atris mission tick <id> --verify`; following it runs the verifier and reports `Verifier failed: test -f FIRST_PROOF.md` instead of `no verifier was run`.
  - Why it blocks success: the first mission can record a no-work receipt when the user follows the CLI exactly.
  - Done when: mission start prints the verification-preserving next command when a verifier exists, with regression.
