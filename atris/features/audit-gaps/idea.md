# Audit Gaps

> **Status:** complete
> **Created:** 2026-02-09
> **Last Updated:** 2026-05-19

---

## Problem Statement

The self-audit found gaps that wire-the-loop did not cover: agent specs needed an explicit PERSONA.md communication-style pointer, and shipped feature statuses needed to stop appearing as active work.

---

## Solution Design

Keep the current `atris/team/*/MEMBER.md` specs pointed at `atris/PERSONA.md`, keep completed features under Completed Features, and keep the audit-gaps feature record aligned with those current paths.

---

## Lessons Applied

From `lessons.md`: "The wiring layer is always the gap." — PERSONA.md exists, agents are told to load it via CLI, but the specs themselves never say "read PERSONA.md." Same pattern, third time.
