# Spaceship — bounded, self-reporting overnight runner

> **Status:** complete
> **Created:** 2026-06-17
> **Last Updated:** 2026-06-17

---

## Problem Statement

A team member should be able to run overnight, do valuable work, and tell you about it. The existing overnight loops could not: `atris autopilot --duration` dies on the first halted tick (one bad pick at minute 6 kills the whole night), and every loop (autopilot, pulse, forge_overnight, the web guardian) writes only to local logs — so a halt, a no-op streak, or a dead loop is invisible. The HVAC loop went dark for 11 hours this way.

---

## Solution Design

`atris spaceship` is a supervisor around the real tick. It runs `atris autopilot --auto --iterations=1` in a loop for a wall-clock budget, classifies each tick by what actually landed in git (HEAD moved = shipped), and never dies on a bad tick — it survives halts and keeps picking new work. Every meaningful state change emails Keshav through an SES channel: shipped, halt-streak, idle-streak, finish. It does not reimplement the tick; it wraps the tested one.

---

## ASCII Visualization

```
atris spaceship --hours 4
        │
        ▼
  ┌───────────────────────────────────────────────┐
  │ supervisor loop (until budget)                 │
  │   run 1 tick ──► classify by git HEAD + exit   │
  │        │                                       │
  │        ├─ shipped (HEAD moved) ─► email + next │
  │        ├─ halted/timeout ───────► survive;     │
  │        │     2 in a row ─────────► email alert │
  │        └─ idle (clean, no commit) ► survive;   │
  │              3 in a row ──────────► email once │
  └───────────────────────────────────────────────┘
        │
        ▼
   final summary email  (ships / halts / idle / elapsed)
```

---

## Success Criteria

- [x] Survives back-to-back halts instead of dying (regression test).
- [x] Emails on shipped / halt-streak / idle-streak / finish.
- [x] Classifies outcomes by git HEAD movement (model-agnostic).
- [x] Reachable as `atris spaceship`, discoverable in help.
- [x] Read-only siblings (`pulse_digest`, `guardian_watch`) make the live loops visible without touching them.

---

## User Impact

The operator can leave a loop running and trust that anything worth knowing reaches their inbox. Silence stops meaning "fine by default" — a dead supervisor is itself the signal (no email for over an hour).

---

## Technical Notes

- Runner: `scripts/spaceship.sh`; CLI wrapper: `commands/spaceship.js`; test: `test/spaceship-supervisor.test.js`.
- Email channel + read-only reporters live in `atrisos-backend/backend/scripts/` (`spaceship_update.py`, `pulse_digest.py`, `guardian_watch.py`) — SES from `hello@atris.ai`. Override the send command via `SPACESHIP_EMAIL_CMD`.
- **Open finding (needs review):** the loop ships nothing not because it is unreliable but because the top of the backlog is stale (endgame steps whose verify already passes) or vague (plans the review gate rejects). The real lever is feeding it well-scoped tasks with a currently-failing falsifiable verify. The falsifiability gate also halts without ticking the checkbox when a step was finished on a prior day (no same-day receipt) — a safe auto-advance fix exists but changes core semantics, so it is left for review.
