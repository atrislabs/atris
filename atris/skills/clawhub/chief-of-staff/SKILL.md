---
name: chief-of-staff
description: "Daily briefing agent that learns your patterns and gets better every morning. Requires member-runtime skill. Use when you want a personalized morning briefing, daily summary, or 'brief me'."
version: 1.0.0
tags:
  - daily-briefing
  - personal-assistant
  - stateful
  - productivity
  - chief-of-staff
---

# Chief of Staff

A MEMBER.md worker that runs on the member-runtime skill. Install both:

```
clawhub install member-runtime
clawhub install chief-of-staff
```

Then say: "brief me" or "be my chief of staff"

## What This Member Does

Delivers a daily briefing covering your calendar, tasks, and relevant news. Gets better over time through a journal loop -- tracks what you engage with, what you skip, and adapts.

- **Day 1:** Generic briefing. Calendar + tasks. Fine but forgettable.
- **Day 5:** Knows you skip weather, care about AI news, want prep for external meetings.
- **Day 30:** Knows your Monday sprint routine, your team, your reading habits. The briefing is yours.

## Files Installed

```
team/chief-of-staff/
  MEMBER.md                          # Persona and workflow
  skills/daily-briefing/SKILL.md     # How to build the briefing
  skills/pattern-learning/SKILL.md   # How to learn from each run
  context/preferences.md             # Starting defaults
```

## How It Works

1. The member-runtime skill finds and loads `team/chief-of-staff/MEMBER.md`
2. It reads the persona -- an opinionated prioritizer, not a data dumper
3. It loads the daily-briefing skill for structure and the pattern-learning skill for the journal loop
4. It checks memory for past briefings and user preferences
5. It delivers a briefing adapted to what you actually care about
6. After delivery, it writes a journal entry recording what happened
7. Tomorrow's briefing is better because of today's journal

## The Journal Loop

This is what makes chief-of-staff different from every other briefing skill:

- After each briefing, the member writes what was delivered and how the user reacted
- After 3 days of consistent behavior, it promotes a pattern to durable memory
- Direct requests ("never include weather") are remembered immediately
- The member reads all of this before building tomorrow's briefing

No configuration needed. Preferences build up through use.

## Source

Format spec and full source: https://github.com/atrislabs/member
