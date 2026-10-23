# Research spending ceiling, October 22, 2026

owned_by: executor
executed_by: codex
source_branch: member/executor-research-budget-limit
review_status: independent pass for paused local application; broader rollout not certified

The existing local lab-partnership research is paused with a $20 ceiling on
recorded mission costs, $0 spent/reserved and no running missions. Earlier
events are unchanged. No research, training, cloud runner or outreach started.
No new paid tool permission follows from setting this accounting ceiling.

Implementation reuses transactional campaign append and mission admission;
no new product module or dependency. Installed code matches reviewed source
by SHA-256. The locally installed package retains version 3.72.5 and includes
this unpublished change. No npm package was published and no cloud deployed.
A backup of the prior installed package is retained locally. After applying
the event, keep a reader supporting it rather than silently downgrading.

## Evidence

- [Independent test witness](research-budget-limit-tests-2026-10-22.md):
  169 affected tests passed, including 15 new regressions; 21 CLI golden files
  and 14 decision cases passed. No other surface conformance claimed.
- [Opus source review](research-budget-limit-opus-2026-10-22.md):
  PASS for paused local installation/application. Opus read code; it did not
  execute shell tests. The test witness is separate from the builder.
- Actual saved-state proof (retained locally in the campaign and executor logs):
  read back $20 with no warnings, unchanged history, no cloud link and no
  real campaign changes from admission probes. The budget-only refusal was
  checked in a disposable copy so the real campaign stayed paused.

## Limits retained from review

This controls recorded mission costs and admission, not raw provider spending.
A mission can cost more than its reservation; unknown costs are not measured
by this ceiling. Direct paid training needs an independent provider control.
Older readers reject the event; older running-mission gates may fail open,
which is why no running mission is allowed for this local application.
Cloud/web/desktop support is not claimed, and current sync refuses the event.

Opus also identified two issues before a wider rollout: time-ordered replay
can ignore a limit when historical timestamps and command-time checks differ,
and first-pull sync has a local-write ordering gap. Neither applies to this
zero-spend/zero-reservation, already-local, paused campaign. Its actual saved
ceiling was explicitly checked for $20 and no warnings. Keep any broader
release in review until those issues and shared-reader rollout are resolved.
