# Inactive push deletion pause

This is a local, unreviewed candidate based on CLI PR #1733. Do not enable,
push, or deploy it without review. A local process can recreate a missing path
after the push planner checks it and before the remote DELETE. A second check
does not coordinate that writer, and a writer can run between the check and the
request. The existing independent proof demonstrates this race using the real
push handler, a separate Node process, a temporary workspace, deterministic
interposition, and a mocked API; it does not establish live frequency.

This candidate refuses any real push whose plan contains remote deletions,
including with `--force --delete --delete-all --yes`, before uploads and
deletes. Dry-run remains available and labels paths as possible deletions,
not a safe deletion list. A push with no planned deletion retains its previous
behavior. The change intentionally disables legitimate cloud cleanup and can
increase retained storage. Existing older or already-running binaries, other
remote deletion APIs, concurrent cloud changes and paths hidden from the plan
remain outside its protection. It does not make pushes atomic or coordinate
local writers. No production data or external API was touched.

Verification in this isolated checkout:

```
node --test test/push-delete-paused.test.js test/push*.test.js test/manifest.test.js
```

42 tests passed. The two new cases run the actual push handler with a mocked
API, force a separate process to create the path just after an ENOENT result,
and verify that apply sends no upload or delete, does not change the saved
manifest, preserves that local file, and that dry-run makes the limitation
clear. This interposition is a deterministic model, not a live incident.
