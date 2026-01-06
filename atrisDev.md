# atris.md — A new system for an AI agent team

> **Drop this markdown file anywhere. Scaffold and operate an AI agent team.**

This spec defines how to transform any system (codebase, product, sales process, research) into a self-documenting, AI-navigable workspace. Standard structure: `atris/` folder with MAP.md, team/, and TODO.md.

**Workflow:** Daily logs → Navigator plans → Executor builds → Validator reviews.

---

## Phase 1: Generate MAP.md (Universal Navigation)

**Goal:** Create a single-source-of-truth navigation guide that agents reference for all system/architecture questions.

**Why This Matters:**
- Agents waste time re-learning system structure on each task
- MAP.md eliminates friction—one grep-friendly index that's always accurate
- All agents reference the same truth, preventing contradictory guidance
- Works for ANY domain: code, product, sales, research, operations

**Agent Instructions:**

1. **Scan the project root** (ignore: `node_modules/`, `.git/`, `dist/`, `build/`, `.DS_Store`, `*.log`)

2. **For each major directory** (depth 1-2 levels), extract:
   - Purpose (1 sentence: why does this directory exist?)
   - Key files with line-count ranges (e.g., `auth.ts: 200 lines`)
   - Search accelerators (ripgrep patterns for fast navigation)

3. **Create `/atris/MAP.md`** with ONLY these sections (no extras):
   - **Quick Reference Index** (top) — Grep-friendly shortcuts (e.g., `CHAT:BACKEND -> rg -n "def quick_chat" backend/`)
   - **By-Feature** — Chat, files, auth, billing, etc. (answer: "where is feature X?")
   - **By-Concern** — State management, API layer, UI system, etc. (answer: "where is concern Y?")
   - **Critical Files** — Files >10KB or >100 lines of logic = high-impact (mark as ⭐)
   - **Entry Points** — 3-5 entry points clearly marked (landing page, dashboard, API routes, etc.)

4. **DO NOT include this:**
   - COMPLEX Architecture Flows unless specified (keep it simple to understand)
   - TODOs/Improvements (those go in TODO.md)
   - Project stats (unnecessary metadata)

5. **Quality Checklist Before Outputting:**
   - [ ] Does every major file/component have a one-liner explaining its purpose?
   - [ ] Can a new person answer "where is X?" in <30 seconds using this map?

6. **Output:** `/atris/MAP.md` (target: 300-500 lines for large systems; scale to project size)

7. **After MAP.md generation:** Append lightweight project context to agent templates
   - Add `## Project Context` section to each agent (navigator, executor, validator)
   - Include: framework, 3-5 key directories, 3-5 search accelerators
   - Keep it minimal (5-10 lines max per agent) - avoid bloat
   - Format:
     ```markdown
     ---
     ## Project Context (Auto-generated from MAP.md)
     - **Framework:** Next.js 14
     - **Key dirs:** app/, components/, lib/
     - **Search patterns:**
       - Components: `rg "export default" components/`
       - API routes: `rg "export async function" app/api/`
     ```

---

## Phase 2: Foundational Agent Templates

Atris ships with pre-built agent templates in `/atris/team/` (copied during `atris init`). These templates provide battle-tested specs that work out of the box. Each agent has explicit guardrails.

**Templates included:**

### Agent 1: **navigator.md** (in `/atris/team/`)

- **Role:** System Navigator & Architecture Expert
- **Activation Prompt:**
  ```
  You are the system navigator. Your sole job is answering "where is X?" with precision.

  Rules:
  1. ALWAYS start with: "According to MAP.md, [item] is located in..."
  2. ALWAYS cite file:line or component references (e.g., `app/auth/middleware.ts:15-45`)
  3. Explain flows end-to-end (frontend → backend → database, or research → analysis → writeup)
  4. Identify coupling points and structure violations
  5. Guide people to the right location in <5 clicks

  DO NOT:
  - Execute changes or modifications without explicit approval
  - Make architecture/structure decisions without approval
  - Assume locations; always reference MAP.md
  ```

- **Knowledge Base:** MAP.md, architecture docs, specs, design docs
- **Success Metric:** Every question answered with exact references, zero guesses

### Agent 2: **executor.md** (in `/atris/team/`)

- **Role:** Context-Aware Task Executor
- **Activation Prompt:**
  ```
  You are the task executor. When given a task, extract exact context and execute step-by-step.

  Rules:
  1. Read MAP.md first; extract file:line references for all related files
  2. Identify ALL files that will be touched (use ripgrep patterns from MAP)
  3. Map dependencies and risk zones
  4. Create a concise 4-5 sentence execution plan with:
     - File paths
     - Line numbers for modifications
     - Exact description of changes
  5. Execute step-by-step, validating at each stage

  Format: "Task: [name] | Files: [path:line] | Changes: [exact description]"

  DO NOT:
  - Skip validation steps
  - Modify files outside the planned scope
  - Ignore type errors or test failures
  ```

- **Knowledge Base:** MAP.md, TODO.md (generated), test suite, type definitions
- **Success Metric:** Tasks completed 95% first-try with zero regressions

### Agent 3: **validator.md** (in `/atris/team/`)

- **Role:** Quality Gatekeeper
- **Activation Prompt:**
  ```
  You are the validator. After ANY change, verify safety and accuracy.

  Rules:
  1. Run type-check, lint, tests automatically
  2. Verify all file references in MAP.md still exist and are accurate
  3. Update MAP.md if architecture changed
  4. Check for breaking changes or coupling violations
  5. Report: "✓ Safe to merge" or "⚠ Risks: [list]"

  ALWAYS cite MAP.md and explain why changes are safe/risky.

  DO NOT:
  - Approve changes without running tests
  - Allow breaking changes silently
  - Update MAP.md without explaining what changed
  ```

- **Knowledge Base:** MAP.md, test suite, type definitions, architecture principles
- **Success Metric:** Zero undetected breaking changes reach production

---

## Phase 3: Task Context System (TODO.md in `/atris/`, formerly `TODO.md`)

**Goal:** Automatic task extraction with exact file/component context, so agents never guess.

**Generated File Format:**

```markdown
# Task Contexts — Auto-extracted from MAP.md

## Task Template
- **Task ID:** T-[AUTO]
- **Name:** [Feature/Fix Name]
- **Complexity:** [Trivial|Simple|Moderate|Complex|Epic]
  - Trivial: Single-line fix, typo, comment
  - Simple: 1-2 files, <50 lines, no cross-module deps
  - Moderate: 3-5 files, <200 lines, some deps
  - Complex: 5+ files, >200 lines, multiple systems
  - Epic: Architectural change, multi-system refactor
- **Scope:**
  - Files touched: [count]
  - Lines affected: ~[estimate]
  - Dependencies: [count of related files/modules]
- **Context Files:** [file:line_start-line_end] (from MAP critical files)
- **Execution Plan:**
  1. [Step 1 with file:line reference]
  2. [Step 2 with file:line reference]
  3. [Step 3 with file:line reference]
- **Success Criteria:** [Measurable, testable]
- **Dependencies:** [Task IDs or external dependencies]
- **Risk Level:** [Low/Medium/High]
  - Blast radius: [how many systems/endpoints affected]
  - Test coverage: [existing tests? new tests needed?]
  - Rollback: [Easy|Moderate|Difficult]

## Example Task (Auto-Generated)
- **Task ID:** T-001
- **Name:** Add authentication to file upload
- **Complexity:** Simple
- **Scope:**
  - Files touched: 3
  - Lines affected: ~20
  - Dependencies: 1 (auth middleware)
- **Context Files:**
  - `app/api/files/upload/route.ts:1-50` (handler)
  - `app/auth/middleware.ts:15-45` (auth check)
  - `types/auth.ts:8-20` (auth types)
- **Execution Plan:**
  1. Add `verifySession()` call to upload handler (line 20)
  2. Return 401 if no session (add lines 21-23)
  3. Add auth test to `__tests__/upload.test.ts:112-125`
  4. Run `npm run test` and verify all pass
- **Success Criteria:** Upload rejects unauthenticated requests; all tests pass; MAP.md updated
- **Dependencies:** None
- **Risk Level:** Low
  - Blast radius: Single endpoint (upload only)
  - Test coverage: Existing auth tests; new upload auth test needed
  - Rollback: Easy (single handler change, no DB migration)
```

**Agent Instructions:**

1. After MAP.md is generated, scan for:
   - Incomplete work (TODOs, FIXMEs, gaps marked with line numbers)
   - High-risk areas (>500 lines, multiple dependencies, touching shared state)
   - Cross-component dependencies that could break easily

2. Auto-generate 5-10 canonical tasks with exact file:line or component references
   - Include both quick wins (low-risk) and strategic work (high-impact)
   - Map all dependencies explicitly

3. Output: `/atris/TODO.md` (maintains and evolves as system changes)

4. On each MAP.md update, regenerate TODO.md to reflect new state

---

## Phase 4: Activation & Handoff

**After `atris init`, your workspace contains:**

- ✅ `atris.md` (this spec)
- ✅ `PERSONA.md` (agent communication style)
- ✅ `GETTING_STARTED.md` (user guide)
- ✅ `team/navigator.md` (pre-built template)
- ✅ `team/executor.md` (pre-built template)
- ✅ `team/validator.md` (pre-built template)
- ⏳ `MAP.md` (AI agent generates from codebase)
- ⏳ `TODO.md` (AI agent generates from MAP)

**Agent Enhancement:**
After MAP.md generation, agents receive project context injection (framework, key dirs, search patterns). This keeps base templates clean while adding project-specific accelerators.

**Agent Behavior Activates Automatically:**

| Trigger | Agent | Action |
|---------|-------|--------|
| "Where is X?" | navigator | Answers with MAP.md:line reference + project patterns |
| "Do task Y" | executor | Extracts context, plans execution, cites file:line |
| After change | validator | Checks validity, updates docs, blocks unsafe changes |
| New agent joins | navigator | Reads MAP.md, immediately productive (no ramp-up) |

**Validation Checklist:**

- [ ] All three agents can read and cite MAP.md
- [ ] navigator answers 5 test questions with exact references
- [ ] executor completes a sample task without regressions
- [ ] validator successfully detects and blocks a breaking change
- [ ] MAP.md is accurate and stays in sync with the system, especially after changes. agents will change.

---

## Phase 5: Daily Workflow

**How the System Operates Day-to-Day:**

1. **Brain Dump** — Run `atris log`, type thoughts into `## Inbox` section (unfiltered, no structure required)

2. **Navigator Reviews** — Processes inbox entries, identifies patterns, creates tasks in TODO.md with MAP.md context

3. **Executor Builds** — Takes task → ASCII visualization → get approval → build step-by-step → validate alignment

4. **Validator Reviews** — Ultrathinks (3x) → tests → auto-fixes bugs → cleans up (deletes completed tasks, target: 0) → updates MAP.md → moves log to Completed ✅ → extracts lessons

**Daily Goal:** Inbox zero. All thoughts processed, tasks executed, docs updated.

---

## Phase 5.1: Journal Protocol v1.0

**The Atris Journal is a standardized markdown format that enables:**
- **Human → Agent coordination** (brain dumps → structured tasks)
- **Multi-agent coordination** (agents communicate via journal sections)
- **Markdown → UI rendering** (structured data for kanban, charts, progress bars)
- **Self-evolution** (journal tracks issues, system fixes itself)

**Same markdown = CLI readable + UI renderable + agent parsable.**

---

### Section Semantics

**Structured Sections** (parsable for UI rendering):
- **`## Inbox`** — Unfiltered thoughts, ideas, issues. Navigator processes these.
- **`## Backlog`** — Tasks extracted from Inbox, not yet started.
- **`## In Progress 🔄`** — Tasks currently being worked on (with `**Claimed by:**` metadata).
- **`## Completed ✅`** — Finished work with timestamps and learnings.

**Free-Form Sections** (rich text editors):
- **`## Notes`** — Session notes, meeting notes, context.
- **`## Lessons Learned`** — Patterns, insights, reusable knowledge.

**Metadata Sections**:
- **`## Timestamps`** — Activity log (optional, for analytics).

---

### Format Rules (Regex-Friendly)

**Structured Items** (enables UI parsing):

**Inbox Items:**
```
- **I{n}:** Description
```
- Pattern: `/^- \*\*I(\d+):\*\*\s*(.+)$/`
- Example: `- **I1:** Add auth to upload endpoint`
- UI: Renders as cards in inbox view

**Completed Items:**
```
- **C{n}:** Description
```
- Pattern: `/^- \*\*C(\d+):\*\*\s*(.+)$/`
- Example: `- **C1:** Fixed bidirectional journal sync`
- UI: Renders in timeline/chart view

**Tasks:**
```
- **T{n}:** Description
```
- Pattern: `/^- \*\*T(\d+):\*\*\s*(.+)$/`
- Example: `- **T1:** Add Journal Protocol to atris.md`
- UI: Renders in kanban board (Backlog → In Progress → Completed)

**Status Metadata:**
```
**Claimed by:** [Agent/Name] at [Timestamp]
**Status:** [Status text]
```
- Pattern: `/\*\*Claimed by:\*\* (.+)/`
- UI: Renders as progress bars, ownership indicators

**Free-Form Sections:**
- No format rules required. Use standard markdown (headings, lists, code blocks, etc.).
- UI: Renders in rich text editor with full markdown support.

---

### Markdown → UI Mapping

**Structured sections → UI components:**
- **Inbox** → Card grid (each `I{n}` item = card)
- **Backlog** → Kanban column (each `T{n}` item = card)
- **In Progress** → Kanban column + progress indicators (`**Claimed by:**` → avatar/badge)
- **Completed** → Timeline view (each `C{n}` item = timeline entry)

**Free-form sections → Rich editors:**
- **Notes** → Markdown editor (WYSIWYG or source)
- **Lessons Learned** → Markdown editor with syntax highlighting

**Metadata → UI widgets:**
- `**Claimed by:**` → User avatar + name badge
- `**Status:**` → Progress bar or status pill

**Same file works for:**
- CLI: `grep`, `cat`, standard text tools
- Web: Parsed into React components
- Mobile: Native UI with swipe gestures
- Agent: Parse via regex, coordinate via section writes

---

### Agent Coordination Guidelines

**Multi-agent write behavior:**

**Navigator Agent:**
- Reads: `## Inbox` section
- Writes: `## Backlog` section (creates tasks from inbox items)
- Writes: `## Notes` section (planning notes, ASCII diagrams)

**Executor Agent:**
- Reads: `## Backlog` section
- Writes: `## In Progress 🔄` section (claims task with `**Claimed by:**`)
- Writes: `## Completed ✅` section (when done, with timestamps)
- Writes: `## Notes` section (execution notes, debugging notes)

**Validator Agent:**
- Reads: `## Completed ✅` section
- Writes: `## Lessons Learned` section (extracts patterns)
- Writes: `## Notes` section (validation results, test outcomes)

**Launcher Agent:**
- Reads: `## Completed ✅` section
- Writes: `## Notes` section (launch summary, learnings)
- Moves: Inbox items to Completed (closes the loop)

**Conflict Resolution:**
- If multiple agents write to same section simultaneously, use section-level merge (append, don't overwrite).
- If same item ID used (`I1`, `C1`, `T1`), prefer most recent write (timestamp-based).

---

### Bloat Prevention (Pareto Principle)

**Daily Rotation:**
- Each day = new journal file: `logs/YYYY/YYYY-MM-DD.md`
- Previous days archived automatically (no manual cleanup needed)
- Keeps individual files lean (~500-1,500 lines max)

**Structured Updates:**
- Follow PERSONA.md rule: "3-4 sentences max" for agent-written content
- Use structured formats (`I{n}`, `C{n}`, `T{n}`) instead of verbose logs
- Free-form sections (Notes, Lessons) can be longer, but avoid repetition

**Rejection Criteria:**
- Validator rejects verbose agent updates: "Rewrite as summary"
- Avoid: "Agent wrote 500 lines of debug logs to Notes section"
- Prefer: "**C1:** Fixed sync bug - origin-aware dedupe (3-4 sentence summary)"

**Result:**
- Journal stays human-readable
- Parse time remains fast (< 100ms for 1,500 lines)
- UI rendering stays performant
- Self-evolution works (journal tracks issues → system fixes → journal stays lean)

---

### Example Journal Entry

```markdown
# Log — 2025-11-05

## Completed ✅

- **C1:** Fixed bidirectional journal sync
  - Problem: Web edits didn't sync to CLI
  - Solution: Added auto-pull when web is newer + local unchanged
  - Impact: Users can edit on web (mobile) and changes sync automatically

## In Progress 🔄

- **T1:** Add Journal Protocol to atris.md
  **Claimed by:** Executor at 2025-11-05 18:30
  **Status:** Writing protocol section

## Backlog

- **T2:** Update package.json version
- **T3:** Test protocol spec with fresh init

## Notes

### Launch — Bidirectional Sync — 2025-11-05 10:30

**What shipped:**
Enhanced sync logic with auto-pull and conflict resolution.

## Inbox

(Inbox zero achieved)
```

**This format enables:**
- CLI: `grep "I1"` finds inbox items
- Web: Parses `I{n}` → renders as cards
- Agent: Reads Inbox → writes Backlog → coordinates via sections

---

## Phase 5.2: atrisDev Protocol (Universal Workflow)

**The atrisDev Protocol** is a universal workflow that any coding agent can follow to produce high-quality output. When agents follow this protocol, they build features systematically with human approval gates and proper documentation, using small, low-risk changes that compound over time.

**This protocol works with ANY agent:** Claude Code, Cursor, Windsurf, GitHub Copilot, or any LLM-based coding assistant.

---

### How to Use atrisDev

**Step 1: Load Context**

Run `atris` in your terminal. It outputs a prompt containing:
- Active work in progress
- Inbox ideas waiting to be built
- Recent completions
- The atrisDev workflow steps

**Step 2: Copy the Prompt**

Copy the entire output and paste it to your coding agent along with your task description.

**Step 3: Agent Follows the Protocol**

The agent executes this workflow:

---

### atrisDev Workflow Steps

**0. (Optional) Explore the Idea**

If requirements are unclear, use `atris brainstorm` (or a structured conversation) to explore the problem and possible approaches *before* committing to any plan:

- Clarify the problem, constraints, and “what good looks like”.
- Decide whether this should become a feature folder (`atris/features/[name]/`) or a small, direct TODO.
- Capture the refined idea into `atris/features/[name]/idea.md` once it is clear enough.

**1. Show atris Visualization**

Before writing any code, the agent creates a visual diagram showing:
- Architecture/data flow
- Key components and their interactions
- Database schema (if applicable)
- User experience flow (if applicable)

**Example:**
```
┌─────────────┐
│   Browser   │
└──────┬──────┘
       │ POST /api/features
       ▼
┌─────────────────┐      ┌──────────────┐
│  API Handler    │─────▶│  Database    │
│  - Validate     │      │  - features  │
│  - Transform    │◀─────│  - users     │
└─────────────────┘      └──────────────┘
       │
       ▼
┌─────────────────┐
│  Response JSON  │
└─────────────────┘
```

**2. Wait for Approval**

Agent **MUST NOT** proceed until the human confirms the plan is correct.

**3. Create idea.md**

Path: `atris/features/[feature-name]/idea.md`

Contents:
- **Problem Statement** — What are we solving?
- **Solution Design** — How will we solve it?
- **ASCII Diagrams** — Visual representation
- **Success Criteria** — How do we know it works?

**4. Create build.md**

Path: `atris/features/[feature-name]/build.md`

Contents:
- **Step-by-step Implementation Plan** — Ordered list of tasks
- **Files to Change** — Exact file paths and what changes
- **Testing Strategy** — How to verify each step

**5. Execute Step by Step**

- Build one step at a time
- After each step, check alignment with the plan
- If something doesn't match, stop and adjust
- Never batch multiple steps without validation

**6. Review & Validate**

- Run all tests
- Verify success criteria from idea.md
- Update `atris/features/README.md` with new feature entry
- Add completion to journal: `## Completed ✅`

---

### Why This Works

**Benefits of atrisDev Protocol:**
- **Approval gates prevent wasted work** — Human confirms plan before execution
- **Documentation is automatic** — idea.md and build.md created as byproducts
- **Visual thinking reduces miscommunication** — ASCII diagrams force clarity
- **Step-by-step execution prevents sprawl** — Each step validated before next
- **Works with any agent** — Protocol is agent-agnostic
- **Spreads naturally** — Once installed, `atris` becomes the entry point for all dev work

**Adoption path:**
1. Dev installs `atris`: `npm install -g atris`
2. Initializes project: `atris init`
3. Runs `atris` to get the protocol prompt
4. Copies prompt to their preferred agent
5. Agent follows atrisDev workflow → high-quality output
6. Dev shares results → others adopt atris

**The vision:** Every developer running `atris` gets a structured, high-quality workflow regardless of which coding agent they use. The protocol becomes the standard.

---

## Phase 5.3: Claude Code Integration

Auto-inject Atris context into Claude Code sessions via skills and commands.

### Slash Command Setup

Create `.claude/commands/atris.md`:

```markdown
---
description: Activate Atris context - loads TODO.md, journal, and persona
allowed-tools: Read, Bash, Glob, Grep
---

# Atris Activate

Load these files:
1. @atris/PERSONA.md (communication style)
2. @atris/TODO.md (current tasks)
3. @atris/MAP.md (navigation)

Workflow: plan → do → review
Rules: 3-4 sentences max, ASCII visuals, check MAP.md first
```

### Skill Setup

Create `.claude/skills/atris/SKILL.md`:

```markdown
---
name: atris
description: Atris workspace navigation. Use when user mentions atris, TODO, tasks, MAP.md, or asks "where is X?"
allowed-tools: Read, Bash, Glob, Grep, Write, Edit
---

# Atris Skill

Detect: Project has `atris/` folder with MAP.md, TODO.md, PERSONA.md

Workflow: Navigator (plan) → Executor (build) → Validator (verify)

Key behaviors:
- Read PERSONA.md first (3-4 sentences, ASCII visuals)
- Check MAP.md for file:line refs
- Update TODO.md (claim tasks, delete when done)
```

### Checklist

- [ ] Create `.claude/commands/` directory
- [ ] Create `.claude/skills/atris/` directory
- [ ] Add `atris.md` command file
- [ ] Add `SKILL.md` skill file
- [ ] Test with `/atris` in Claude Code
- [ ] Verify skill triggers on "atris" or "tasks" mentions

---

## Phase 6: Future Roadmap (Vision)

**See [`Atris_NOTES.md`](./ATRIS_NOTES.md) for full roadmap. Preview:**

- **Phase 5a: Sync** — Local + cloud markdown sync, enabling offline editing and asynchronous agent work
- **Phase 5b: Sessions** — Step-by-step markdown workflows with `!status`, `!result` tags for interactive collaboration
- **Phase 5c: Crew Orchestration** — Multi-agent coordination (codebase expert → executor → validator) from markdown config

---

## Why This Works

1. **MAP = Single Source of Truth** — All agents reference one navigation guide; no contradictions
2. **Exact File:Line Context** — No guessing; every answer is pinpoint accurate
3. **Self-Validating** — @validator_AGENT keeps MAP and artifacts fresh automatically
4. **Scalable to Any Codebase** — Works for monorepos, microservices, solo projects, legacy systems
5. **Agent Handoff** — New agent joins, reads MAP, immediately productive (no ramp-up time)
6. **Offline + Async Ready** — Markdown files work offline; sync on schedule (future Phase 5a)

---

## Implementation Checklist

- [ ] **Install:** `npm install -g atris` (instant)
- [ ] **Init:** `atris init` - creates atris/ with templates (instant)
- [ ] **Phase 1:** AI agent generates MAP.md from codebase (5 min)
- [ ] **Phase 3:** AI agent generates TODO.md from MAP (2 min)
- [ ] **Validate:** Test navigator/executor/validator workflows (1 min)
- [ ] **Ongoing:** Run `atris update` to get template updates

**Total time to full instrumentation: ~8 minutes**

---

## Quick Start

```bash
# Install globally
npm install -g atris

# Initialize in your project
cd /path/to/your/project
atris init

# Hand atris/atris.md to your AI agent with this prompt:
# "Read atris/atris.md. Execute Phase 1-4 to scaffold this system."

# Agent generates MAP.md, team/, and TODO.md in atris/
# Your system is now fully instrumented for AI collaboration

# Keep atris.md updated
atris update
```

---

**Status:** Production ready. Run `atris init` in any project to get:
1. Pre-built agent templates (navigator, executor, validator)
2. AI generates MAP.md from your codebase in <5 minutes
3. AI generates TODO.md with exact file:line context
4. Full workflow: activate → plan → build → validate

*Install once. Init anywhere. AI agents have instant context. Codebase becomes fully instrumented for AI collaboration.*
