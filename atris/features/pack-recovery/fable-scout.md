# Historical Fable scoping receipt

Superseded by the approved plan where it proposes prompt-only recovery or changing launcher-lost truth.

Scouting is done and the answer is checked against the actual code. Here is the receipt.

**Where Packs actually run**

The backend only stores and sells Packs. Upload, download, and purchase live in `backend/routers/pack_registry_store_router.py:25`, `backend/services/pack_registry_store_service.py`, and `backend/services/pack_purchase_service.py`, with no run, retry, or result state anywhere in this repo.

The runtime that executes a Pack is the CLI. The run command is `runPack` at `/Users/keshavrao/arena/atris-cli/commands/pack.js:2683`, the local launch is `startPackLocal` at `commands/pack.js:2519`, and the cloud path at `commands/pack.js:2313` just changes directory and hands off to the computer runner.

Run truth lives in receipt files under `~/.atris/runs/packs`. They are created by `beginPackRunReceipt` at `/Users/keshavrao/arena/atris-cli/lib/pack-capabilities.js:367`, appended by `appendReceiptEvent` at `lib/pack-capabilities.js:249`, and summarized by `finalizePackRunReceipt` at `lib/pack-capabilities.js:264`.

**What happens today when a run is interrupted (all observed, not inferred)**

The exit only gets recorded if the launcher survives to run its exit callback (`commands/pack.js:2572`) or a hook fires (`lib/pack-capabilities.js:635`). Kill the launcher abruptly and the receipt says `status: "running"` forever.

Listing runs papers over that read-only: `classifyPackRunLifecycle` at `lib/pack-capabilities.js:326` probes the recorded pid and reports `launcher-lost`, proven by the test at `/Users/keshavrao/arena/atris-cli/test/pack-run.test.js:1011`, which also asserts the stale receipt is never corrected (line 1039).

**The smallest demonstrable bug**

Run a Pack that writes a file, kill it, run it again. The second run builds the identical opening instruction from the entrypoint (`commands/pack.js:2630` and `commands/pack.js:2745`), starts a brand-new receipt (`commands/pack.js:2552`), and never reads any prior receipt, so the agent repeats the completed file write while the old receipt still claims the first run is running. That is exactly the "retry, partial effect" check in BCK-1383 failing on both halves.

A supporting gap makes recovery impossible from today's data: `used` events record only tool name and capability, never the file target (`lib/pack-capabilities.js:636`, and `toolInputsLogged: false` at line 298).

**Bounded packet, three files, all in atris-cli** (a sibling worktree already exists at `/Users/keshavrao/arena/atris-cli/.agent-worktrees/pack-recovery-muse-20260904` with no pack changes yet)

One. `lib/pack-capabilities.js`: in the used/failed hook branch, for file tools also record the target path relative to the pack root (path only, no content; the pre-hook already parses the same input for the root boundary). Add a reconcile helper that, when a recorded-running receipt's launcher pid is provably dead, appends an `interrupted` event and refinalizes so status becomes `interrupted`, keeping the event log append-only.

Two. `commands/pack.js`: in the enforced path of `startPackLocal`, before launching, reconcile any launcher-lost receipt for the same pack root and prepend a short recovery note to the opening instruction naming the file actions the prior run completed, so the agent checks before repeating them. Teach `runsPack` (line 3987) to display the new state.

Three. `test/pack-run.test.js`: seed a receipt with launch plus a used file write and no exit and a dead pid, then run again through the existing injected fake runner and assert the prompt carries the recovery note, the old receipt flips to interrupted, and receipts with a live or unknown pid are left untouched.

**Verification**

The change is Node, so the honest offline check is `node --test` on the three pack test files in atris-cli. The backend venv python at `/Users/keshavrao/arena/atrisos-backend/venv/bin/python` verifies nothing here because no backend Python changes; claiming otherwise would invent a backend runtime that does not exist.

**Limitations, stated plainly**

A crash between the file write and the hook append leaves a real effect with no record, so the recovery note can miss it; this design gives at-least-once effects with best-effort recorded truth, and no exactly-once claim is possible. Legacy packs without declared capabilities produce no receipt at all (`commands/pack.js:2582`), cloud runs produce none either (`commands/pack.js:2313`), and pid reuse can make a dead run look alive, so reconcile must treat alive and unknown as hands-off.

**Branch and state**

This backend worktree is clean on `member/backend-feature-owner-pack-recovery-muse-20260904` per the session snapshot; I made no changes anywhere. One note on process: this session has no shell or file-write tools, so I could not re-run git status or write the plan file the workflow asked for, and this receipt is the deliverable.

`cd /Users/keshavrao/arena/atris-cli && node --test test/pack-run.test.js test/pack-safety.test.js test/pack.test.js`
