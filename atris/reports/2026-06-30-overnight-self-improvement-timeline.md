# Overnight self-improvement timeline

Mission: work overnight and see where we can self improve. goal after goal nonstop 6 hours

Status: running. Human approval and AgentXP are still gated.

## Timeline

1. CLI-658 - stopped completed inbox ideas from reappearing.
   - Built: reviewed or done task titles are suppressed from loop next moves, and pasted task receipt fragments like `title:`, `status:`, and `proof:` are ignored.
   - Meaning: the loop stopped suggesting old completed work as if it were new.
   - Proof: `test/moves.test.js` passed 21/21, `test/loop-front.test.js` passed 21/21, `test/commands.test.js` passed 383/383, and live loop status dropped the stale receipt fragments.

2. CLI-659 - removed vague tick placeholders.
   - Built: generic inbox items like `dogfood tick` and `run one tick` no longer appear as next moves.
   - Meaning: the loop stopped pretending a placeholder was real work.
   - Proof: `test/moves.test.js` passed 22/22, `test/loop-front.test.js` passed 21/21, and live loop status stopped showing `dogfood tick`.

3. CLI-660 - hid internal Mission XP bookkeeping.
   - Built: AgentXP and `Mission XP:` tasks stay in task truth but no longer show up as operator next moves.
   - Meaning: the operator sees product work, not reward plumbing.
   - Proof: `test/moves.test.js` passed 23/23, `test/loop-front.test.js` passed 21/21, and live loop status stopped showing `Mission XP`.

4. CLI-661 - added a next-task seed when only the mission remains.
   - Built: when the ranked list collapses to the active mission only, Atris adds `Create the next proof-backed self-improvement task`.
   - Meaning: the loop no longer dead-ends after cleaning noise.
   - Proof: `test/moves.test.js` passed 24/24, `test/loop-front.test.js` passed 21/21, and live loop status showed the active mission plus the new seed.

5. CLI-662 - made mission run land on the same seed.
   - Built: `atris mission run` now points to `Create the next proof-backed self-improvement task` when no concrete task is queued.
   - Meaning: the command output tells the operator the next useful move instead of saying only `Run the next proof step`.
   - Proof: focused mission landing test passed 2/2, `test/moves.test.js` passed 24/24, `test/loop-front.test.js` passed 21/21, and live `atris mission run` ended with `Next: Create the next proof-backed self-improvement task.`

6. CLI-664 - made the seed specific when evidence exists.
   - Built: the mission-only fallback reads the latest report `Suggested target:` and uses that as the next move.
   - Meaning: the loop can advance from durable proof into a concrete next task instead of showing a generic seed forever.
   - Proof: `test/moves.test.js` passed 25/25, `test/loop-front.test.js` passed 21/21, and the focused mission landing tests passed 2/2.

7. CLI-665 - kept mission-run landing aligned with loop status.
   - Built: mission-run landing now uses the mission-scoped fallback move, whether it is generic or evidence-backed.
   - Meaning: heartbeat receipts and loop status tell the same operator-facing next move.
   - Proof: focused mission landing tests passed 3/3, `test/moves.test.js` passed 25/25, and `test/loop-front.test.js` passed 21/21.

8. CLI-666 - added one-command task materialization.
   - Built: `atris loop create-next` creates and claims the suggested self-improvement task, then refuses duplicates while active work exists.
   - Meaning: the loop seed is no longer just advice; it becomes a real claimed task with one command.
   - Proof: `test/loop-front.test.js` passed 23/23, `test/moves.test.js` passed 25/25, and focused mission landing tests passed 3/3.

9. CLI-667 - added mission-run task materialization.
   - Built: `atris mission run --create-next` can run a heartbeat and create the suggested loop task in the same landing.
   - Meaning: the always-on mission can turn its next move into claimed work without a separate loop command.
   - Proof: focused mission-run tests passed 4/4, `test/loop-front.test.js` passed 23/23, and `test/moves.test.js` passed 25/25.

10. CLI-668 - made duplicate protection visible in the landing.
   - Built: when `atris mission run --create-next` sees active work, the landing now names the exact task to continue instead of falling back to a generic next step.
   - Meaning: the heartbeat can safely avoid duplicate tasks while still telling the operator what to do next.
   - Proof: focused mission-run create-next tests passed 2/2, `git diff --check` passed, and live `atris mission run --create-next` ended with `Next: Continue active task: CLI-668 Show the active task in mission run create-next landing when duplicate protection skips creation.`

11. CLI-669 - made the landing say what changed.
   - Built: `atris mission run --create-next` now uses the `Changed:` line to say whether it created a next task or kept the current active task.
   - Meaning: the operator sees the product result first, not just that a heartbeat ran.
   - Proof: focused mission-run create-next tests passed 2/2, `git diff --check` passed, and live `atris mission run --create-next` ended with `Changed: Kept active task: CLI-669 Make mission run create-next changed line mention the created or continued task instead of only the heartbeat. No duplicate was created.`

12. CLI-670 - saved the landing outcome in the receipt.
   - Built: mission summary receipts now include `result.created_next` and `result.landing` when `atris mission run --create-next` creates or continues work.
   - Meaning: product proof is durable; another agent or UI can read the saved receipt and show the same human landing.
   - Proof: focused mission-run create-next tests passed 2/2, live `atris mission run --create-next` saved receipt `atris/runs/mission-mission-2026-06-30-work-overnight-and-see-where-1858e505-2026-06-30T17-42-46-924Z.json`, and that receipt contains `created_next.reason: active_task` plus the CLI-670 landing text.

13. CLI-671 - added the plain mission timeline.
   - Built: `atris mission timeline <id>` lists saved landing `Changed`, `Next`, and proof receipt lines from mission summary receipts.
   - Meaning: the operator can see the chronological list of what the mission did without opening raw JSON.
   - Proof: focused mission timeline/help tests passed 2/2, and live `atris mission timeline mission-2026-06-30-work-overnight-and-see-where-1858e505 --limit 4` showed CLI-670 and CLI-671 landing items with proof paths.

14. CLI-672 - made the timeline discoverable from every landing.
   - Built: `atris mission run` now prints `Timeline: atris mission timeline <id> --limit 5` after the proof path, and stores that command in the receipt landing.
   - Meaning: the operator no longer has to remember the timeline command after a mission run finishes.
   - Proof: focused mission landing/create-next tests passed 3/3, and live `atris mission run --create-next` landed with the timeline command before `Next:`.

15. CLI-673 - added markdown export for the timeline.
   - Built: `atris mission timeline <id> --write` saves the current landing list as `atris/reports/<mission-id>-timeline.md`.
   - Meaning: the mission can produce a human-readable artifact, not just terminal output or raw run JSON.
   - Proof: focused mission timeline/help tests passed 2/2, live `atris mission timeline ... --write` saved `atris/reports/mission-2026-06-30-work-overnight-and-see-where-1858e505-timeline.md`, and the file lists CLI-670 through CLI-673 with next actions and proof paths.

16. CLI-674 - added the markdown next move.
   - Built: exported mission timeline markdown now ends with a `Next move` section from the latest landing.
   - Meaning: the artifact is not just history; it tells the operator what to do next.
   - Proof: focused mission timeline/help tests passed 2/2, live `atris mission timeline ... --write` saved a markdown file whose tail ends with `## Next move` and the CLI-674 continuation.

17. CLI-675 - added full-history export.
   - Built: `atris mission timeline <id> --all` ignores compact limits so markdown export can include every saved landing item.
   - Meaning: the operator can get a full mission history artifact when the compact terminal list is not enough.
   - Proof: focused mission timeline/help tests passed 2/2, and live `atris mission timeline ... --limit 1 --all --write` wrote a markdown file with CLI-670 through CLI-675 despite the `--limit 1` flag.

18. CLI-676 - added the export command to the landing.
   - Built: `atris mission run` now prints `Export: atris mission timeline <id> --all --write` after the compact timeline command, and stores it in the receipt landing.
   - Meaning: every mission landing now tells the operator how to create the full markdown proof artifact.
   - Proof: focused mission landing/create-next tests passed 3/3, live `atris mission run --create-next` printed the export command, and running that command saved a seven-item markdown timeline through CLI-676.

19. CLI-677 - added prune guidance to the markdown artifact.
   - Built: exported mission timeline markdown now ends with `Keep it concise`, including the dry-run prune command and an explicit apply-only-after-review note.
   - Meaning: the full-history artifact also tells the operator how to keep raw run receipts from bloating the workspace.
   - Proof: focused mission timeline/help tests passed 2/2, live `atris mission timeline ... --all --write` saved an eight-item markdown file, and its tail includes the prune dry-run command.

20. CLI-678 - ran the prune dry-run and recorded the compression summary.
   - Built: no code change; ran `atris mission prune-runs --days 14 --keep-newest 200 --json` and recorded the result in this report plus the exported mission timeline markdown.
   - Meaning: the workspace now has a concrete compression readout before any destructive prune is approved.
   - Proof: dry-run saw 863 run files, 9,392,420 bytes total, 644 referenced files, 692 recent files, and 4 old unreferenced JSON receipts that would prune 27,622 bytes. It deleted 0 files.

21. CLI-679 - made the prune summary automatic in exports.
   - Built: `atris mission timeline <id> --all --write` now runs a fresh prune dry-run and writes the latest summary into the markdown artifact.
   - Meaning: the timeline export no longer depends on a manual report patch; it carries current workspace compression status every time.
   - Proof: focused mission timeline/help tests passed 2/2, live export regenerated `atris/reports/mission-2026-06-30-work-overnight-and-see-where-1858e505-timeline.md`, and its tail shows 867 run files, 9,420,238 bytes, 4 prune candidates, 27,622 bytes, and 0 deletions.

22. CLI-680 - showed the prune summary in terminal output.
   - Built: `atris mission timeline <id> --all --write` now prints a compact `Prune dry-run:` line after `Saved:`.
   - Meaning: the operator does not have to open the markdown file just to see whether pruning would do anything.
   - Proof: focused mission timeline/help tests passed 2/2, live export printed `Prune dry-run: 4 files / 27.0 KB would prune; 0 deleted.`

23. CLI-681 - exposed prune summary for JSON consumers.
   - Built: `atris mission timeline <id> --all --write --json` now includes a compact `prune_summary` object beside the raw prune preview.
   - Meaning: UI surfaces can render the compression status without parsing markdown or the full prune payload.
   - Proof: focused mission timeline/help tests passed 2/2, live JSON export returned `prune_summary.text: Prune dry-run: 4 files / 27.0 KB would prune; 0 deleted.`

24. CLI-682 - added no-write prune preview.
   - Built: `atris mission timeline <id> --prune-preview` now shows the compact prune dry-run summary without saving a markdown artifact.
   - Meaning: operators and UI callers can check compression status without changing files.
   - Proof: focused mission timeline/help tests passed 2/2, live text preview printed `Prune dry-run: 4 files / 27.0 KB would prune; 0 deleted.`, and live JSON preview returned `artifact_path: null` plus compact `prune_summary`.

25. CLI-683 - made prune preview discoverable from every landing.
   - Built: `atris mission run` now prints `Prune preview: atris mission timeline <id> --prune-preview` beside the timeline and export commands, and stores it in the receipt landing.
   - Meaning: after any mission run, the operator sees the safe compression check without opening docs.
   - Proof: focused mission landing/create-next tests passed 3/3, and live mission run printed the prune preview command before `Next:`.

26. CLI-684 - added operator commands to the markdown artifact.
   - Built: exported mission timeline markdown now includes `Operator commands` with Timeline, Export, and Prune preview commands.
   - Meaning: a saved artifact contains the commands needed to inspect, export, or check compression status without returning to the terminal run output.
   - Proof: focused mission timeline/help tests passed 2/2, live markdown export wrote the section, and `rg` found all three commands in the artifact.

27. CLI-685 - moved operator commands to the top of the markdown artifact.
   - Built: the `Operator commands` section now appears immediately after mission status, before the long timeline list.
   - Meaning: an operator opening the artifact sees the useful commands in the first screen.
   - Proof: focused mission timeline/help tests passed 2/2, live markdown export put `Operator commands` on line 6 and the first timeline item on line 12.

28. CLI-686 - added current landing to the top of the markdown artifact.
   - Built: exported mission timeline markdown now shows `Current landing` with Changed, Next, and Proof before the full timeline list.
   - Meaning: an operator opening the artifact sees the latest result immediately, without scrolling to the bottom.
   - Proof: focused mission timeline/help tests passed 2/2, live markdown export shows Operator commands first, Current landing second, and the full timeline list after that.

29. CLI-687 - labeled the full history section.
   - Built: exported mission timeline markdown now inserts `Full history` before the long numbered list.
   - Meaning: the artifact clearly separates current state from chronological history.
   - Proof: focused mission timeline/help tests passed 2/2, live markdown export shows Operator commands, Current landing, then `Full history` before item 1.

30. CLI-688 - timestamped the markdown artifact.
   - Built: exported mission timeline markdown now includes `Generated at: <ISO>` near the top.
   - Meaning: the operator can tell when the proof artifact was produced.
   - Proof: focused mission timeline/help tests passed 2/2, live markdown export shows `Generated at: 2026-06-30T18:32:36.781Z` under mission status.

31. CLI-689 - timestamped the JSON timeline payload.
   - Built: `atris mission timeline <id> --json` now returns `generated_at`, and write-mode markdown uses the same timestamp.
   - Meaning: UI callers can show proof freshness without parsing markdown, and JSON plus markdown cannot disagree.
   - Proof: focused mission timeline/help tests passed 2/2, live JSON export returned `generated_at: 2026-06-30T18:35:34.494Z`, saved the markdown artifact, counted 20 timeline items, and confirmed the markdown contains the same timestamp.

32. CLI-690 - timestamped the terminal timeline.
   - Built: normal `atris mission timeline <id>` output now prints `Generated at: <ISO>` directly under the mission title.
   - Meaning: the operator can see proof freshness in the terminal without opening JSON or markdown.
   - Proof: focused mission timeline/help tests passed 2/2, live terminal output showed `Generated at: 2026-06-30T18:38:03.074Z` before the latest three mission items.

33. CLI-691 - added the full-history hint to compact terminal timelines.
   - Built: compact `atris mission timeline <id>` output now ends with `Full history: atris mission timeline <id> --all --write`.
   - Meaning: the operator can jump from the short terminal list to the full markdown artifact without remembering the export command.
   - Proof: focused mission timeline/help tests passed 2/2, live compact output showed the latest two mission items and then the full-history export command.

34. CLI-692 - exposed operator commands in timeline JSON.
   - Built: `atris mission timeline <id> --json` now returns `operator_commands.timeline`, `operator_commands.export`, and `operator_commands.prune_preview`.
   - Meaning: UI surfaces can render the same useful buttons as the markdown artifact without parsing text.
   - Proof: focused mission timeline/help tests passed 2/2, live JSON returned all three commands plus `generated_at: 2026-06-30T18:40:47.389Z`.

35. CLI-693 - exposed the current landing in timeline JSON.
   - Built: `atris mission timeline <id> --json` now returns a concise `current_landing` object with time, changed, next, and proof path.
   - Meaning: UI surfaces can show the latest mission result without scanning the timeline array or inheriting nested task machinery.
   - Proof: focused mission timeline/help tests passed 2/2, live JSON returned `current_landing` for CLI-693 and confirmed `has_nested_created_next: false`.

36. CLI-694 - exposed the next move in timeline JSON.
   - Built: `atris mission timeline <id> --json` now returns `next_move` using the same latest-landing fallback as markdown.
   - Meaning: UI surfaces can show the recommended next action without reimplementing Atris fallback logic.
   - Proof: focused mission timeline/help tests passed 2/2, live JSON returned `next_move: Created next task: CLI-694 Add nextmove to mission timeline JSON output.`

37. CLI-695 - exposed timeline truncation metadata in JSON.
   - Built: `atris mission timeline <id> --json` now returns `timeline_meta` with shown count, total count, hidden count, truncation state, and limit.
   - Meaning: UI surfaces can tell when a compact timeline is hiding older history and decide whether to show the full-history action.
   - Proof: focused mission timeline/help tests passed 2/2, live JSON for `--limit 2` returned `shown_count: 2`, `total_count: 32`, `hidden_count: 30`, and `truncated: true`.

38. CLI-696 - showed compact timeline count in terminal output.
   - Built: normal `atris mission timeline <id>` output now says how many items are shown, including `Showing latest N of M items.` when compacted.
   - Meaning: the operator can tell at a glance whether the short list is complete or hiding older history.
   - Proof: focused mission timeline/help tests passed 2/2, live terminal output for `--limit 2` showed `Showing latest 2 of 34 items.` followed by the full-history export command.

39. CLI-697 - showed timeline count in markdown exports.
   - Built: exported mission timeline markdown now prints the same item count directly under `Generated at`.
   - Meaning: the saved proof artifact tells the operator whether it is a full or compact history before they read the list.
   - Proof: focused mission timeline/help tests passed 2/2, live markdown export shows `Generated at: 2026-06-30T18:49:54.386Z` followed by `Showing 36 items.`

40. CLI-698 - showed current landing first in terminal timelines.
   - Built: normal `atris mission timeline <id>` output now prints `Current landing` with Changed, Next, and Proof before the numbered history.
   - Meaning: the operator sees the latest mission result immediately, then can scan the chronological list.
   - Proof: focused mission timeline/help tests passed 2/2, live terminal output showed the CLI-698 current landing before the latest two history items.

41. CLI-699 - labeled terminal timeline history.
   - Built: terminal `atris mission timeline <id>` output now inserts `History:` before the numbered list.
   - Meaning: the operator can distinguish the current landing summary from the chronological history.
   - Proof: focused mission timeline/help tests passed 2/2, live terminal output showed `Current landing`, then `History:`, then the latest two items.

42. CLI-700 - hid the full-history hint unless history is truncated.
   - Built: terminal `Full history: ... --all --write` now appears only when the compact timeline is hiding older items.
   - Meaning: complete terminal timelines no longer show unnecessary commands, while compact timelines still point to the full artifact.
   - Proof: focused mission timeline/help tests passed 2/2, live `--limit 2` output showed the full-history hint, and live `--limit 100` output showed `Showing 42 items.` with no `Full history:` hint.

43. CLI-701 - avoided duplicating current landing in terminal history.
   - Built: terminal history now omits the current landing item after showing it in the Current landing block.
   - Meaning: the operator gets the latest result once, then sees only prior history below it.
   - Proof: focused mission timeline/help tests passed 2/2, live `--limit 2` output showed CLI-701 in Current landing and CLI-700 as the only History item.

44. CLI-702 - exposed duplicate-free history in timeline JSON.
   - Built: `atris mission timeline <id> --json` now returns `history_without_current` beside `current_landing`.
   - Meaning: UI surfaces can render the same Current landing + History split as terminal output without removing duplicates themselves.
   - Proof: focused mission timeline/help tests passed 2/2, live JSON for `--limit 3` returned 3 timeline items, current landing as CLI-702, and 2 history items ending at CLI-701.

45. CLI-703 - exposed duplicate-free history count in timeline JSON.
   - Built: `atris mission timeline <id> --json` now returns `history_without_current_count`.
   - Meaning: UI surfaces can show history badges or empty states without measuring arrays.
   - Proof: focused mission timeline/help tests passed 2/2, live JSON for `--limit 3` returned `history_without_current_count: 2` and `count_matches: true`.

46. CLI-704 - exposed duplicate-free history toggle in timeline JSON.
   - Built: `atris mission timeline <id> --json` now returns `has_history_without_current`.
   - Meaning: UI surfaces can decide whether to render a History block without measuring arrays.
   - Proof: focused mission timeline/help tests passed 2/2, live JSON returned `history_without_current_count: 2` and `has_history_without_current: true`.

47. CLI-705 - exposed the history label in timeline JSON.
   - Built: `atris mission timeline <id> --json` now returns `history_label: History`.
   - Meaning: UI surfaces can match the terminal copy without hardcoding the section label.
   - Proof: focused mission timeline/help tests passed 2/2, live JSON returned `history_label: History`, `has_history_without_current: true`, and `history_without_current_count: 2`.

48. CLI-706 - exposed the current landing label in timeline JSON.
   - Built: `atris mission timeline <id> --json` now returns `current_landing_label: Current landing`.
   - Meaning: UI surfaces can match the terminal copy for both the latest-result block and history block.
   - Proof: focused mission timeline/help tests passed 2/2, live JSON returned `current_landing_label: Current landing`, `history_label: History`, and `has_history_without_current: true`.

49. CLI-707 - bundled timeline labels in JSON.
   - Built: `atris mission timeline <id> --json` now returns `labels.current_landing` and `labels.history`.
   - Meaning: UI surfaces can read display copy from one stable object while older flat label fields still work.
   - Proof: focused mission timeline/help tests passed 2/2, live JSON returned `labels: { current_landing: Current landing, history: History }` plus the existing flat labels.

50. CLI-708 - bundled timeline counts in JSON.
   - Built: `atris mission timeline <id> --json` now returns `counts.timeline`, `counts.history_without_current`, `counts.total`, `counts.hidden`, and `counts.shown`.
   - Meaning: UI surfaces can read badges and compact-state counts from one stable object while older count fields still work.
   - Proof: focused mission timeline/help tests passed 2/2, live JSON for `--limit 3` returned `counts.timeline: 3`, `counts.history_without_current: 2`, `counts.total: 58`, `counts.hidden: 55`, and `counts.shown: 3`.

51. CLI-709 - bundled timeline booleans in JSON.
   - Built: `atris mission timeline <id> --json` now returns `booleans.has_current_landing`, `booleans.has_history_without_current`, `booleans.truncated`, and `booleans.all`.
   - Meaning: UI surfaces can render sections and compact-state controls from one stable object while older flat fields still work.
   - Proof: focused mission timeline/help tests passed 2/2, live JSON for `--limit 3` returned current landing true, history true, truncated true, and all false.

52. CLI-710 - bundled timeline commands in JSON.
   - Built: `atris mission timeline <id> --json` now returns `commands.timeline`, `commands.export`, and `commands.prune_preview`.
   - Meaning: UI surfaces can read action commands from one stable object while older `operator_commands` still works.
   - Proof: focused mission timeline/help tests passed 2/2, live JSON returned all three commands and confirmed they match `operator_commands`.

53. CLI-711 - bundled artifact path state in timeline JSON.
   - Built: `atris mission timeline <id> --json` now returns `artifact.path`, `artifact.written`, and `artifact.format`.
   - Meaning: UI surfaces can tell whether a markdown proof report was actually written without parsing the older flat `artifact_path`.
   - Proof: focused mission timeline/help tests passed 2/2, live JSON showed non-write artifact `written: false`, then write-mode artifact `written: true`, `format: markdown`, and the saved report path.

54. CLI-712 - bundled generated timestamp state in timeline JSON.
   - Built: `atris mission timeline <id> --json` now returns `generated.label` and `generated.at` while preserving `generated_at`.
   - Meaning: UI surfaces can render the generated timestamp with the same label as terminal/markdown without hardcoding display copy.
   - Proof: focused mission timeline/help tests passed 2/2, live JSON showed `generated.label: Generated at` and confirmed `generated.at` matches `generated_at`.

55. CLI-713 - bundled next-move state in timeline JSON.
   - Built: `atris mission timeline <id> --json` now returns `next.label`, `next.move`, and `next.has_move` while preserving `next_move`.
   - Meaning: UI surfaces can render the next action block without hardcoding the label or checking raw strings themselves.
   - Proof: focused mission timeline/help tests passed 2/2, live JSON showed `next.label: Next`, `next.has_move: true`, and confirmed `next.move` matches `next_move`.

56. CLI-714 - exposed mission labels in timeline JSON.
   - Built: `atris mission timeline <id> --json` now returns `mission_labels.mission`, `mission_labels.objective`, and `mission_labels.status`.
   - Meaning: UI surfaces can label mission identity fields without hardcoding display copy.
   - Proof: focused mission timeline/help tests passed 2/2, live JSON showed mission labels in normal and write modes while the saved artifact path still returned correctly.

57. CLI-715 - exposed mission display state in timeline JSON.
   - Built: `atris mission timeline <id> --json` now returns `mission_display.label`, `mission_display.title`, `mission_display.id`, and `mission_display.status`.
   - Meaning: UI surfaces can render the mission header directly from JSON while preserving the raw `mission` object.
   - Proof: focused mission timeline/help tests passed 2/2, live JSON showed the mission objective as `mission_display.title` and write-mode still returned the saved artifact path.

58. CLI-716 - exposed timeline display copy in JSON.
   - Built: `atris mission timeline <id> --json` now returns `display.title`, `display.generated`, `display.count`, and the section labels for current landing, history, and next.
   - Meaning: UI surfaces can render the timeline header and section chrome directly from the payload without reconstructing terminal copy.
   - Proof: focused mission timeline/help tests passed 2/2, live JSON showed `display.count: Showing latest 3 of 74 items.` and write-mode still returned the saved artifact path.

59. CLI-717 - exposed current landing display state in timeline JSON.
   - Built: `atris mission timeline <id> --json` now returns `current_landing_display` with Changed, Next, and Proof labels/values.
   - Meaning: UI surfaces can render the latest mission result as a landing card without reformatting the raw current landing object.
   - Proof: focused mission timeline/help tests passed 2/2, live JSON showed the current landing display with the CLI-717 changed text, next text, and receipt path.

60. CLI-718 - exposed history item display state in timeline JSON.
   - Built: `atris mission timeline <id> --json` now returns `history_without_current_display` entries with index, label, Changed, Next, and Proof labels/values.
   - Meaning: UI surfaces can render chronological history items with the same shape as the current landing card.
   - Proof: focused mission timeline/help tests passed 2/2, live JSON showed two history display entries and write-mode still returned the saved artifact path.

61. CLI-719 - exposed visible timeline item display state in timeline JSON.
   - Built: `atris mission timeline <id> --json` now returns `timeline_display` entries with index, label, When, Changed, Next, and Proof labels/values for every visible timeline item.
   - Meaning: UI surfaces can render the full visible timeline from one display-ready array while preserving the raw `timeline`.
   - Proof: focused mission timeline/help tests passed 2/2, live JSON showed three `timeline_display` entries and write-mode still returned the saved artifact path.

62. CLI-720 - exposed timeline proof display state in timeline JSON.
   - Built: `atris mission timeline <id> --json` now returns `proof_display` with latest receipt and saved report labels/values.
   - Meaning: UI surfaces can render the proof block from one object instead of digging through the latest item and artifact fields.
   - Proof: focused mission timeline/help tests passed 2/2, live JSON showed the latest receipt path, and write-mode added the saved report path with `report_written: true`.

63. CLI-721 - exposed timeline actions display state in timeline JSON.
   - Built: `atris mission timeline <id> --json` now returns `actions_display` with Timeline, Export, and Prune preview labels/commands.
   - Meaning: UI surfaces can render action buttons directly from JSON while preserving the raw `commands` object.
   - Proof: focused mission timeline/help tests passed 2/2, live JSON showed all three action labels and commands, and write-mode still returned the saved artifact path.

64. CLI-722 - exposed timeline status display state in timeline JSON.
   - Built: `atris mission timeline <id> --json` now returns `status_display` with mission status, history status, count copy, truncation state, and hidden item count.
   - Meaning: UI surfaces can show compact/full history status without reconstructing it from counts and metadata.
   - Proof: focused mission timeline/help tests passed 2/2, live JSON showed `history_status: Compact history`, `hidden_count: 83`, and write-mode still returned the saved artifact path.

65. CLI-723 - exposed timeline export display state in timeline JSON.
   - Built: `atris mission timeline <id> --json` now returns `export_display` with export label, export command, saved report label, path, written state, and format.
   - Meaning: UI surfaces can render the export action and saved report status from one object.
   - Proof: focused mission timeline/help tests passed 2/2, live JSON showed export command before write-mode and saved report path with `report_written: true` after write-mode.

66. CLI-724 - exposed timeline prune display state in timeline JSON.
   - Built: `atris mission timeline <id> --json` now returns `prune_display` with prune preview command, availability, summary, would-prune count/bytes, and deleted count.
   - Meaning: UI surfaces can render the cleanup status without parsing `prune_summary` or raw run-prune data.
   - Proof: focused mission timeline/help tests passed 2/2, live JSON showed empty prune display before preview and `summary: Prune dry-run: 4 files / 27.0 KB would prune; 0 deleted.` after preview/write.

67. CLI-725 - exposed timeline artifact display state in timeline JSON.
   - Built: `atris mission timeline <id> --json` now returns `artifact_display` with artifact label, path label/value, written label/value, and format label/value.
   - Meaning: UI surfaces can render artifact state directly while preserving the raw `artifact` and `artifact_path` fields.
   - Proof: focused mission timeline/help tests passed 2/2, live JSON showed no artifact before write-mode and a markdown report path after write-mode.

68. CLI-726 - exposed timeline metadata display state in timeline JSON.
   - Built: `atris mission timeline <id> --json` now returns `timeline_meta_display` with Shown, Total, Hidden, Limit, and Truncated labels/values.
   - Meaning: UI surfaces can render timeline metadata without hardcoding labels or reading raw `timeline_meta` keys directly.
   - Proof: focused mission timeline/help tests passed 2/2, live JSON showed shown 3, total 94, hidden 91, limit 3, and truncated true; write-mode still returned the saved artifact path.

69. CLI-727 - exposed timeline empty-state display state in timeline JSON.
   - Built: `atris mission timeline --json` now returns `empty_state_display` for no-mission, empty-mission, and populated timeline states.
   - Meaning: UI surfaces can render the empty state without inventing copy or commands.
   - Proof: focused mission timeline/help tests passed 2/2, live no-mission JSON showed `No missions yet.`, and active mission JSON showed `is_empty: false`.

70. CLI-728 - exposed timeline schema display state in timeline JSON.
   - Built: `atris mission timeline <id> --json` now returns `schema_display` with schema name, version, and the primary display objects.
   - Meaning: UI surfaces can discover the stable display-ready contract from the payload instead of relying on out-of-band docs.
   - Proof: focused mission timeline/help tests passed 2/2, live JSON showed `atris.mission_timeline` version 1 and confirmed every advertised display object exists.

71. CLI-729 - exposed timeline summary display state in timeline JSON.
   - Built: `atris mission timeline <id> --json` now returns `summary_display` with summary label, title, count, latest result, proof, and next action.
   - Meaning: UI surfaces can render the mission timeline landing summary from one object.
   - Proof: focused mission timeline/help tests passed 2/2, live JSON showed summary title/count/latest/proof/next and confirmed `summary_display` is advertised in `schema_display`.

72. CLI-730 - exposed timeline navigation display state in timeline JSON.
   - Built: `atris mission timeline <id> --json` now returns `navigation_display` with the current view plus Timeline, Full history, and Prune preview commands.
   - Meaning: UI surfaces can render mission timeline navigation from one object instead of hand-mapping CLI command fields.
   - Proof: focused mission timeline/help tests passed 2/2, live JSON showed the navigation items and confirmed `navigation_display` is advertised in `schema_display`.

73. CLI-731 - exposed timeline filter display state in timeline JSON.
   - Built: `atris mission timeline <id> --json` now returns `filter_display` with the active filter, limit/counts, truncation state, and latest/full-history switch commands.
   - Meaning: UI surfaces can render timeline filters from one object without deriving state from raw metadata.
   - Proof: focused mission timeline/help tests passed 2/2, live JSON showed latest/full-history filter options and confirmed `filter_display` is advertised in `schema_display`.

## Current live proof

- `atris loop status --json` now shows the active overnight mission plus the latest evidence-backed suggested target when no concrete task is queued.
- `atris task reviews --limit 34` shows CLI-658 through CLI-730 ready for human approval with proof, and CLI-731 is being moved there now.
- The timeline proof now has grouped mission labels/display, schema display state, summary display state, navigation display state, filter display state, timeline display copy/status, timeline item display state, timeline metadata display state, empty-state display state, proof display state, export/actions/prune/artifact display state, generated timestamp, commands/labels/counts/booleans/artifact/next state, current landing label/data/display, duplicate-free history label/count/toggle/display, truncation metadata, and item counts across JSON, terminal, and markdown surfaces.
- Human approval is still untouched.

## Next move

Bundle timeline filter display state in JSON.

Suggested target: add timeline receipt display object to mission timeline JSON output.
