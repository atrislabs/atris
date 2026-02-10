# Audit Gaps

> **Status:** in-progress
> **Created:** 2026-02-09
> **Last Updated:** 2026-02-09

---

## Problem Statement

The self-audit found gaps that wire-the-loop didn't cover: no agent spec references PERSONA.md for communication style, and the self-improving-loop feature is still marked "planning" when it shipped.

---

## Solution Design

Add PERSONA.md reference to all 5 agent specs. Clean up stale feature statuses. Small, mechanical.

---

## Lessons Applied

From `lessons.md`: "The wiring layer is always the gap." — PERSONA.md exists, agents are told to load it via CLI, but the specs themselves never say "read PERSONA.md." Same pattern, third time.
