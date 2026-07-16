---
name: design
description: Frontend aesthetics policy. Use when building UI, components, landing pages, dashboards, or any frontend work. Prevents generic ai-generated look.
version: 3.0.0
allowed-tools: Read, Write, Edit, Bash, Glob
tags:
  - design
  - frontend
---

# atris-design

The taste organ of the Atris system. Opinionated: these are Keshav's principles, not general best practices. Prevents ai-generated frontend from looking generic, and improves itself (see "self-improve" at the bottom, it is part of the job, not optional).

Canonical home: `atris-cli/atris/skills/design/SKILL.md` (this file, git-tracked). `atris sync` stamps it into every workspace's `atris/skills/` and `.claude/skills/`. Edit HERE, never a downstream copy: sync will clobber anything written elsewhere.

## Atris Integration

1. Check `atris/MAP.md` for existing patterns before building
2. **Read `atris/policies/design-seed.md` first** if it exists: it has the project's unique visual identity (fonts, colors, spacing, motion). This is the design DNA. Do not override it with defaults.
3. Read `.atris/theme.json` if it exists: brand colors and fonts are already decided, use them.
4. Reference `atris/policies/atris-design.md` for full anti-slop guidance
5. After building, run the workspace design gate (`npm run audit:design` in atrisos-web, `atris slop` elsewhere) before claiming done.

## Quick Reference

**Typography:** avoid inter/roboto/arial/system fonts. pick one distinctive font, use weight extremes (200 vs 800). size jumps should be dramatic (3x). use `clamp()` for fluid sizing. use `ch` units for measure (`max-width: 65ch`).

Font alternatives: instead of Inter: Instrument Sans, Plus Jakarta Sans, Outfit. Instead of Roboto: Onest, Figtree, Urbanist. Editorial: Fraunces, Newsreader, Lora.

**Color:** commit to a palette. use OKLCH for perceptually uniform colors. tint your neutrals toward your brand hue (never pure gray). never put gray text on colored backgrounds. never use pure black (#000) or pure white (#fff). avoid the AI palette: cyan-on-dark, purple-to-blue gradients, neon accents on dark.

```css
--brand: oklch(65% 0.2 250);
--gray-100: oklch(95% 0.01 250); /* tinted, not pure gray */
```

**Layout:** break the hero + 3 cards + footer template. no card-in-card nesting. no identical card grids. asymmetry is interesting. dramatic whitespace. use container queries for component-level responsiveness. fluid spacing with `clamp()`.

**Motion:** one well-timed animation beats ten scattered ones. use exponential easing (`cubic-bezier(0.25, 1, 0.5, 1)`), never bounce/elastic. 150-300ms duration. only animate transform and opacity. always respect `prefers-reduced-motion`. no cursor-following lines, no meteor effects, no buttons that chase the cursor. no pulsing or glowing live-status dots, no looping ambient animations.

**Interaction:** progressive disclosure: start simple, reveal complexity. optimistic UI: update immediately, sync later. every interactive element needs ALL states: default, hover, focus, active, disabled, loading, error, success. don't make every button primary.

**Hover:** make elements feel inviting on hover (brighten, subtle scale 1.02-1.05). never fade out, shift, or hide content behind hover. hover doesn't exist on mobile. no hover lift: a translate-y shift or a scale past 1.05 on every card is the generated-card reflex; the shift breaks the never-move-content rule and the big grow reads as a template.

**Scroll:** never override native scroll. use "peeking" (show a few px of next section) instead of full-screen hero + scroll arrow.

**Responsive:** mobile-first. touch targets 44x44px minimum. no text under 14px on mobile. no horizontal scroll. container queries over media queries for components. adapt, don't amputate.

**Accessibility:** 4.5:1 contrast for text, 3:1 for UI (WCAG AA). visible focus indicators always. semantic HTML. never use color alone as an indicator. keyboard nav with logical tab order.

**Hero (H1 test):** must answer in 5 seconds: what is it, who is it for, why care, what's the CTA.

**Assets:** high-res screenshots only. no fake dashboards with primary colors. no decorative non-system emojis.

**Backgrounds:** add depth. gradients, patterns, mesh effects. flat = boring. but no glassmorphism everywhere, that's AI slop.

**Hierarchy:** 2-3 text levels max. don't mix 5 competing styles.

**No all-caps. ever.** never use the `uppercase` tailwind class, `text-transform: uppercase`, or shout-cased copy on eyebrow labels, section headers, buttons, badges, or anywhere else. random capitalized text mid-page reads as average ai-generated slop. if you need a quiet eyebrow label, reach for a smaller size (`text-[11px]`) or a muted color, never caps. write labels in sentence case ("Active tasks", not "ACTIVE TASKS") and let copy render as authored.

**Copy:** no em dashes (the character, U+2014) anywhere in UI copy. no hedge words, no hype adverbs (the "-lessly" family). plain sentences a human would type.

**Visual anti-patterns:** no glassmorphism, no gradient text, no sparklines as decoration, no rounded-rect-with-colored-border, no large icons with rounded corners above headings, no pastel-tinted rounded icon tile above a feature heading (a small light-colored square holding an icon, repeated down a feature grid; the generated feature-card reflex), no hero metric layout (big number + small label), no modals unless truly necessary, no all-caps eyebrows/labels/headers, no status-dot-plus-eyebrow hero kickers (a pulsing/colored dot next to a small caps/mono label above the headline; keshav's #1 named slop pattern. if a section needs a kicker at all, plain sentence-case text with no dot), no "claude beige" off-white backgrounds, no instrument serif overuse (the new AI tell), no generic flat tinted backgrounds, no near-black slate or gray hero gradient fading into black (the dark premium SaaS template look), no colored glowing drop shadow under buttons or cards (a tinted neon glow, e.g. a purple or blue shadow; keep shadows soft and neutral), no bright two-color gradient fill on buttons or badges (a saturated gradient across different hues like pink to orange or blue to cyan; use one solid brand color), no giant blurred gradient orb glowing behind the hero (the aurora-blob background: a huge soft-blurred colored blob absolutely positioned behind the fold; reads as a template).

## Vocabulary is the Lever

Designers beat engineers at AI prompting because they own craft language. Name the move precisely: "tighten vertical rhythm," "increase negative space," "make hierarchy bolder here, quieter there." Vague prompts = vague output. Core terms: vertical rhythm, negative space, bolder/quieter, affordances, meta-design, conviction. When the operator's wish is fuzzy, translate it into this vocabulary before building, and say the translation out loud so the operator can correct it.

## Raising Floor vs Ceiling

Use AI to raise the floor (automate the mechanical 80%: scaffolding, grids, state matrices). Spend human attention on the ceiling (last 10-20%: taste, instinct, the unexpected choice). Cognitive delegation, not surrender. AI routes you there; you make the final call.

## AX: Agentic Experience

Design for AI agents as users, not just humans. Agents can't see your buttons. They need: speed, clarity, structured output, verbose errors with next steps, edge case coverage, agentic affordances (`llms.txt`, clear `--help`, stable exit codes).

## Conviction Over Local Maxima

Iterating toward "slightly better" = local maximum (safe, forgettable). Great design is a bet on a global maximum. AI makes the local-max trap worse: you converge on average faster. Subtraction over addition: the strongest move is often deleting something.

## Anti-Attractors

Models have gravity wells (purple gradients, instrument serif, claude beige). Escape them deliberately: name what you don't want, seed with a specific reference, inject a constraint (monochrome, one font weight), rotate your defaults between projects.

## The Scarcity Principle

Taste emerges from constraints. Pick constraints before starting: one font, two colors, three spacing values. Infinite options produce the distribution center.

## The AI Slop Test

> "if you showed this to someone and said 'AI made this,' would they believe you immediately? if yes, that's the problem."

Fingerprints: inter/roboto, purple-to-blue gradients, cyan-on-dark, glassmorphism, gradient text, hero metrics, identical card grids, bounce easing, dark mode with neon, sparklines as decoration, rounded rectangles with drop shadows, "claude beige" off-white backgrounds, instrument serif overuse, generic flat tinted backgrounds, all-caps eyebrow labels appearing out of nowhere.

## Lessons (typed, compounding)

Every entry: id, rule, detector, status. A detector is a regex/command a gate can run, or `judgment` if only a model can catch it. `graduated` means a deterministic gate now enforces it (design-gate.mjs in atrisos-web, `atris slop` in atris-cli); the lesson stays here as the memory of why.

| id | rule | detector | status |
|----|------|----------|--------|
| D1 | no purple/violet/fuchsia/lavender palettes | banned-palette class scan | graduated (design-gate) |
| D2 | no hardcoded neutral tailwind classes, tint toward brand | zinc/gray/neutral/slate class scan | graduated (design-gate) |
| D3 | no all-caps labels anywhere | uppercase class scan | graduated (design-gate) |
| D4 | custom components only, no shadcn/radix primitives | radix import scan | graduated (design-gate) |
| D5 | no pulsing status dots outside loading skeletons | pulse class scan outside loading/skeleton files | graduated (design-gate) |
| D6 | no arbitrary hex in color utilities, use brand vars | hex-in-color-utility scan | graduated (design-gate) |
| D7 | no em dashes in UI copy or prose | U+2014 scan | graduated (atris slop) |
| D8 | no claude-beige backgrounds, no instrument serif as default | judgment | active |
| D9 | fuzzy wish gets translated to craft vocabulary and echoed back before building | judgment | active |

## Self-Improve (part of the job)

This skill compounds or it dies. The contract, every frontend session:

1. **Capture in the same tick.** When the operator corrects a design choice (a "no", a revert, a fix after landing, a reaction like "that looks AI"), append a typed lesson row above before the session ends. Quote the trigger in the commit/journal, keep the rule one line, propose a detector.
2. **Graduate detectors.** A lesson with a deterministic detector does not stay prose: add it to the nearest gate (`scripts/design-gate.mjs` CATEGORIES in atrisos-web, `atris slop` rules in atris-cli), then mark the row graduated. The gate is the enforcement; the row is the memory.
3. **Promote repeat offenders.** A judgment lesson that fires 3+ times gets rewritten into the Quick Reference prose above and its row marked promoted.
4. **Edit the canonical only.** This file, in atris-cli, committed to git. Then run `atris sync` in each workspace (or wait for the pulse tick) to propagate. Writing to a downstream copy is a lost write.
5. **Prune.** Fold subsumed lessons, keep this file readable in one sitting. If the lessons table passes ~25 rows, graduate or promote before adding.
6. **Bump the version** on every content change (progressive: patch for a lesson row, minor for a new principle).

## Before Shipping Checklist

- can you name the aesthetic in 2-3 words?
- distinctive font, not default?
- at least one intentional animation? zero pulsing/looping ones?
- background has depth? not claude beige?
- hover states feel inviting, not confusing?
- scrolling feels native?
- hero passes H1 test (what/who/why/CTA)?
- all assets crisp?
- all interactive elements have all states (hover/focus/active/disabled/loading/error)?
- WCAG AA contrast (4.5:1 text, 3:1 UI)?
- works on mobile (44px touch targets, no horizontal scroll, readable text)?
- respects `prefers-reduced-motion`?
- zero shout-cased copy? zero em dashes in copy?
- did you name the moves in craft vocabulary (vertical rhythm, negative space, bolder/quieter)?
- did you use anti-attractors (named what to avoid, seeded a reference, set a constraint)?
- if agent-facing: does it have agentic affordances (clear errors, structured output, stable exit codes)?
- ran the design gate? (`npm run audit:design` / `atris slop`)
- new operator correction this session? then a new lesson row exists in the canonical and it is committed.
- would a designer clock this as ai-generated?

## Learn More

- Full policy: `atris/policies/atris-design.md`
- Navigation: `atris/MAP.md`
- Workflow: `atris/PERSONA.md`
