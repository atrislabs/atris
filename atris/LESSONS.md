# LESSONS.md — Reinforcement Learning Data

> **Internal only** | Lessons extracted from validation cycles | Future: RL training data

---

## Session: 2025-10-22

### L1: Explicit Skill Instructions Drive Agent Performance
**Context:** Updated validator.md with "ultrathink" directive

**Lesson:** Telling agents to literally say "ultrathink" forces triple-checking behavior. Skills upfront in agent specs = agents know their tools immediately and use them consistently.

**Pattern:** Explicit activation words > implicit instructions

**Impact:** Validator became methodical gatekeeper instead of passive doc updater

---

### L2: Validator's Pareto Mental Model Unblocks Complex Tasks
**Context:** T14 bidirectional journal sync - seemed complex with merge conflicts, diffing logic

**Lesson:** Validator applied Pareto (80/20 rule) and found the 20% solution: timestamp check + user choice. Skipped complex merge logic (80% effort, 20% value). User gets conflict resolution without slop.

**Pattern:** When task seems complex, validator asks: "What's the 20% that delivers 80% value?" Then ships that.

**Impact:** Low-complexity solution shipped same day. Feature delivered without over-engineering.

---

### L3: Command-as-Prompt Pattern Enables Rapid Agent Switching
**Context:** T15 3-command system - `atris plan`, `atris do`, `atris review` activate different agent modes

**Lesson:** Commands that output agent specs create instant context switching. Coding agent reads the spec and becomes that agent. No manual file hunting, just one command to switch modes.

**Pattern:** Command → Load spec + context → Agent activated. Commands are encoded instructions for any coding agent.

**Impact:** User goes from planning to building to validation with 3 simple commands. Self-evolving loop becomes executable workflow.

---

### L4: Status Command Provides Instant System Visibility
**Context:** T16 `atris status` - shows active tasks, inbox items, recent completions at a glance

**Lesson:** Single command that aggregates state from multiple files eliminates context switching. User doesn't need to open TODO.md, journal, etc. Just run `atris status` and see everything.

**Pattern:** Aggregation commands > opening multiple files. Parse once, display concisely.

**Impact:** Instant visibility into system state. User knows exactly where they are in the workflow loop without mental overhead.

---

### L5: Centering a Small, Clear CLI Loop Improves Adoption
**Context:** CLI UX simplification — clarified `plan`, `do`, `review` as the core workflow and aligned docs around `TODO.md` + features + logs.

**Lesson:** When the CLI surfaces one obvious loop and keeps other commands clearly secondary, it becomes much easier for both humans and agents to adopt and remember. A simple, repeatable path beats a large catalog of options.

**Pattern:** Small, opinionated core loops > broad command surfaces. Promote the main workflow, demote helpers.

**Impact:** New users can understand how to use Atris in seconds, and coding agents can reliably script the workflow without extensive per-project instructions.

---

## Future Sessions

Format:
- **L#:** Title
- **Context:** What task/problem
- **Lesson:** What we learned
- **Pattern:** Generalizable principle
- **Impact:** Measurable outcome

---

**Purpose:** Rich RL data for training better agents. Validator analytics, pattern recognition, continuous improvement loops.
