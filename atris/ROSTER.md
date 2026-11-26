# Workspace roles

> Pick the job before the engine. A role describes the work and the evidence that completes it. Several people or agents can hold the same role.

> Use search to find a fact, file or source. Choose purposeful search when the findings must answer a named decision. Use computer use to carry out a known sequence and verify the resulting screen or record. Choose important computer decisions when the next action involves a meaningful choice of target, consequence or recovery path. Roughly 80% routine computer work is a planning estimate. Route individual actions by their purpose.

> Use interoperability to translate between systems, formats or languages while preserving meaning. Build owns code generation, execution and the evidence that the result works.

## search
- codex, model: gpt-6.1-terra, effort: low
- claude code, model: haiku 5.5

## purposeful search (like search)
- codex, model: gpt-6.2-sol, effort: xhigh

## computer use (like build)
- codex, model: gpt-6.1-terra, max: 45 min
- devin, model: swe-2-medium

## important computer decisions (like review)
- codex, model: gpt-6.2-sol, effort: xhigh

## interoperability (like build)
- agy, model: gemini-4-neon-medium

## build
- claude code, model: opus 5.5, max: 45 min
- codex, model: gpt-6.1-terra, max: 45 min
- claude code, model: sonnet 5.5, max: 45 min

## small build
- claude code, model: opus 5.5, max: 20 min
- grok, model: grok 4.7 fast, max: 20 min

## team
- scout: search
- navigator: search
- researcher: purposeful search
- replay-lead: purposeful search
- computer-operator: computer use
- computer-lead: important computer decisions
- interop-translator: interoperability
- builder: build
- executor: build
