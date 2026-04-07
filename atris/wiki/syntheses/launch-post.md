---
type: synthesis
slug: launch-post
title: LinkedIn launch — atris/wiki/ as personal AGI substrate
sources: [
  atris/wiki/syntheses/atris-as-mini-agi.md,
  atris/wiki/concepts/wiki-as-memory-substrate.md,
  atris/wiki/concepts/mini-agi.md,
  atris/features/wiki/idea.md
]
created: 2026-04-07
updated: 2026-04-07
tags: [launch, marketing, agi]
---

# LinkedIn Launch — atris/wiki/

Three drafts. Personal angle is recommended. The synthesis page `atris/wiki/syntheses/atris-as-mini-agi.md` is the proof point — link to it.

---

## Option A — Personal / first-person (RECOMMENDED)

> I've been thinking about why every Claude session feels like talking to someone with amnesia.
>
> The model is smart. The conversation is great. Then it ends, and tomorrow's session starts cold. Nothing you taught it persists. Nothing compounds.
>
> The fix isn't a bigger model. It's a substrate for memory.
>
> Today we shipped `atris/wiki/` — a local-first, markdown-based brain folder that lives in every project. One command — `atris ingest <source>` — turns raw material into structured knowledge. The next agent that opens the project reads it on session start.
>
> The trick isn't the wiki. It's who maintains it. Vannevar Bush imagined a personal knowledge store called the Memex in 1945, but couldn't solve who would keep it current. The answer 80 years later: **the LLM is the librarian.** Same intelligence reads and writes. Maintenance cost drops to zero.
>
> Without this, every Atris feature — autopilot, connectors, team agents — resets every session. With it, they compound. Tomorrow's Claude wakes up knowing yesterday.
>
> I had Claude run a self-assessment using the new wiki. Its conclusion: atris is "one good loop away" from being a real mini-AGI. The missing piece? Continuous auto-ingest that watches every change and updates the wiki without being asked. We're shipping that next.
>
> I don't think AGI ships as a smarter model. I think it ships as a substrate that makes the model you already have **persist, accumulate, and compound.**
>
> That's what we just built.

---

## Option B — Convergence angle

> **Three AI builders this week independently shipped the same answer to AGI's biggest problem.**
>
> The problem isn't model intelligence. It's that every Claude session starts cold. Yesterday's session doesn't know what today's session learned.
>
> This week, Andrej Karpathy published a gist describing his personal LLM wiki. The MemPalace team open-sourced a memory system that scored 96.6% on the LongMemEval benchmark. A book author on X posted about his trust-weighted reference system built from 1,000+ YouTube videos and pre-LLM research notes.
>
> Three angles. Same insight: **memory belongs in the filesystem, not the model.**
>
> Today we shipped this as part of Atris: `atris/wiki/`. One command — `atris ingest <source>` — turns raw material into structured knowledge. The folder lives in every project, gets versioned by git, and any agent reads it on session start.
>
> The killer move isn't the wiki. It's who maintains it. Vannevar Bush imagined the Memex in 1945 but couldn't solve who would keep it current. The answer 80 years later: **the LLM is both the librarian and the reader.** Maintenance cost drops to zero.
>
> AGI doesn't ship as a smarter model. It ships as a substrate that makes the model you already have **persist, accumulate, and compound across time.**
>
> Try it: `atris ingest <source>`

---

## Option C — Contrarian / sharp angle

> Everyone's training bigger models. We just shipped what they actually need.
>
> AGI's bottleneck isn't intelligence. It's persistence. Every Claude session is brilliant and amnesiac. The model is smart per token; the system forgets across days.
>
> The fix has been hiding in plain sight since 1945, when Vannevar Bush sketched the Memex — a personal knowledge store with associative trails maintained by a librarian. Bush couldn't solve who the librarian would be. Karpathy's gist this week answered that 80 years later: **the LLM is both librarian and reader.**
>
> Today we shipped this in Atris as `atris/wiki/` — a local-first markdown brain that lives in every project, gets versioned by git, and is maintained by the same intelligence that reads it.
>
> Three independent builders converged on this exact pattern this week. Karpathy's gist, the MemPalace benchmark, and a book author's trust-weighted reference system. Different code, same insight.
>
> The killer abstractions always look unimpressive. Unix was just a filesystem. The web was just hypertext. The wiki is just markdown. They're killer because they're enough.
>
> AGI ships as a substrate, not a checkpoint.

---

## Recommendation

**Ship Option A.** Reasons:

1. First-person + Memex is the most shareable + memorable
2. The "I had Claude run a self-assessment" line is a hard proof point — links to a real artifact (`atris/wiki/syntheses/atris-as-mini-agi.md`) that anyone can read
3. The "one good loop away" narrative gives a sequel — readers want to see the next post
4. Founder-voice feels honest, not marketing
5. Shorter than B, less contrarian than C — broad appeal without losing edge

## Posting checklist

- [ ] Wait for v1.5 to ship (so the "we're shipping that next" line is true / about-to-be-true)
- [ ] Link in comment: github.com/[atris-cli repo URL]
- [ ] Tag: @karpathy if shipping the convergence angle (B)
- [ ] Image idea: a screenshot of `atris activate` showing the new "🧠 Wiki:" line, or the ASCII tree of `atris/wiki/`
- [ ] Time of post: Tuesday or Wednesday morning PT for max engagement
- [ ] Cross-post to X with tighter version (~280 char hook + thread)

## Cross-References

- [[atris/wiki/syntheses/atris-as-mini-agi.md]] — the proof point Claude generated
- [[atris/wiki/concepts/wiki-as-memory-substrate.md]] — the architectural argument
- [[atris/features/wiki/idea.md]] — what shipped
- [[atris/features/wiki-v2/idea.md]] — what's next
