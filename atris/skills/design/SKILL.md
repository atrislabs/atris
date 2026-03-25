---
name: design
description: Frontend aesthetics policy. Use when building UI, components, landing pages, dashboards, or any frontend work. Prevents generic ai-generated look.
version: 2.0.0
allowed-tools: Read, Write, Edit, Bash, Glob
tags:
  - design
  - frontend
---

# atris-design

Part of the Atris policy system. Prevents ai-generated frontend from looking generic.

## Atris Integration

This skill uses the Atris workflow:
1. Check `atris/MAP.md` for existing patterns before building
2. Reference `atris/policies/atris-design.md` for full guidance
3. After building, run `atris review` to validate against this policy

## Quick Reference

**Typography:** avoid inter/roboto/arial/system fonts. pick one distinctive font, use weight extremes (200 vs 800). size jumps should be dramatic (3x). use `clamp()` for fluid sizing. use `ch` units for measure (`max-width: 65ch`).

Font alternatives: instead of Inter → Instrument Sans, Plus Jakarta Sans, Outfit. Instead of Roboto → Onest, Figtree, Urbanist. Editorial → Fraunces, Newsreader, Lora.

**Color:** commit to a palette. use OKLCH for perceptually uniform colors. tint your neutrals toward your brand hue (never pure gray). never put gray text on colored backgrounds. never use pure black (#000) or pure white (#fff). avoid the AI palette: cyan-on-dark, purple-to-blue gradients, neon accents on dark.

```css
--brand: oklch(65% 0.2 250);
--gray-100: oklch(95% 0.01 250); /* tinted, not pure gray */
```

**Layout:** break the hero + 3 cards + footer template. no card-in-card nesting. no identical card grids. asymmetry is interesting. dramatic whitespace. use container queries for component-level responsiveness. fluid spacing with `clamp()`.

**Motion:** one well-timed animation beats ten scattered ones. use exponential easing (`cubic-bezier(0.25, 1, 0.5, 1)`), never bounce/elastic. 150-300ms duration. only animate transform and opacity. always respect `prefers-reduced-motion`. no cursor-following lines, no meteor effects, no buttons that chase the cursor.

**Interaction:** progressive disclosure — start simple, reveal complexity. optimistic UI — update immediately, sync later. every interactive element needs ALL states: default, hover, focus, active, disabled, loading, error, success. don't make every button primary.

**Hover:** make elements feel inviting on hover (brighten, subtle scale 1.02-1.05). never fade out, shift, or hide content behind hover. hover doesn't exist on mobile.

**Scroll:** never override native scroll. use "peeking" (show a few px of next section) instead of full-screen hero + scroll arrow.

**Responsive:** mobile-first. touch targets 44x44px minimum. no text under 14px on mobile. no horizontal scroll. container queries > media queries for components. adapt, don't amputate.

**Accessibility:** 4.5:1 contrast for text, 3:1 for UI (WCAG AA). visible focus indicators always. semantic HTML. never use color alone as an indicator. keyboard nav with logical tab order.

**Hero (H1 test):** must answer in 5 seconds — what is it, who is it for, why care, what's the CTA.

**Assets:** high-res screenshots only. no fake dashboards with primary colors. no decorative non-system emojis.

**Backgrounds:** add depth. gradients, patterns, mesh effects. flat = boring. but no glassmorphism everywhere — that's AI slop.

**Hierarchy:** 2-3 text levels max. don't mix 5 competing styles.

**Visual anti-patterns:** no glassmorphism, no gradient text, no sparklines as decoration, no rounded-rect-with-colored-border, no large icons with rounded corners above headings, no hero metric layout (big number + small label), no modals unless truly necessary.

## The AI Slop Test

> "if you showed this to someone and said 'AI made this,' would they believe you immediately? if yes, that's the problem."

Fingerprints: inter/roboto, purple-to-blue gradients, cyan-on-dark, glassmorphism, gradient text, hero metrics, identical card grids, bounce easing, dark mode with neon, sparklines as decoration, rounded rectangles with drop shadows.

## Before Shipping Checklist

Run through `atris/policies/atris-design.md` "before shipping" section:
- can you name the aesthetic in 2-3 words?
- distinctive font, not default?
- at least one intentional animation?
- background has depth?
- hover states feel inviting, not confusing?
- scrolling feels native?
- hero passes H1 test (what/who/why/CTA)?
- all assets crisp?
- all interactive elements have all states (hover/focus/active/disabled/loading/error)?
- WCAG AA contrast (4.5:1 text, 3:1 UI)?
- works on mobile (44px touch targets, no horizontal scroll, readable text)?
- respects `prefers-reduced-motion`?
- would a designer clock this as ai-generated?

## Atris Commands

```bash
atris            # load workspace context
atris plan       # break down frontend task
atris do         # build with step-by-step validation
atris review     # validate against this policy
```

## Learn More

- Full policy: `atris/policies/atris-design.md`
- Navigation: `atris/MAP.md`
- Workflow: `atris/PERSONA.md`
