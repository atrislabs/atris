---
name: memory
description: Search and reason over Atris journal history. Use when user asks about past work, decisions, history, or patterns. Uses RLM pattern (grep first, reason second).
---

# Atris Memory Skill

Search and reason over Atris journal history using the RLM pattern (grep first, reason second).

## When to Activate

User asks about:
- Past work, decisions, history
- "Remember when...", "How did we...", "Why did we..."
- Patterns, failures, lessons learned
- "What have we tried before?"
- Anything requiring historical context

## Journal Locations

```
atris/logs/YYYY/YYYY-MM-DD.md
```

Structure of each journal:
- `## Inbox` - Raw ideas (I1, I2, ...)
- `## In Progress 🔄` - Active work
- `## Backlog` - Deferred work
- `## Notes` - Session summaries, brainstorms
- `## Completed ✅` - Finished work (C1, C2, ...)

## Search Strategy (RLM Pattern)

**Step 1: Grep first (cheap, fast)**
```bash
# Find keyword matches
grep -r "keyword" atris/logs/ --include="*.md"

# With context
grep -r -C 3 "keyword" atris/logs/ --include="*.md"

# Multiple terms
grep -r -E "auth|login|token" atris/logs/ --include="*.md"
```

**Step 2: If few matches (< 10), read directly**
- Use Read tool on matching files
- Synthesize answer yourself

**Step 3: If many matches (10+), use subagent**
```
Task(haiku): "Analyze these journal entries and find patterns related to [query]:
[paste relevant grep results]"
```

**Step 4: For complex synthesis**
- Chunk results by time period or topic
- Spawn multiple haiku subagents
- Aggregate findings

## Example Flows

### Simple: "When did we add feature X?"
```
1. grep -r "feature X" atris/logs/
2. Read the matching file
3. Answer: "Added on 2025-01-02, see C3 in that day's journal"
```

### Medium: "What auth issues have we had?"
```
1. grep -r -E "auth|login|token|credential" atris/logs/
2. Found 15 matches across 8 files
3. Read the 3 most recent matches
4. Task(haiku): "Categorize these auth-related entries: [entries]"
5. Synthesize into answer
```

### Complex: "Why do reviews keep failing?"
```
1. grep -r -E "fail|❌|reject|REVIEW" atris/logs/
2. Found 30+ matches
3. Task(haiku): "What are the failure reasons in: [chunk 1]"
4. Task(haiku): "What are the failure reasons in: [chunk 2]"
5. Aggregate: "78% missing tests, 22% outdated MAP.md"
```

## Key Patterns to Search

| Looking for | Grep pattern |
|-------------|--------------|
| Completed work | `Completed\|✅\|C[0-9]+:` |
| Failures | `fail\|❌\|reject\|block` |
| Decisions | `decided\|decision\|chose\|pivot` |
| Ideas | `Inbox\|I[0-9]+:\|idea\|maybe` |
| Technical debt | `debt\|todo\|hack\|fixme\|refactor` |

## Cost Efficiency

- Grep: Free, instant
- Read: Counts against context, use sparingly
- Task(haiku): ~$0.001, use for semantic analysis
- Task(sonnet): ~$0.01, use only if haiku insufficient

Always grep first. Only escalate to LLM when you need reasoning, not retrieval.
