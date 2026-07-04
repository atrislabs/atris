# TODO.md

> Regenerated from durable Atris task state. Do not treat this file as truth.

## Backlog

- **[CLI-174]** First useful step: chat-scan [onboarding]

## In Progress

- **[CLI-165]** Fix provider seed recert wedge [benchmark]
  **Claimed by:** executor
- **[CLI-156]** Audit and close next runner-agnostic heartbeat gap [runner]
  **Claimed by:** codex-executor

## Review

- **[CLI-173]** Mission XP: these problems will be solved keep dogfooding. dogfood for 2 hours [agent-xp]
  **Verify:** git diff --check
- **[CLI-172]** Fix autoland agent accept guard [cli]
- **[CLI-171]** Mission XP: Try the new v3.34.0 features for 10 minutes and report what works, what breaks, and what should be fixed next [agent-xp]
- **[CLI-169]** Mission XP: Find and ship one verified overnight improvement to atris-cli [agent-xp]
  **Verify:** node --test test/mission-resume.test.js
- **[CLI-167]** Fix AX checker for local GitHub push route [ax]
- **[CLI-164]** Push committed master and clean checkout [maintenance]
- **[CLI-163]** Pull latest origin/master safely [maintenance]
- **[CLI-162]** Mission XP: Scan nearby empire repos for places Atris can help; inspect sibling repos, rank concrete opportunities, and write atris/reports/nearby-repos-help.md with repo, evidence, suggested next mission, and risk [agent-xp]
  **Verify:** test -s atris/reports/nearby-repos-help.md
- **[CLI-158]** Pull latest origin/master and run tests [maintenance]
- **[CLI-157]** Mission XP: Connect Atris mission to Codex /goal so Codex keeps one long-running visible goal, emits the next mission objective, and replaces the current goal when platform support exists [agent-xp]
  **Verify:** rg "selectCodexGoalMission|mission goal|codex_goal_candidate" commands/mission.js test/mission-status.test.js
- **[CLI-155]** Audit and close next runner-agnostic heartbeat gap [runner]
- **[CLI-154]** Audit and close next runner-agnostic heartbeat gap [runner]
- **[CLI-153]** Audit and close next runner-agnostic heartbeat gap [runner]
- **[CLI-152]** Constrain run log file arguments to run logs directory [runner]
- **[CLI-151]** Audit and close next runner-agnostic heartbeat gap [runner]
- **[CLI-150]** Audit and close next runner-agnostic heartbeat gap [runner]
- **[CLI-149]** Audit and close next runner-agnostic heartbeat gap [runner]
- **[CLI-148]** Audit and close next runner-agnostic heartbeat gap [runner]
- **[CLI-147]** Audit and close next runner-agnostic heartbeat gap [runner]
- **[CLI-146]** Audit and close next runner-agnostic heartbeat gap [runner]
- **[CLI-145]** Audit and close next runner-agnostic heartbeat gap [runner]
- **[CLI-144]** Audit and close next runner-agnostic heartbeat gap [runner]
- **[CLI-143]** Audit and close next runner-agnostic heartbeat gap [runner]
  **Verify:** node --test test/review-lane-auto-review.test.js
- **[CLI-142]** Audit and close next runner-agnostic heartbeat gap [runner]
  **Verify:** node --test test/review-lane-auto-review.test.js
- **[CLI-141]** Audit and close next runner-agnostic heartbeat gap [runner]
  **Verify:** node --test test/review-lane-auto-review.test.js
- **[CLI-140]** Preserve diagnostics for autopilot horizon runner failures [runner]
  **Verify:** node --test test/review-lane-auto-review.test.js
- **[CLI-139]** Audit and close next runner-agnostic heartbeat gap [runner]
  **Verify:** node --test test/review-lane-auto-review.test.js
- **[CLI-138]** Make compile runner failures preserve diagnostics [runner]
  **Verify:** node --test test/review-lane-auto-review.test.js
- **[CLI-137]** Audit next runner-agnostic heartbeat gap after phase failures [runner]
  **Verify:** node --test test/review-lane-auto-review.test.js
- **[CLI-136]** Audit and close next runner-agnostic heartbeat gap [runner]
  **Verify:** node --test test/review-lane-auto-review.test.js
- **[CLI-135]** Port run phase failure contract to current master [runner]
  **Verify:** node --test test/review-lane-auto-review.test.js
- **[CLI-133]** Audit and close next runner-agnostic heartbeat gap [runner]
  **Verify:** node --test test/autopilot-runner-model.test.js test/runner-command.test.js
- **[CLI-132]** Port no-runner heartbeat alias to current master [runner]
  **Verify:** npm test
- **[CLI-131]** Add runner-neutral no-runner alias for heartbeat controls [runner]
  **Verify:** npm test
- **[CLI-130]** Make stale heartbeat board state actionable [ui]
  **Verify:** npm test
- **[CLI-129]** Make compile runner prompt temp file unique [runner]
  **Verify:** node --test test/compile.test.js test/prompt-temp.test.js
- **[CLI-128]** Make runner prompt temp files unique [runner]
  **Verify:** node --test test/prompt-temp.test.js test/autopilot-runner-model.test.js test/runner-command.test.js
- **[CLI-127]** Audit and close next runner-agnostic heartbeat gap [runner]
  **Verify:** node --test test/autopilot-runner-model.test.js test/runner-command.test.js
- **[CLI-126]** Audit and close next runner-agnostic heartbeat gap [runner]
  **Verify:** node --test test/autopilot-runner-model.test.js test/runner-command.test.js
- **[CLI-125]** Audit and close next runner-agnostic heartbeat gap [runner]
  **Verify:** node --test test/autopilot-runner-model.test.js test/runner-command.test.js
- **[CLI-124]** Audit and close next runner-agnostic heartbeat gap [runner]
  **Verify:** node --test test/autopilot-runner-model.test.js test/runner-command.test.js
- **[CLI-123]** Make pulse install runner preflight visible [runner]
  **Verify:** node --test test/pulse.test.js
- **[CLI-122]** Make autopilot heartbeat runner selection observable [runner]
  **Verify:** npm test
- **[CLI-121]** Make task factory board safe-action state visible [design]
  **Verify:** npm test
- **[CLI-120]** Fix PR #142 stacked codex plan-review failure contract [runner]
  **Verify:** npm test
- **[CLI-119]** Fix PR #141 master autopilot runner failure contract [runner]
  **Verify:** npm test
- **[CLI-118]** Fix PR #140 pulse CI run failure contract [runner]
  **Verify:** npm test
- **[CLI-117]** Fix PR #143 pulse CI runner failure contract [runner]
  **Verify:** npm test
- **[CLI-116]** Fix pulse branch CI stack failures [runner]
  **Verify:** npm test
- **[CLI-115]** Parse pulse branch autonomy value flags consistently [runner]
  **Verify:** node --test test/autopilot-runner-model.test.js test/runner-command.test.js
- **[CLI-114]** Port invalid autonomy loop limits to pulse branch [runner]
- **[CLI-113]** Port autopilot failure contract to pulse branch [runner]
- **[CLI-112]** Fail codex plan-review on non-zero stdout [runner]
- **[CLI-111]** Fail autopilot runner phases on non-zero stdout [runner]
- **[CLI-110]** Port run failure contract to pulse self-improve branch [runner]
- **[CLI-109]** Fail autonomy phases on non-zero runner exit with stdout [runner]
- **[CLI-108]** Reject invalid autonomy loop limits clearly [runner]
- **[CLI-107]** Audit and close next runner-agnostic heartbeat gap [runner]
- **[CLI-106]** Make runner profile flag override stale runner env [runner]
- **[CLI-105]** Guard mission subcommand help from side effects [runner]
  **Verify:** node --test test/mission-help.test.js
- **[CLI-104]** Guard worktree subcommand help from side effects [runner]
  **Verify:** node --test test/worktree-help.test.js
- **[CLI-103]** Make autopilot dry-run description preview honest [runner]
  **Verify:** node --test test/autopilot-dry-run.test.js test/autopilot-runner-model.test.js test/runner-command.test.js
- **[CLI-102]** Let run/autopilot dry-run preview without runner binary [runner]
  **Verify:** node --test test/autopilot-runner-model.test.js test/runner-command.test.js
- **[CLI-101]** Guard pulse subcommand help from side effects [runner]
  **Verify:** git -C /Users/keshavrao/arena/empire/.agent-worktrees/atris-cli/codex-guard-pulse-subcommand-help-from-sid-20260628-225650 diff --check HEAD~1 HEAD
- **[CLI-100]** Format improve structured API errors clearly [runner]
  **Verify:** git -C /Users/keshavrao/arena/empire/.agent-worktrees/atris-cli/codex-format-improve-structured-api-errors-20260628-225221 diff --check HEAD~1 HEAD
- **[CLI-99]** Show runner identity in autopilot dry-run preview [runner]
  **Verify:** git -C /Users/keshavrao/arena/empire/.agent-worktrees/atris-cli/codex-show-runner-identity-in-autopilot-dr-20260628-224750 diff --check HEAD~1 HEAD
- **[CLI-98]** Show runner identity in run dry-run preview [runner]
  **Verify:** git -C /Users/keshavrao/arena/empire/.agent-worktrees/atris-cli/codex-show-runner-identity-in-run-dry-run-20260628-224345 diff --check HEAD~1 HEAD
- **[CLI-97]** Preserve improve model override in local fallback [runner]
  **Verify:** git -C /Users/keshavrao/arena/empire/.agent-worktrees/atris-cli/codex-preserve-improve-model-override-in-l-20260628-224000 diff --check HEAD~1 HEAD
- **[CLI-96]** Preserve pulse run passthrough flags exactly [runner]
  **Verify:** git -C /Users/keshavrao/arena/empire/.agent-worktrees/atris-cli/codex-preserve-pulse-run-passthrough-flags-20260628-223255 diff --check HEAD~1 HEAD
- **[CLI-95]** Add runner-neutral pulse worker disable flag [runner]
  **Verify:** git -C /Users/keshavrao/arena/empire/.agent-worktrees/atris-cli/codex-add-runner-neutral-pulse-worker-disa-20260628-222737 diff --check HEAD~1 HEAD
- **[CLI-94]** Expose pulse runner identity in heartbeat receipts [runner]
  **Verify:** git -C /Users/keshavrao/arena/empire/.agent-worktrees/atris-cli/codex-expose-pulse-runner-identity-in-hear-20260628-222240 diff --check HEAD~1 HEAD
- **[CLI-93]** Audit and close next runner-agnostic heartbeat gap [runner]
  **Verify:** git -C /Users/keshavrao/arena/empire/.agent-worktrees/atris-cli/codex-audit-and-close-next-runner-agnostic-20260628-221715 diff --check HEAD~1 HEAD
- **[CLI-92]** Audit and close next runner-agnostic heartbeat gap [runner]
  **Verify:** git -C /Users/keshavrao/arena/empire/.agent-worktrees/atris-cli/codex-audit-and-close-next-runner-agnostic-20260628-221157 diff --check HEAD~1 HEAD
- **[CLI-91]** Repair Codex goal bridge DB path [mission]
  **Verify:** node --check commands/codex-goal.js

## Blocked

- **[CLI-87]** Implement Codex visible goal replacement runtime API [platform-goal]

## Completed

- **[CLI-170]** Mission XP: Find and ship one verified overnight improvement to atris-cli [agent-xp]
  **Verify:** node --test test/pulse.test.js test/loop-front.test.js
- **[CLI-168]** Fix overnight heartbeat stale CLI install [loop]
  **Verify:** node --test test/pulse.test.js
- **[CLI-166]** Fix autoland tick current-CLI subprocess [autoland]
  **Verify:** node --test test/autoland.test.js
- **[CLI-161]** Pull latest origin/master on request [maintenance]
- **[CLI-160]** Pull latest origin/master for newer version [maintenance]
- **[CLI-159]** Pull latest origin/master and inspect repo state [maintenance]
- **[CLI-134]** Audit and close next runner-agnostic heartbeat gap [runner]
- **[CLI-90]** Prevent AgentXP sync downgrades against hosted leaderboard [agentxp]

(88 older completed tasks archived in `atris task list --status done` and `atris task events`.)
