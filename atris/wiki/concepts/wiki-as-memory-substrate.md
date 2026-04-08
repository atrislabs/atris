---
type: concept
slug: wiki-as-memory-substrate
title: Wiki as Memory Substrate
sources: [/Users/keshavrao/arena/atris-cli/lib/wiki.js, /Users/keshavrao/arena/atris-cli/commands/wiki.js, /Users/keshavrao/arena/atris-cli/atris/skills/wiki/SKILL.md]
created: 2026-04-07
updated: 2026-04-07
tags: [memory, wiki, atris]
---

# Wiki as Memory Substrate

The `atris/wiki/` folder is the durable memory layer beneath the Atris loop. It is **not** a docs site. It is the closest thing to a "world model" the local Atris stack has.

## Why it exists

Without the wiki, every Atris session starts cold. MAP.md tells you *where* code lives. TODO.md tells you *what's queued*. The journal tells you *what happened today*. But none of those tell you **what this thing is** or **why** decisions were made. The wiki is meant to be the layer where raw artifacts (videos, calls, docs, threads) get distilled into entities, concepts, and syntheses the next agent can pick up cold.

## Three page types

| Type | Folder | Purpose |
|---|---|---|
| **entity** | `entities/` | One page per person, company, project, or system |
| **concept** | `concepts/` | Patterns, frameworks, recurring ideas |
| **synthesis** | `syntheses/` | Cross-cutting analyses referencing 3+ pages |

Plus four index files at the root: `wiki.md` (protocol), `index.md` (catalog), `log.md` (append-only history), `STATUS.md` (plain-English health).

## Three verbs

| Verb | What it does |
|---|---|
| **ingest** | Read sources fully, merge into pages, never wipe; update index/log/STATUS in same pass |
| **query** | Read `index.md` first, open only relevant pages, answer with path refs |
| **lint** | Find broken refs, orphans, contradictions, gaps; rewrite STATUS, append LINT entry |

## Two modes

- **Local** (default) — `atris wiki ...` prints a prompt for the current coding agent to execute against `atris/wiki/` in the repo. The agent (me) does the actual work.
- **Cloud** (`--cloud`) — routes to a business workspace via the `/business/{id}/chat` API; `atris pull --only wiki` syncs back.

## Page format (frontmatter contract)

```yaml
---
type: entity | concept | synthesis
slug: short-id
title: Human Readable
sources: [path/to/source1.md]
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags: [tag1, tag2]
---
```

Body in markdown. Cross-refs as `[[atris/wiki/...]]` links. Always close with a `## Cross-References` section.

## Where it sits in the loop stack

The wiki is the **memory** layer. The MAP is the **navigation** layer. The team is the **action** layer. The autopilot loop is the **execution** layer. Stack:

```
       team / personas        (action)
            ▲
            │
       autopilot loop         (execution)
            ▲
            │
   ┌────────┴────────┐
   │   MAP.md         │       (navigation)
   │   wiki/          │       (memory)  ← what this concept is about
   └────────┬────────┘
            ▼
        artifacts             (substrate)
   (code, journal, sources)
```

For atris-cli to become self-reflective, this layer has to actually exist and be queryable. Right now (2026-04-07) it has 6 pages and is being populated for the first time as a test of the loop.

## Honest limits

- It's still hand-written markdown, not embeddings — `query` is just "open the right files"
- No automatic ingestion — sources only land here when an agent decides to write them
- No proactive surfacing — nothing watches for stale pages or rotting refs except `lint` (which runs on demand)
- No causal model — captures *what is*, not *what causes what*

## Cross-References

- [[atris/wiki/systems/atris-cli.md]] — the project this wiki lives inside
- [[atris/wiki/systems/atris-business.md]] — sibling product where the wiki has a cloud counterpart (`context/`)
