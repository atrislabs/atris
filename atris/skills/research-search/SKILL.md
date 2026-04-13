---
name: research-search
description: "Fast research sweep — arxiv, semantic scholar, github, web. Finds papers, scores relevance, extracts actionable insights, stores to wiki. Triggers on: research search, find papers, latest research, arxiv, what's new in, sweep papers, research sweep."
version: 1.0.0
tags:
  - research
  - arxiv
  - papers
  - knowledge
  - ingestion
---

# /research — Fast Research Sweep

Find the latest research on a topic, score it for relevance, extract what you can BUILD with it, store the best finds.

## Usage

```
/research <topic>                     # Sweep a topic, show top results
/research <topic> --ingest            # Sweep + store best finds to wiki
/research <topic> --deep <arxiv-url>  # Deep-read a specific paper
/research --sweep                     # Run all topics from program.md
/research --trending                  # What's hot this week in your areas
```

## On invoke

### Step 0: Load the research program

Read `atris/skills/research/program.md` for:
- Active research topics (what to search for)
- Scoring criteria (what makes a paper relevant)
- Date window (default: last 6 months)
- Prior results from `atris/skills/research/results.tsv`

### Step 1: Multi-source search

For the given topic, search ALL of these sources in parallel (use Agent tool for parallelism):

**Source A — arxiv API**
Run via Bash:
```bash
python3 atris/skills/research/arxiv_search.py "<topic>" --after 2025-10-01 --limit 20
```
Returns JSON array of papers with title, authors, abstract, date, url, categories.

**Source B — Semantic Scholar API**
Run via Bash:
```bash
python3 atris/skills/research/scholar_search.py "<topic>" --after 2025-10-01 --limit 20
```
Returns JSON array with title, authors, abstract, date, url, citation count, venue.

**Source C — Web search**
Use WebSearch tool: `"<topic>" site:arxiv.org OR site:github.com 2025..2026`

**Source D — GitHub**
Use WebSearch tool: `"<topic>" site:github.com stars:>100 pushed:>2025-10-01`

### Step 2: Deduplicate and rank

Merge results from all sources. Deduplicate by title similarity.

For each paper, score 1-10 on:
- **Relevance**: Does this directly apply to our research program?
- **Recency**: Published in the target date window?
- **Actionability**: Can we BUILD something with this? Not just theory?
- **Novelty**: Is this a new technique, or incremental on known work?

Compute total = (relevance * 3 + actionability * 3 + recency * 2 + novelty * 2) / 10

### Step 3: Present results

Show a ranked table:

```
# Research Sweep: <topic>
## Date: YYYY-MM-DD | Sources: arxiv, scholar, web, github | Papers found: N

| # | Score | Title | Date | Key Insight | Source |
|---|-------|-------|------|-------------|--------|
| 1 | 9.2   | ...   | ...  | ...         | arxiv  |
| 2 | 8.5   | ...   | ...  | ...         | scholar|
```

For the top 5, show:
- **One-line insight**: What's the actionable takeaway
- **Applies to**: Which of our projects/experiments this helps
- **Build it**: What we'd actually implement

### Step 4: Deep read (optional, on request or --ingest)

For papers the user selects (or top 3 if --ingest):

1. Use WebFetch to read the full arxiv abstract page
2. If PDF: note the URL for manual reading, extract what you can from abstract + related work
3. Extract:
   - Core technique (one paragraph)
   - Key results (numbers, benchmarks)
   - How to implement at inference time (if applicable)
   - Dependencies (what you need: fine-tuning? API access? special hardware?)
   - Limitations the authors acknowledge

### Step 5: Store (if --ingest)

Write each top paper to `atris/wiki/research/<slug>.md`:

```markdown
---
title: <paper title>
source: <arxiv/scholar/github url>
date: <publication date>
relevance_score: <1-10>
last_compiled: <today>
tags: [<topic tags>]
---

# <Paper Title>

**Authors:** ...
**Published:** ...
**URL:** ...

## Core Technique
<one paragraph>

## Key Results
<bullet points with numbers>

## How to Use (Inference-Time)
<practical implementation notes>

## Applies To
<which of our projects benefit>

## Limitations
<what the authors say doesn't work>
```

Update `atris/wiki/index.md` with the new pages.

### Step 6: Log

Append to `atris/skills/research/results.tsv`:
```
timestamp  topic  papers_found  top_score  top_paper  source_breakdown
```

Over time, this log shows which topics are producing the best finds and which sources are most useful.

## RL Integration

The research program evolves:
1. After each sweep, note which papers scored highest and from which source
2. If a paper leads to a successful implementation (tracked via /storysim or /autoresearch), boost that topic's weight
3. If a sweep produces nothing actionable, refine the search queries
4. The program.md file is the "policy" — update it as you learn what works

## Rules

- Date filter is HARD. Do not include papers outside the configured window.
- Actionability > novelty. A mediocre paper you can build with beats a brilliant paper you can't.
- No summaries without sources. Every claim needs a URL.
- Prefer papers with code (GitHub links, "code available at...").
- Don't deep-read everything. Score first, read the top 3-5.
- If a paper requires fine-tuning and the user only has API access, flag it clearly.
