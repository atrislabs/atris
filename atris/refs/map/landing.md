# Landing and worktrees

Autoland and its hourly pass, the landing contract, member worktrees and merge queues. Exact `file:line` refs and search shortcuts. Back to [MAP-NOTES.md](../MAP-NOTES.md).

## Search shortcuts: Modular commands

```bash
rg "worktreeCommand|startWorktree|shipWorktree|runShipHealthCheck|cleanupWorktrees|pruneGeneratedWorktreeCaches|parseWorktrees|swarloClaim" commands/worktree.js test/worktree-ship-health.test.js  # Member-scoped isolated Git worktrees with cleanup-before-create, live-process protection, retained branches, ignored build-cache pruning, optional Swarlo claim, guarded ship flow, and a non-blocking post-merge experiment health check
rg "requireAccountBound|refuseAccountGlobal|ACCOUNT_GLOBAL_MESSAGE|isBoundBusinessWorkspace|join --help|friends --help|inbox --help|signup help|avail --help" lib/account-bound.js bin/atris.js commands/social.js commands/signup.js commands/avail.js test/dogfood-pass3-27-28.test.js test/dogfood-p0-safety.test.js test/signup.test.js # Unbound folders refuse account-global inbox/gmail/slack/errors; bare atris slack and atris gmail (including slack send/dm/channels/messages/search and gmail connect/send/voice) refuse the same way even with --account (no send/dm/channels, inbox/read/archive listing, OAuth/link flow, mailbox lookup, or Slack network); slack/gmail --help still print usage and do not hit the network; join/friends/inbox/signup/avail help prints usage and does not hit the network
- Help-before-network: `commands/social.js:173` friends, `commands/social.js:391` join, `commands/social.js:571` friendsCommand, `commands/social.js:581` inboxCommand, `commands/signup.js:53` signup help, `commands/avail.js:385` avail help (before the `--` show path). Regression: `test/dogfood-p0-safety.test.js` (`29:` `31:`) and `test/signup.test.js`.
```

## Feature: Autoland (`atris autoland`)

**Purpose:** The owner approves the policy once; certified work lands itself with receipts. Money, deploys, security, customer, and outward lanes always wait for the human.

- **Implementation:** `commands/autoland.js` (status/on/off/tick/digest) + `lib/autoland.js` (policy, heartbeat cron, digest/alarm composition)

- **Daily experiment hook:** `commands/autoland.js:134` (`runOwnCli` resolves the local CLI), `commands/autoland.js:1221` (`autoland tick` daily experiment block), `commands/autoland.js:641` (`daily_experiment` policy gate), `commands/autoland.js:1224` (`experiments daily --json`)

- **Policy file:** `.atris/policy/autoland.json`; state (alarm dedupe, digest date): `.atris/state/autoland.json`

- **Heartbeat:** hourly labeled cron (`ATRIS_AUTOLAND_<project>`) running `atris autoland tick`: land eligible -> alarm anything waiting on a human past 24h -> daily iMessage digest

- **CLI voice:** autoland status, protected-lane reasons, on/off guidance, and help use lowercase ASCII punctuation; help presents fast and focused checks separately because strict verify rejects compound shell commands.

- **Status latency:** status reads the last heartbeat install result from policy and never invokes `crontab`; on/off retain the 10s mutation timeout and persist their result, while legacy policy reports an honest unknown with a repair command. Queue status evaluates eligibility without executing recorded verifiers, labels candidates as pending heartbeat recheck, and leaves execution to `autoland tick`. `test/autoland.test.js` covers both stalls

- **Heartbeat verifier reuse:** `autoland tick` asks one `task auto-accept-certified --certify-first` process to certify and land, so a verifier result cached by exact command plus workspace spans both phases. The cache dies with the heartbeat, each task still receives its own accept/revise decision, and counting regressions in `test/autoland.test.js` prove one execution across certification, eligibility, and landing for both passing and failing checks

- **Exact sent surface:** every successful heartbeat writes `atris/runs/autoland-tick-<time>.json`; when a live landing message is attempted, that durable receipt stores its exact body as `live_update_text` beside `live_update_sent`, so the next linguist audit reads what the operator received instead of reconstructing newer code. The regression deliberately sends the daily digest in the same tick and tracks both deliveries independently, preventing the digest from becoming a clock-dependent false comparison target. Regression: `test/autoland.test.js` (`live update receipt keeps the exact sent text...`)

- **Proof-ready digest action:** `digestNextMoves()` preserves each move kind, short label, and recorded mission owner; a `mission_ready` row renders one identifiable human review action without truncating the objective or substituting a title-based owner guess. Regression: `test/autoland.test.js` (`digest and alarm compose in plain language`)

- **Human mission labels:** proof-ready digest actions strip leading internal queue ordinals such as `#13` from short mission labels while preserving the readable identity. Regression: `test/autoland.test.js` (`digest and alarm compose in plain language`)

- **Complete mission names:** when a proof-ready objective begins with a descriptive colon-delimited clause under the digest budget, the review action uses that clause instead of a clipped label; five-word headings such as `new ideas from existing primitives` use the cleaned first concrete clause after the colon; long unstructured objectives retain the safe label fallback. Regression: `test/autoland.test.js` (`digest and alarm compose in plain language`)

- **Ready-before-title gate:** `digestNextMoves()` sends `mission_ready` cards directly to their dedicated review-action renderer; the unexplained count excludes explainable overflow instead of calling hidden ready work incoherent. Regression: `test/autoland.test.js` (`digest next moves render proof-ready missions...`)

- **Full-budget review timing:** `digestNextMoves()` withholds proof review for a spend-full-budget mission until its promised time has elapsed, so the digest cannot ask a human to end a run early. Regression: `test/autoland.test.js` (`digest next moves render proof-ready missions only after promised time is used`)

- **Protected review count:** daily and on-demand digests include pending protected-lane Review rows before agent certification and de-duplicate certified human waits, so their approval line agrees with `atris autoland`. Regression: `test/autoland.test.js` (`digest reports protected reviews before certification`).

- **Protected review wording:** autoland status calls protected rows reviews that need a human decision, rather than claiming one-pass work is already approval-ready. Regression: `test/autoland.test.js` (`autoland status does not call one-pass protected work approval-ready`).

- **Duplicate-objective review timing:** `digestNextMoves()` also withholds an older proof-ready mission while any same-objective spend-full-budget run still has time remaining, so the digest cannot contradict the live continuation. Regression: `test/autoland.test.js` (`digest next moves withhold duplicate objective review until promised time is used`)

- **Digest agreement:** unexplained summaries choose `itself` for one item and `themselves` for multiple items across landed, review, and next-move branches. Regression: `test/autoland.test.js` (`digest and alarm compose in plain language`)

- **Source-neutral hidden moves:** next-move summaries say a move `needs a clearer next action` instead of guessing that every hidden source is an idea or personifying it as unable to explain itself. Regression: `test/autoland.test.js` (`digest and alarm compose in plain language`)

- **Plain result counts:** digest score and waiting headers say `clear results`, `clear next actions`, and `clear review actions` instead of exposing the internal `explained` gate term; unclear results across members fold into one honest count so a busy day stays readable; the two-check claim remains exclusive to strict autoland. Regression: `test/autoland.test.js` (`digest and alarm compose in plain language`, `digest folds unclear landed results...`)

- **Exact digest window:** the digest header says `last 24 hours`, matching `acceptedInLastDay()`; accepted counts and expanded stories come from task truth instead of the compact eight-done-task projection, story rows share the headline clarity gate, and clear result/title fallbacks fill missing landing stories, so counts and detail agree on a busy day. Regression: `test/autoland.test.js` (`digest and alarm compose in plain language`, `digest acceptance history is not capped...`, `expanded story excludes...`)

- **Contextual digest expansion:** the expanded CLI digest prints unseen results as human bullets without task ids and omits the three clear results shown above, so its `more results` count matches the rows; compact daily and live messages retain the command that opens it. Regression: `test/autoland.test.js` (`expanded digest points to the full story below...`, `digest acceptance history is not capped...`)

- **Honest next-move state:** unclear queued moves stay hidden until their owners write clear actions; mission reviews keep the first complete objective clause instead of a vague numbered label; the digest does not send operators to `atris now`, which cannot reveal hidden work. Regression: `test/autoland.test.js` (`digest and alarm compose in plain language`)

- **Scoped waiting state:** digest waiting counts explicitly cover task approvals, so an empty task queue cannot contradict mission proof reviews shown below. Regression: `test/autoland.test.js` (`digest and alarm compose in plain language`)

- **Digest heartbeat state:** tick receipts carry explicit `digest_due`; the human summary says `sent`, `saved`, or `not due`, so a due report without a configured phone is never reported as if it did not run. Unit and real heartbeat regressions: `test/autoland.test.js` (`heartbeat digest status distinguishes...`, `due digest without a phone...`)

- **Actionable stale-work warning:** landing-sweep digest lines agree with singular/plural counts, name the oldest branch before its age, and point to `atris land` for inspection. Regression: `test/autoland.test.js` (`landing sweep escalates 48h-stale active work...`)

- **Freshness consistency:** the `in the air` headline consumes `landingSweep.stale_count` before saying `all fresh`, so it cannot contradict the detailed 48-hour stale-work warning below it. Regression: `test/autoland.test.js` (`landing sweep escalates 48h-stale active work...`)

- **Historical landing cleanup:** the expanded digest story normalizes the previously accepted `as exists and not empty` fragment into a complete saved-file sentence before printing. Regression: `test/autoland.test.js` (`historical digest landing repairs...`)

- **Action-plus-why boundary:** `operatorReady()` treats audience words such as `users` and `operators` as subjects, not consequences; reports must name a real outcome such as saved time, reduced risk, prevented failure, or increased trust. The result gate accepts complete relative endings such as `fresh enough to act on` while still rejecting a bare dangling `on`. Regression: `test/autoland.test.js` (`operatorReady: a queue sentence earns its digest surface with a why...`, `result gate accepts a complete act-on phrase...`)

- **Consequence-preserving digest:** when shortening the preferred result removes its outcome and makes the line fail `operatorReady()`, `digestLine()` falls back to the complete actionable landing sentence instead of hiding explained work. Regression: `test/autoland.test.js` (`digest falls back to the complete landing...`)

- **Regression:** `test/autoland.test.js` (compose, dedupe, policy gate, cited suite-green claims, live e2e land + denied lane, off no-op); `test/status-gate-parity.test.js` keeps every statically knowable status promise aligned with the landing gate

- **Value:** the human approves policy, not items; nothing certified waits silently again

**Search:** `rg "autolandCommand|liveAcceptAuthorization|composeDigest" commands/autoland.js lib/autoland.js commands/task.js`

## Feature: Landing Contract (`atris land`)

**Purpose:** Work is merged or reaped, never limbo: the board shows every unlanded branch/worktree; `--reap` salvages then deletes anything landed or past TTL

- **Implementation:** `commands/land.js` (collectBoard, printBoard, reap, landSummary, printEmptyLand); the board orders overdue, active, then landed residue, labels aging active rows `stale`, and keeps fresh rows `in the air`; counts separate tracked, stale, overdue, and landed work
- **Empty / unborn repo:** `printEmptyLand` (`commands/land.js`) prints one human sentence on stdout and exits 2; `--json` is a compact refuse receipt; never a stack or wizard. `landSummary` returns null when there is no git history.
- **Router:** `bin/atris.js` (`command === 'land'` dispatch); leftover throws print one line and exit 2
- **Boot visibility:** `bin/atris.js` boot status (`landing` row via `landSummary`)
- **Doctrine:** `atris.md` operating rules ("land or reap"), `AGENTS.md` agent contract table
- **Salvage:** bundles + dirty patches under `.atris/salvage/<date>/`: a reap never loses work
- **Live runs and removal log:** `commands/land.js:571` (`reap`) and `lib/worktree-core.js:1671` (`cleanupWorktrees`) keep any folder a process is working in (`lib/worktree-core.js:1077`); if the process scan fails (`lib/worktree-core.js:1035` returns null) every folder is kept as `process_scan_failed`. Reap checks again right before removal and even under `--force`; each removal appends who (`by`: `atris land --reap`, `atris autoland`, `atris worktree start`, `atris worktree cleanup`), why (`commands/land.js:555` `reapReason`, or the cleanup reason), path, branch, and pid to the main checkout's `.atris/state/worktree_removals.jsonl` (`lib/worktree-core.js:1095`). Regression: `test/worktree-removal-guard.test.js`, `test/worktree-cleanup-keeps-busy.test.js`
- **Live runs and removal log:** `commands/land.js:571` (`reap`) and `lib/worktree-core.js:1671` (`cleanupWorktrees`) keep any folder a process is working in or runs a script from (`lib/worktree-core.js:1085`), reap checks again right before removal and even under `--force`; each removal appends who (`by`: `atris land --reap`, `atris autoland`, `atris worktree start`, `atris worktree cleanup`), why (`commands/land.js:555` `reapReason`, or the cleanup reason), path, branch, and pid to the main checkout's `.atris/state/worktree_removals.jsonl` (`lib/worktree-core.js:1095`). Regression: `test/worktree-removal-guard.test.js`, `test/worktree-cleanup-keeps-script-folder.test.js`
- **Copies clean themselves up:** the guarantee is that a copy is removed only when every byte in it is proven saved or proven throwaway; anything unusual keeps it for a person. `lib/worktree-core.js:1460` (`finishShippedCopy`) runs at the end of `atris worktree ship`; `lib/worktree-core.js:1416` (`removeShippedCopyNow`) steps out to the main checkout and removes the copy once its last commit is merged or on origin, it is clean, and no program at all works in it; `--keep-copy` or `ATRIS_WORKTREE_KEEP_AFTER_SHIP=1` keeps it. A busy copy goes to the delayed remover: `reapShippedCopy` for merged work, `lib/worktree-core.js:1477` (`reapPushedCopy`) for pushed work. `lib/worktree-core.js:1572` (`rescueAbandonedCopy`) is the sweep's rescue, opt-in with `--rescue` and never run by the timer (the default sweep only reports stale dirty copies): past `--rescue-after-days` (default 7) it commits the staged version, then the version on disk (`lib/worktree-core.js:1502` `snapshotTrees`), onto a brand-new `atris-rescue/<copy>-<time>` branch created with a compare-and-swap, pushes it, confirms origin has it, rechecks, then removes; it never moves an existing branch. `lib/worktree-core.js:1246` (`ignoredFilesToKeep`) treats installs and caches as throwaway only beside the package file that makes them; `lib/worktree-core.js:1282` (`unprovableReason`) keeps copies with hidden index flags, conflicts, sparse checkouts, nested repositories other than a clean submodule at a pushed commit (checked recursively), and content filters on every removal path plus line-ending conversion for dirty copies (`byteChangingSetting`). Removals and rescues land in `.atris/state/worktree_removals.jsonl`. Regression: `test/worktree-self-cleanup.test.js` (real git, bare remote, real process scan).
- **Green landing:** `lib/land-green.js` (landStaleGreenBranches, landOneBranch, failingLines, flagWhat, summaryLine); `atris land --auto [--dry-run] [--verify "<cmd>"] [--limit n]` and step 3b2 of the autoland tick (`commands/autoland.js` runTickBody, receipt.green_landing) take one stale active branch per tick, hold it with a named reason on merge conflict / dirty checkout / protected surface, verify the merged state in a scratch worktree (default `npm test`), fast-forward base and push when green, and open a `close` flag naming the failing tests when red; policy `green_landing:false` turns it off, `green_landing_limit` raises the cap
- **Regression:** `test/land-green.test.js` (green lands + red flags, conflict / dirty / fresh holds, per-tick cap, dry run, failing-line lift); `test/land.test.js` (board classification, empty folder, init-with-no-commits, category-specific cleanup guidance, reap, dry-run, worktree patch salvage); `test/dogfood-p1.test.js` (`land in empty repo prints one-line error without stack`)
- **Value:** hundreds of agents can fan out without work silently dying in branches nobody merges

**Search:** `rg "collectBoard|landCommand|printEmptyLand|hasCommits|no commits|landStaleGreenBranches|green_landing" commands/land.js lib/land-green.js commands/autoland.js bin/atris.js test/land.test.js test/land-green.test.js test/dogfood-p1.test.js`

## Feature: Member Worktrees (`atris worktree`)

**Purpose:** Keep parallel members, subagents, and agents out of one dirty checkout by creating identity-scoped Git worktrees and branches, with optional Swarlo claim wiring.

- **Entry point:** `bin/atris.js` dispatch for `worktree`
- **Handler:** `commands/worktree.js`
- **Start recovery:** `lib/worktree-core.js:51` (`runGit`) retries configuration-lock writes up to three attempts; `lib/worktree-core.js:549` (`createAgentWorktree`) retries locked starts, removes only its unchanged new ref or clean checkout after failure, and preserves existing branches and other writers' locks. Real Git regressions: `test/worktree-start-retry.test.js`.
- **Retry keeps work:** `lib/worktree-core.js:178` (`lastRunBranch`) looks only at the newest earlier run of the same member and job and resumes it only if its commits never landed; `createAgentWorktree` starts the retry from that branch, still ships to the mainline, and records `resumed_from` in the sidecar. When that branch no longer merges cleanly with the mainline (`lib/worktree-core.js:198` `conflictsWithBase`), the retry starts fresh, prints a note naming the branch, and records `skipped_resume`. Regression: `test/member-retry-keeps-work.test.js`.
- **Core flows:** `guide` prints the agent recipe; `start --member <slug> --task "<task>" --claim` and `start --agent <slug> --task "<task>"` first reap completed checkout debt, then create sibling `.agent-worktrees/<repo>/...` checkouts from the remote mainline so a launcher feature branch cannot leak another session's commits (`--target` deliberately overrides both checkout and ship base); `ship --message "<commit>" --verify "<cmd>" [--merge]` commits, snapshots checkout status around verification, names and blocks new verifier-created dirt, merge-checks, pushes, opens a PR, and optionally merges; `cleanup --apply` removes old merged or completed output-only checkouts while preserving branches, skips live and real dirty work, and prunes only Git-ignored build caches from old kept worktrees; `status` lists dirty counts; `guard` blocks primary/dirty checkout use unless explicitly allowed; `prune --apply` removes stale missing registrations.
- **Value:** Ties member/agent identity, branch, isolated filesystem state, staging area, live Swarlo claim, verification, push, PR, and merge together for multi-agent work.

**Search:** `rg "worktreeCommand|startWorktree|shipWorktree|cleanupWorktrees|pruneGeneratedWorktreeCaches|parseWorktrees|swarloClaim" commands/worktree.js lib/worktree-core.js test/commands-1.test.js test/worktree-cleanup-retention.test.js`

## Concern: Output Quality Policies

- `lib/fleet.js` `releaseUnstartedDispatchClaim` / `runDispatchFlight` claim-then-prepare: a successful `task claim` that then refuses at worktree start, sandbox prep, or any error before engine spawn calls `task release --as fleet-<engine>` and ends the pause detail with `claim released, safe to retry`. Once the engine process starts, the claim stays held. `commands/worktree.js` `collidingFlights` refuses only the same task slug, not a shared word on an unrelated flight. Regressions: `test/engine-dispatch.test.js`, `test/worktree-start-duplicate-guard.test.js`.

- `commands/sign.js` (`signCommand`, `installSignHook` `:26-40`): co-author trailer on every commit in an atris workspace: prepare-commit-msg hook appends `Co-authored-by: Atris <299057014+atris-builder[bot]@users.noreply.github.com>` (the atrislabs `atris-builder` GitHub App, so the avatar renders) when `atris/` exists (skips merge/squash, dedupes on `^co-authored-by: atris`); `atris sign` / `sign off` / `sign status`; auto-installed by `atris init`, marked-block removal only; this repo gets it via `scripts/prepare-commit-msg` + npm prepare

## Engine dispatch default branch and refusals

- `lib/worktree-core.js:31` preserves custom SSH commands and Git's own config/program precedence; only default SSH gets batch/connect guards. `lib/worktree-core.js:51` bounds push to five minutes so required local hooks can finish; fetch and lookup retain 30 seconds unless a caller sets a shorter limit, with SIGKILL. Only network calls run the SSH config probe. `lib/worktree-core.js:45` (`gitFailureDetail`) keeps both stdout and stderr when checks reject a push and names a killed call as `timed out`; `lib/worktree-core.js:549` warns when a new checkout starts from a base its fetch could not refresh. Live default lookup retains its five-second limit and saved-ref fallback. Regressions: `test/engine-dispatch-mainline.test.js`, `test/engine-git-calls.test.js`, `test/worktree-push-hooks.test.js` (real 31-second hook and real rejected push).

- `commands/land.js:39` uses the same default branch for the landing board; `lib/codex-flight.js:79` uses it for the companion build path and preview; `lib/one-lap-validator.js:11` receives the frozen base for its diff instructions.

## preserve source branches for queued merges

`commands/worktree.js:378` reads GitHub merge state before deleting a source branch; pending work omits the completed-ship marker. Regression: `test/worktree-ship-queued-merge.test.js` runs the actual CLI and git remote for pending, closed, unreadable, malformed, and confirmed-merged results.

## Revision reports across out-of-order commit dates

Workspace CLI test runner: `test/helpers/workspace-cli.js:8` keeps positional cwd, raw inherited environment with the update check disabled last, twenty-second limit, implicit streams and original error/result behavior. Doctor, worktree help and wiki startup/tidy cases retain their exact fixtures and real local metadata work. Check: `node --test test/start-here-doctor.test.js test/worktree-ship-help.test.js test/wiki-metabolism-warning.test.js`.
