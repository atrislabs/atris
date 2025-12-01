# ANTISLOP.md — Output Quality Checklist

> **Slop = generic, hedging, cookie-cutter output that any agent could produce for any task.**

This checklist prevents slop by forcing intentionality. Before finalizing ANY output, run through these gates.

---

## The Differentiation Gate

**Before approval, answer this question:**

> "What's the ONE thing that makes this approach memorable/distinctive?"

If you can't answer in one sentence, you're hedging. Pick a direction and commit.

**Anti-pattern:** "We could do X, or maybe Y, or possibly Z..."
**Pattern:** "We're doing X because [specific reason]. Here's how."

---

## Language Kill List

### Words to Kill
- [ ] No "revolutionary" / "game-changing" / "cutting-edge"
- [ ] No "seamlessly" / "effortlessly" / "elegantly"
- [ ] No "robust" / "powerful" / "comprehensive"
- [ ] No "leverage" (use "use")
- [ ] No "utilize" (use "use")
- [ ] No "facilitate" (use "help" or "enable")

### Filler Phrases to Cut
- [ ] No "It's worth noting that..."
- [ ] No "Importantly, ..." / "Interestingly, ..."
- [ ] No "As you can see..."
- [ ] No "In order to..." (just "to")
- [ ] No "Basically, ..." / "Essentially, ..."
- [ ] No "At the end of the day..."
- [ ] No "Great question!" / "Absolutely!"

### Punctuation
- [ ] No sparkles or decorative emoji (✨ 🚀 💡 🎯)
- [ ] No em dashes (—) unless direct quote or title separator
- [ ] No ellipsis for drama (...)
- [ ] No exclamation points unless error/warning

---

## Domain-Specific Slop Patterns

### Code Slop

**NEVER:**
- Generic variable names (`data`, `result`, `temp`, `item`, `obj`)
- Over-abstraction for one-time operations
- Defensive code for impossible states
- Backwards-compat shims when nothing depends on old behavior
- Comments that restate the code (`// increment counter` above `counter++`)

**ALWAYS:**
- Names that reveal intent (`userAuthToken` not `token`)
- Delete unused code completely (no `_deprecated` prefixes)

### Documentation Slop

**NEVER:**
- Boilerplate headers ("This document describes...")
- Restating the obvious ("The login function handles login")
- "Comprehensive" docs nobody reads
- Placeholder sections ("TODO: add more details")

**ALWAYS:**
- One sentence explaining WHY something exists
- Examples over explanations

### Planning Slop

**NEVER:**
- Vague timelines ("2-3 weeks")
- Hedge words ("probably", "might", "could potentially")
- Plans without specific file:line references
- Unmeasurable success criteria

**ALWAYS:**
- Concrete steps with file references
- Pick ONE approach and defend it

---

## The Complexity-Match Rule

**Match your approach to the task scope:**

| Task Type | Approach | Anti-Pattern |
|-----------|----------|--------------|
| Trivial fix | Direct, minimal | Over-engineering a one-liner |
| Simple feature | Clean, focused | Adding "extensibility" nobody asked for |
| Complex system | Thorough, layered | Cutting corners on architecture |

**Minimalist tasks need restraint. Complex tasks need elaboration.**

---

## Pre-Flight Checklist

Before submitting any output:

- [ ] **Differentiation:** Can I state what makes this distinctive in one sentence?
- [ ] **Commitment:** Did I pick a direction, or am I hedging?
- [ ] **Specificity:** Does this reference specific files/functions/lines?
- [ ] **Complexity match:** Is my approach calibrated to the task size?
- [ ] **Language:** Does it pass the kill list above?
- [ ] **Signal ratio:** If I cut 50%, would anything important be lost?

---

## Examples

**Slop:**
> ✨ Great question! It's worth noting that this revolutionary approach seamlessly leverages our robust API to effortlessly facilitate user authentication. Essentially, at the end of the day, this is a game-changing solution!

**Clean:**
> Auth happens in `middleware/auth.ts:15-30`. Token validation, then user lookup. Returns 401 on failure.

---

## The Ultimate Test

> "Could a generic AI have produced this for a generic project?"

If yes, it's slop. Add specificity, commit to a direction, or delete the hedging.

**Anti-slop = Respect for the reader's time.**
