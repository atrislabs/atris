# Atris Agent Language (AAL) v0.1
One-line "calls" that orchestrate multi-agent plan → do → review.

---

## 0) What AAL is
AAL is a *control plane* language, not a coding language.

You (human) only choose:
- the PLAY (workflow macro)
- the CHIPS (decision techniques)
- the STAGE MULTIPLIERS (plan2x / review3x)
- the POLICY (when autopilot is allowed)

Agents do the work and write artifacts:
- atris/MAP.md
- atris/TODO.md
- logs/YYYY/YYYY-MM-DD.md (journal)

AAL compiles to Atris roles:
- PLAN   → navigator(s) + plan-synth
- DO     → executor(s)
- REVIEW → validator(s) + review-synth (+ optional redteam validator)

---

## 1) The first-principles model (why this works)
Any engineering task = move system from State A → State B under constraints.

So the only moves we need are:
1) Reduce uncertainty (search)
2) Choose a transformation (strategy)
3) Apply the smallest safe transformation (mutation)
4) Prove it matches DoD (verification)
5) Record learnings + keep maps accurate (self-documentation)

AAL is just a compact way to pick those moves repeatedly.

---

## 2) Syntax

### 2.1 One-liner "play call"
```
<PLAY>{+chip,+chip,...} plan<N> do<M> review<K> :: "<TASK>"
  goal:"..." dod:"..." constraints:"..." policy:"manual|auto-low-risk"
  models:"plan=[...];do=[...];review=[...]"
  stop:"..."
```

Examples:
```
QUICKFIX{+MPE,+TESTGATE,+REVIEW3X} plan2 do1 review3 :: "401 on refresh token"
FEATURE_SLICE{+ISOMORPH,+CONTRACT} plan2 do2 review3 :: "Export CSV button"
```

### 2.2 Block form (what UI renders / what the router evaluates)
```yaml
RUN:
  play: <PLAY>
  task: "<TASK>"
  goal: "<GOAL>"
  dod: "<DEFINITION OF DONE>"
  constraints:
    - ...
  pipeline:
    plan:   {chips:[...], agents:N, models:[...]}
    do:     {chips:[...], agents:M, models:[...]}
    review: {chips:[...], agents:K, models:[...]}
  policy: manual | <policy-name>
  stop:
    - ...
```

---

## 3) Chips (skills / decision operators)
A CHIP is the smallest reusable unit that has:
- Trigger (when to use)
- Actions (what agents do)
- Artifact (what gets written)
- Stop condition (what proves completion)

### Search / Uncertainty reduction

**BFS**
- Trigger: "I don't know where the issue/answer is"
- Actions: enumerate 5–10 hypotheses + cheapest test per hypothesis; run tests cheapest-first
- Artifact: ranked suspect list + evidence
- Stop: one hypothesis is strongly supported (or all cheap tests fail)

**MPE (Most Probable Element)**
- Trigger: "Likely concentrated in 1–3 modules"
- Actions: top-3 file/module suspects; 1 agent per suspect; each proposes fastest falsification
- Artifact: winner + why losers are unlikely
- Stop: one suspect survives falsification

**TRACE**
- Trigger: you have a symptom (stack trace, wrong value, crash point)
- Actions: follow causal chain symptom → first bad value → first bad write
- Artifact: causal chain + exact "first wrong step"
- Stop: you can point to the first divergence

**BISECT**
- Trigger: huge search space (commits/config/flags/branches)
- Actions: binary search until the break point is isolated
- Artifact: exact commit/flag/config delta that flips behavior
- Stop: breakpoint isolated to one delta

**ISOMORPH**
- Trigger: you're building something similar to existing code
- Actions: find nearest existing "shape" in repo (same pattern) and reuse structure
- Artifact: "copy this pattern" references + adaptation notes
- Stop: you have a concrete template to follow

### Strategy / Solution shaping

**PARETO**
- Trigger: speed matters / MVP / hotfix
- Actions: choose smallest diff that meets DoD; explicitly defer everything else
- Artifact: minimal-change plan + "deferred list"
- Stop: plan stays within diff budget

**DECOMPOSE (Divide & Conquer)**
- Trigger: task can be split cleanly
- Actions: produce DAG of subtasks with interfaces; assign in parallel; define merge points
- Artifact: task DAG + integration order
- Stop: every subtask has an owner + interface contract

**INVERT (Invariant-first)**
- Trigger: safety/security/correctness sensitive
- Actions: list invariants ("must never happen") + prove plan preserves them
- Artifact: invariants + checks (tests/asserts)
- Stop: invariants are testable and attached to review

**CONTRACT (Success-first)**
- Trigger: feature work or risky change
- Actions: define types/interfaces + acceptance tests before implementation
- Artifact: contract + tests plan
- Stop: DoD is measurable by tests

**TIMEBOX**
- Trigger: exploration can spiral
- Actions: limit iterations/time; pick best current route; record uncertainty
- Artifact: chosen route + "open questions"
- Stop: budget exhausted OR strong evidence found

### Mutation / Execution style

**SCAFFOLD**
- Trigger: new module/feature with multiple parts
- Actions: create structure/stubs/wiring first; compile before logic; then fill
- Artifact: skeleton merged + implementation steps
- Stop: skeleton compiles + routes wired end-to-end

**SHIM**
- Trigger: risky legacy core
- Actions: wrap/adapt instead of editing core
- Artifact: adapter/wrapper layer
- Stop: behavior fixed without touching core

**ATOMIC**
- Trigger: minimize blast radius
- Actions: constrain changes to smallest surface (one file or one interface)
- Artifact: small diff with clear justification
- Stop: diff budget honored

**DELETE**
- Trigger: dead code / complexity
- Actions: delete, don't patch; restore clarity
- Artifact: reduced surface area + updated references
- Stop: builds/tests still pass

### Proof / Robustness

**TESTGATE**
- Trigger: any bugfix or behavior change
- Actions: reproduce in a test first; fix until green
- Artifact: regression test
- Stop: test fails pre-fix, passes post-fix

**DIFFGUARD**
- Trigger: autopilot or high-risk area
- Actions: enforce max files/LoC, forbid protected dirs unless explicit override
- Artifact: diff budget + enforcement decision
- Stop: budget satisfied OR run halted

**REVIEW3X**
- Trigger: you want autopilot-confidence
- Actions: three independent reviewers produce punchlists (no peeking)
- Artifact: merged punchlist with severity
- Stop: no P0 issues remain

**REDTEAM**
- Trigger: subtle break risk, security, edge-case heavy
- Actions: adversarial review: "how does this fail silently?"
- Artifact: "attack paths" + fixes/tests
- Stop: top attack paths are mitigated or explicitly accepted

**MAPSYNC**
- Trigger: architecture/file moves
- Actions: validator checks MAP references still valid; updates MAP if needed
- Artifact: MAP diff + rationale
- Stop: MAP truth restored

---

## 4) Plays (macros)
Plays = default chip bundles + default multipliers.

### QUICKFIX (fast bugfix, minimal blast)
```
PLAN   : [MPE, TRACE, PARETO]            agents=2
DO     : [ATOMIC, SHIM]                  agents=1
REVIEW : [TESTGATE, DIFFGUARD, REVIEW3X] agents=3
```

### HARDDEBUG (unknown/weird issue)
```
PLAN   : [BFS, TRACE, BISECT]            agents=3
DO     : [ATOMIC]                        agents=1
REVIEW : [TESTGATE, REDTEAM, REVIEW3X]   agents=3
```

### FEATURE_SLICE (thin end-to-end slice)
```
PLAN   : [ISOMORPH, CONTRACT, DECOMPOSE] agents=2
DO     : [SCAFFOLD, DECOMPOSE]           agents=2
REVIEW : [TESTGATE, REDTEAM, REVIEW3X]   agents=3
```
Extra: creates atris/features/<name>/idea.md + build.md before code.

### SAFE_REFACTOR (cleanup without breakage)
```
PLAN   : [TRACE, INVERT, DIFFGUARD]      agents=2
DO     : [SHIM, ATOMIC, DELETE]          agents=1
REVIEW : [TESTGATE, MAPSYNC, REVIEW3X]   agents=3
```

---

## 5) Autopilot policy (how you go hands-off safely)
Hard rule:
- If policy does NOT match, stop after PLAN and request approval.

Policy = pre-committed human intent.

**Example policy: auto-low-risk**
Allow only if ALL are true:
- touched_files ≤ 2
- net_loc ≤ 50
- no schema migrations
- no auth/billing/payments/security-sensitive directories
- TESTGATE present (or existing coverage is proven)
- DIFFGUARD passes

REVIEW can always break autopilot:
- failing tests
- DIFFGUARD violation
- REDTEAM finds a credible silent-break path
- MAPSYNC requires non-trivial architecture edits

---

## 6) Why multipliers work (plan2x / review3x)

**PLAN(xN):**
- N planners run independently.
- Synth merges:
  1) intersection → "agreed core plan"
  2) union → "optional extensions" (explicitly deferred unless needed)
  3) conflicts → "cheapest decision test" per conflict
- Output: one plan + conflicts + risk.

**REVIEW(xN):**
- N reviewers run independently.
- Synth clusters duplicates.
- Severity rubric:
  - P0 = safety/security/correctness break → must fix
  - P1 = likely bug/maintainability regression → should fix
  - P2 = nice-to-have
- Loop: any P0 → back to DO with a scoped fix.

---

## 7) "Commands you can run" (UI buttons or CLI wrapper)
These are the canonical AAL commands (what you type/click):

```bash
QUICKFIX{+MPE,+TESTGATE} plan2 do1 review3 :: "Fix intermittent 401 refresh token"
FEATURE_SLICE{+ISOMORPH,+CONTRACT} plan2 do2 review3 :: "Add Export CSV button on reports"
HARDDEBUG{+BISECT,+TRACE,+REDTEAM} plan3 do1 review3 :: "Prod-only null pointer in queue worker"
SAFE_REFACTOR{+DELETE,+DIFFGUARD} plan1 do1 review2 policy:"auto-low-risk" :: "Remove dead code in settings UI"
```

Suggested CLI wrapper (if you want it):
```bash
atris play 'QUICKFIX{+MPE,+TESTGATE} plan2 do1 review3 :: "Fix 401 refresh token"' --policy manual
atris play 'SAFE_REFACTOR{+DELETE,+DIFFGUARD} plan1 do1 review2 :: "Remove unused imports"' --policy auto-low-risk
```

---

## 8) The universal "best prompt" (model-agnostic)
Paste to any agent runner:

```
YOU ARE IN AN ATRIS WORKSPACE.

LOAD CONTEXT (read-only):
- atris/atris.md
- atris/MAP.md (if missing, generate it)
- atris/TODO.md (if missing, generate it from MAP.md)
- latest logs/YYYY/YYYY-MM-DD.md
- atris/PERSONA.md

PLAY CALL:
<INSERT AAL ONE-LINER>

OUTPUT CONTRACT (always):
A) PLAN PACK (≤ 10 bullets)
   - file:line refs for every touched area (from MAP)
   - risk level + diff budget
   - exact DoD
   - ASCII visualization (required for feature/architecture work)
B) If policy/approval allows: DO
   - step-by-step; no scope creep without re-classifying risk + updating diff budget
C) REVIEW PACK
   - typecheck/lint/tests results
   - punchlist with severities (P0/P1/P2)
D) JOURNAL UPDATE (append-only)
   - add/advance I/T/C items
   - keep summaries 3–4 sentences max

STOP RULES:
- If policy does not match → stop after PLAN PACK and request approval.
- Never expand scope silently.
- If tests fail → stop and produce smallest next fix.
```

---

## 9) Dry-run sanity check (proves decomposition + robust review loop)

**Example task:** "Add authentication to file upload"

**AAL:**
```
QUICKFIX{+MPE,+TESTGATE,+REVIEW3X} plan2 do1 review3 :: "Add auth to upload endpoint"
```

**Expected PLAN PACK shape:**
- Suspects (top-3): upload route, auth middleware, auth types
- Minimal plan: verifySession() call → 401 on no session → regression test → run tests
- Risk: Low, diff budget: ≤ 30 LoC, files ≤ 3
- DoD: unauth upload returns 401; test fails pre-fix and passes post-fix; all tests green

**Expected REVIEW3X merge shape:**
- Reviewer A: missing test for expired session
- Reviewer B: ensure error response shape matches conventions
- Reviewer C: confirm middleware doesn't break other endpoints
- Merged: 1 P1 fix + 2 P2 notes → loop DO once → "✓ Safe to merge"
