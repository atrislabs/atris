# Atris Documentation

Documentation for the Atris system: idea → build → ship.

---

## Structure

> ⚠️ **DEPRECATED:** This documentation is outdated. Use `atris/features/` instead.
>
> See `atris/features/README.md` (and `TODO.md` in your project) for current documentation and workflow.

**Old structure (deprecated):**
```
docs/
├── README.md (you are here - OUTDATED)
├── features/ (MOVED to atris/features/)
├── examples/ (reference examples)
└── templates/ (MOVED to atris/features/_templates/)
```

**New structure:**
```
atris/
└── features/
    ├── README.md (current documentation)
    ├── _templates/
    │   ├── idea.md.template
    │   └── build.md.template
    └── [feature-name]/
        ├── idea.md
        └── build.md
```

---

## The Atris Bridge: idea.md → build.md

**idea.md** (Human Layer)
- Messy, conversational thinking
- No structure required
- Questions, alternatives, uncertainty welcome
- Gets refined through parser confirmation

**build.md** (Agent Layer)
- Clean, technical execution plan
- Structured with precise steps
- Token-efficient, unambiguous
- Any agent can read and execute

---

## Creating a New Feature

1. **Run atris:**
   ```bash
   atris  # or atris plan
   ```
   Describe what you want, agent creates the feature folder automatically.

   **Or manually copy templates:**
   ```bash
   mkdir atris/features/your-feature-name
   cp atris/features/_templates/idea.md.template atris/features/your-feature-name/idea.md
   cp atris/features/_templates/build.md.template atris/features/your-feature-name/build.md
   ```

2. **Write your idea:**
   - Open `idea.md`
   - Think out loud, be messy
   - Describe what you want to build

3. **Hand to agent:**
   - Agent reads `idea.md`
   - Shows ASCII confirmation
   - You approve

4. **Agent generates build plan:**
   - Agent writes `build.md` (silently)
   - Structured technical spec

5. **Agent executes:**
   - One step at a time
   - ASCII progress after each step
   - You confirm before proceeding

6. **Ship:**
   - Final ASCII summary
   - You approve
   - Docs update automatically

---

## Naming Conventions

**Feature folders:** `kebab-case-feature-name/`
- Examples: `bidirectional-sync/`, `ascii-first-output/`, `rate-limiting/`

**Files:** Always `idea.md` and `build.md`
- Consistent across all features
- Easy to find, easy to remember

**Bugs:** No docs needed (just fix and move on)
- Complex bugs: create `docs/bugs/bug-name/build.md` only
- Simple bugs: fix in code, no documentation

---

## Key Principles

1. **idea.md evolves** — Change your mind, iterate, refine
2. **build.md is deterministic** — Same input → same output
3. **Parser bridges the gap** — Organizes messy → clean
4. **ASCII confirms intent** — Visual checkpoints prevent surprises
5. **One step at a time** — No overwhelming dumps

---

## Examples

See `docs/examples/` for complete worked examples:
- New feature (complex, multi-step)
- Bug fix (simple, targeted)
- Enhancement (medium, iterative)

Each shows the full flow: idea → parser → build → execution.

---

**The goal:** Make it easy to go from idea to shipped feature. The bridge is the magic.
