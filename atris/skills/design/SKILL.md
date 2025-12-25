---
name: atris-design
description: Frontend aesthetics policy. Use when building UI, components, landing pages, dashboards, or any frontend work. Prevents generic ai-generated look.
allowed-tools: Read, Write, Edit, Bash, Glob
---

# atris-design

Part of the Atris policy system. Prevents ai-generated frontend from looking generic.

## Atris Integration

This skill uses the Atris workflow:
1. Check `atris/MAP.md` for existing patterns before building
2. Reference `atris/policies/atris-design.md` for full guidance
3. After building, run `atris review` to validate against this policy

## Quick Reference

**Typography:** avoid inter/roboto/system fonts. pick one distinctive font, use weight extremes (200 vs 800).

**Color:** commit to a palette. dark backgrounds easier to make good. steal from linear.app, vercel.com, raycast.com.

**Layout:** break the hero + 3 cards + footer template. asymmetry is interesting. dramatic whitespace.

**Motion:** one well-timed animation beats ten scattered ones. 200-300ms ease-out.

**Backgrounds:** add depth. gradients, patterns, mesh effects. flat = boring.

## Before Shipping Checklist

Run through `atris/policies/atris-design.md` "before shipping" section:
- can you name the aesthetic in 2-3 words?
- distinctive font, not default?
- at least one intentional animation?
- background has depth?
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
