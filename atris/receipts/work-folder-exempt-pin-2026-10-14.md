# Exempt removals are pinned to their delete count

Each of the four removals the scan deliberately exempts now records how many deletes its function holds today. If someone adds or removes a delete in an exempt function, the scan fails until a person reviews it and updates the count. Before, an exemption covered a whole function by name, so a new delete of a real work folder added there passed silently.

## Exemption review

The review sandbox setup exemption still holds. Its failure cleanup deletes only folders the same call created moments earlier in a fresh temp folder that nothing else points at, so any lock there is stale. Setup has no early return that skips cleanup, and the seed folder is removed on success too. That gives six deletes in the function, now pinned. The other three exemptions are pinned at one delete each.

## Proof

Added a seventh delete of a work-folder path inside the sandbox setup cleanup, ran the scan, then restored the file from a backup:

- Old test: exit 0. The added delete passed silently.
- New test: exit 1, `an exempt function gained or lost a delete; review it, then update its count`, `lib/fleet.js:prepareReviewSandbox (expected 6, found 7)`.
- `lib/fleet.js` diff after restore: empty.

`node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`: exit 0, 24 passed, 0 failed.

`node atris/receipts/work-folder-scan-probe.js --require-protection`: review gaps 0.

`atris slop detect` on the test and map notes: clean. `atris doc-health --fix-refs`: no refs moved.

## Found along the way

The scan's recursive-delete pattern stops at the first closing parenthesis. A delete whose path comes from a nested call, such as a path join, hides its recursive option from the scan. A first mutation using a path join went unseen entirely. Three real deletes have this shape, in pulse, fleet, and site deploy. None is in a function that handles work folders, but the scan cannot see the shape at all.

next_push: let the scan read a recursive delete whose path is built by a nested call, with a probe case for it and a before-and-after count of real sites.

layer: capabilities
