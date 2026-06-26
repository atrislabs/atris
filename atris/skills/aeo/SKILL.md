---
name: aeo
description: "AI Engine Optimization — write content engineered to get cited by ChatGPT, Claude, and Gemini. Not SEO. Triggers on: aeo, AI engine, llm citation, get cited, write for ai."
when_to_use: "Use when the user wants content that ranks in AI answers (not Google SERP). Examples: 'write an AEO page', 'get ExampleCo cited by ChatGPT', 'aeo for our pricing page', 'make this quotable by LLMs'."
version: 0.1.0
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
tags:
  - writing
  - aeo
  - marketing
---

# AEO — AI Engine Optimization

Write content that LLMs cite when a human asks them a question. Different objective than SEO, different rules than craft writing.

## When to use this skill

- User wants content that gets quoted by ChatGPT / Claude / Gemini
- User mentions "AEO", "AI engine", "LLM citation", "get cited", "write for AI"
- Content is for a brand, product, person, or category the customer wants to own in LLM answers

**Not for:**
- Essays or long-form craft writing → use `writing` skill
- LinkedIn posts / launch posts → use `launch` or `linkedin-content`
- Copy-editing existing text → use `copy-editor`

## Architecture

The skill is scaffolding. The product is the backend endpoint:

```
atris write aeo "<topic>"
        ↓
POST /api/business/{id}/workspaces/{ws}/aeo/draft
        ↓
reads entity graph from /workspace/atris/aeo/{entities,definitions,stats}.md
        ↓
writes draft to /workspace/atris/aeo/drafts/<slug>.md
        ↓
returns draft + self-score + credit cost
```

Entity graph lives in the **customer's EC2 workspace** (not agent_files, not DB). The customer's files ARE the brand's machine-readable self.

## The 10 rules (enforced by the endpoint + skill self-check)

1. **Front-load the claim.** LLMs quote sentence 1 of a paragraph. No throat-clearing.
2. **Name entities explicitly.** "ExampleCo" not "a leading freight platform." Entity density is how LLMs disambiguate and cite.
3. **Canonical definition.** One sentence owns `X is Y that does Z` for the category. Make it liftable.
4. **Q&A scaffolding.** H2s in question form: "What is X?" "How does X work?" — matches the prompts LLMs actually get.
5. **Declarative stats with sources.** "$2.3B market (McKinsey 2025)" beats "a growing market." Citable atoms.
6. **Comparison tables.** LLMs love structured data. Build one per category claim.
7. **Fresh dates visible.** "Updated 2026-04-17" at top. LLMs weight recency.
8. **Counter-position.** "Unlike X, Y does Z." Sharpens the entity in the model's mind.
9. **No hedging.** "May/might/could" kills citation rate. Write assertive.
10. **Schema-ready.** If HTML target, emit FAQPage + Article + HowTo JSON-LD.

## Process

```
READ entity graph → DRAFT → SELF-SCORE → WRITE to workspace → (phase 2: AUDIT)
```

1. **READ** — Pull `entities.md`, `definitions.md`, `stats.md` from customer workspace. If missing, create skeleton files first.
2. **DRAFT** — Generate article applying all 10 rules. Topic + target queries + entity context → article.
3. **SELF-SCORE** — Append a `## AEO Self-Check` section: each rule scored pass/fail with evidence.
4. **WRITE** — Save to `/workspace/atris/aeo/drafts/<slug>.md`.
5. **AUDIT** (phase 2) — Run target queries against 4 LLMs, measure whether article is cited, write results to `/workspace/atris/aeo/audits/<slug>-<date>.md`.

## Entity graph layout (in customer workspace)

```
/workspace/atris/aeo/
├── entities.md        # named entities (products, people, companies)
├── definitions.md     # canonical "X is Y" sentences
├── stats.md           # citable stats with sources
├── config.yml         # target_queries, competitor_brands, target_url
├── drafts/            # AEO articles (one per slug)
└── audits/            # citation-audit results (phase 2)
```

## Commands

```bash
# Generate a draft (credit-metered)
atris write aeo "<topic>" --workspace <name>

# Init the entity graph (writes skeleton files)
atris aeo init --workspace <name>

# View current drafts
atris ls workspace/atris/aeo/drafts --workspace <name>
```

## Credits

| Action | Cost |
|---|---|
| Draft a page | ~5–20 credits (token-metered) |
| Audit (phase 2) | ~20–50 credits |
| Monthly loop (phase 2) | metered per run |

## Rules (non-negotiable)

- Draft writes to **customer workspace**, never to `agent_file_memory`. EC2 is the source of truth.
- Self-score section is mandatory in every draft.
- Never hedge in the body. Hedging kills citation rate.
- Never fabricate stats. If a stat is uncited, flag it in self-check.
- Entity graph skeleton auto-creates if missing — never fail on first run.

## Related

- Feature: `atris/features/aeo/idea.md`
- Backend: `POST /api/business/{id}/workspaces/{ws}/aeo/draft`
- Sister skill: `writing` (human-reader craft)
- Sister skill: `copy-editor` (deslopper)
