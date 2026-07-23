# npm takedown — ready to fire (2026-07-23 night)

## What leaked
Versions **3.30.2 – 3.30.8 and 3.30.12** of the `atris` npm package include
private investor material under `decks/`:

- `atris-seed-pitch-v3` through `v7` (+ v4 skeleton)
- `mark-pincus-narrative.json`, `mark-pincus-sourcery.json`
- `yash-applied-compute-detailed/generalist/narrative.json`

Also internal `atris/learnings.jsonl` + team MEMBER.md files — but those are
deliberately whitelisted in `package.json` `files` and still ship in 3.37.1,
so they are product content, not the leak. **No live credentials in any
tarball** (scanned all 18 versions since 3.30.0; only test fixtures matched).

Versions 3.30.0, 3.30.1, and 3.31.0+ are clean of investor decks.

## Morning steps (5 min)
1. `npm login` (browser + OTP — the stale token in ~/.npmrc 401s).
2. Run:
   ```bash
   for v in 3.30.2 3.30.3 3.30.4 3.30.5 3.30.6 3.30.7 3.30.8 3.30.12; do
     npm unpublish atris@$v
   done
   npm view atris versions   # confirm gone
   ```
3. If any version refuses (past the 72h window npm sometimes enforces),
   paste the ticket below at https://www.npmjs.com/support.

## Support ticket draft
> Subject: Request removal of package versions containing private business documents
>
> Package: atris (I am the owner/maintainer, npm user: <your username>)
> Versions: 3.30.2, 3.30.3, 3.30.4, 3.30.5, 3.30.6, 3.30.7, 3.30.8, 3.30.12
>
> These versions were published with confidential business documents
> accidentally included in the tarball (private investor presentation files
> under `decks/`). No credentials or user data are involved; this is
> confidential business material that should not be public. I have attempted
> `npm unpublish` for these versions; please remove any that the unpublish
> policy blocked, including from replicas/mirrors where possible.
>
> Current versions (3.31.0+) do not contain these files. Happy to verify
> ownership however you need.

## Then close the loop
```bash
cd ~/arena/atris-cli && atris close done close-unpublish-npm-3-30-2-through-3-30-12-and-file-th-042628e --why "versions unpublished / ticket filed"
```
