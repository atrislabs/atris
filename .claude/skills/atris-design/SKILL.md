---
name: atris-design
description: Frontend aesthetics policy. Use when building UI, components, landing pages, dashboards, or any frontend work. Prevents generic ai-generated look.
allowed-tools: Read, Write, Edit, Bash, Glob
---

# atris-design

Prevents ai-generated frontend from looking generic (inter fonts, purple gradients, no animation).

## When to Use

- Building any frontend (landing pages, dashboards, components)
- Reviewing UI code
- User asks for design feedback

## Quick Reference

**Typography:** avoid inter/roboto/system fonts. pick one distinctive font, use weight extremes (200 vs 800).

**Color:** commit to a palette. dark backgrounds easier to make good. steal from linear.app, vercel.com, raycast.com.

**Layout:** break the hero + 3 cards + footer template. asymmetry is interesting. dramatic whitespace.

**Motion:** one well-timed animation beats ten scattered ones. 200-300ms ease-out.

**Backgrounds:** add depth. gradients, patterns, mesh effects. flat = boring.

## Before Shipping

- can you name the aesthetic in 2-3 words?
- distinctive font, not default?
- at least one intentional animation?
- background has depth?
- would a designer clock this as ai-generated?

## Full Policy

Read `atris/policies/atris-design.md` for complete guidance.
