# Getting Started with Atris

Atris turns any folder into a workspace that gets better over time. Integrates with any agent.

## Install

```bash
npm install -g atris
```

## Setup (1 minute)

```bash
cd your-project
atris init
```

This creates an `atris/` folder with everything the system needs:

```
atris/
├── MAP.md          navigation (file:line references)
├── TODO.md         current work queue
├── PERSONA.md      how the agent communicates
├── lessons.md      what went wrong and what worked
├── logs/           daily journal
├── wiki/           durable knowledge
└── team/           agent roles
```

## Your first goal

Tell atris what you want to build:

```bash
atris log "add dark mode to the settings page"
```

This lands in today's journal as an inbox item. The loop picks it up from there.

## Run one tick

```bash
atris autopilot --auto --iterations=1
```

The autopilot will:
1. Read your inbox and pick a task
2. Plan it
3. Build it
4. Review it
5. Run the verify check (pass or fail, no opinions)
6. Write a lesson if something went wrong

One task. One commit. One result you can check.

## Set a goal with an endgame

For bigger work, set a goal and let the loop pursue it:

In your coding agent, say `/endgame` or describe where you want to end up. The system will:
1. Pick a horizon (what does done look like?)
2. Break it into verified tasks (each has a real check)
3. Work through them one tick at a time
4. Write a scorecard when the goal closes
5. Use that scorecard to pick a better goal next time

## Run the loop

```bash
atris autopilot --auto --iterations=5
```

Or in your coding agent, say `/loop` to schedule it to run every ~15 minutes.

The loop runs until the goal is done, then picks the next one from scorecards + inbox.

## Key commands

```
atris init                 set up a new workspace
atris activate             load context (MAP, TODO, journal)
atris log                  add to today's journal
atris autopilot            run one tick (plan, build, review, verify)
atris status               where things stand
atris clean                find broken refs, stale docs
atris release --dry-run    preview a version bump
```

## How it improves over time

Every tick:
- A verify check runs. Pass or fail.
- A reward gets scored from the result.
- If something fails, a lesson is written.

Every goal:
- A scorecard records what shipped, what failed, and the total reward.
- The next goal is picked based on what actually worked before.

The folder gets smarter. The agent doesn't change. The context around it does.

## Need help?

- Issues: https://github.com/atrislabs/atris/issues
- Source: https://github.com/atrislabs/atris
