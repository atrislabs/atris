# For you

## Decide: owner-name test fails inside a repo that sets its own Git name
- found: the sealed flights owner-name test fails on master, on pull request 1184, and on its fix branch alike. It reads the owner's name from whatever folder it runs in, and this checkout's own Git settings name the owner "T", which hides the test's temporary home name.
- proof: `git config --show-scope user.name` in the repo prints `local T`; the same test run from a folder outside any repo passes 2 of 2, exit 0; run inside the repo, 1 of 2, exit 1.
- not blocking: 1184 and the every-lock fix do not touch this; it fails the same without them.
- options: (a) the test runs its owner lookup from its temporary home folder, a one-line test change; (b) owner lookup stops reading a repo's own Git name and uses only the home one, a product change.
- why a card: the test covers the sealed engine environment, a protected surface, so it is not self-landed.
- reply: a / b / leave


## Keep shared Git files for surviving linked folders
- decision: hold the proposed fleet cleanup change until it retains shared storage used by any surviving registered copy.
- evidence: real combined-repair cleanup removed the shared store while its idle outside copy survived; that copy's Git status exited 128. The required folder checks still passed, exit 0.
- detail: atris/receipts/2026-10-14-guard-branch-overlap.md, combined repair still breaks an idle linked copy.
- safeguard: enumerate registered copies before removing a store, preserve dependencies, and prove the idle outside-copy case.

## Clear 588 leftover cleanup proof fixtures
- decision: approve or decline deleting the leftover fixture folders that the work-folder cleanup proofs left in the temporary directory before they began cleaning up after themselves.
- evidence: node scripts/preview-proof-fixtures.js --hours 0 lists 588 folders, 38.5 MB, all from today's proof runs, oldest about 7 hours; exit 0, nothing deleted. Passing runs now leave none.
- detail: atris/receipts/2026-10-14-proof-fixture-preview.md
- safeguard: the list matches exact fixture names only and skips green-landing scratch copies, which production keeps on purpose when they hold Git locks.
- reply: clear / keep
