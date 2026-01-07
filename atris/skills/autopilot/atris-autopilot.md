---
description: Start autonomous loop - plan/do/review until done
arguments:
  - name: task
    description: What to build (e.g., "Add dark mode toggle")
    required: true
  - name: max-iterations
    description: Max loops before stopping (default 10)
    required: false
---

# Atris Autopilot

You are entering **autonomous mode**. You will loop until the task is complete or max iterations reached.

## Setup

First, create the state file:

```bash
mkdir -p .claude
cat > .claude/atris-autopilot.state.md << 'EOF'
---
iteration: 1
max_iterations: $ARGUMENTS.max-iterations|default:10
completion_promise: <promise>COMPLETE</promise>
---

$ARGUMENTS.task
EOF
```

## Your Task

**$ARGUMENTS.task**

## Process

Each iteration:
1. **PLAN** — Read MAP.md, identify files, create approach
2. **DO** — Implement ONE thing, commit changes
3. **REVIEW** — Check acceptance criteria

## Acceptance Criteria

- Task implemented and working
- Tests pass (if they exist)
- Build passes
- Code follows patterns in MAP.md

## Rules

- ONE thing per iteration (trust the loop)
- Search MAP.md before grepping
- Search codebase before assuming not implemented
- Update TODO.md with progress
- Log learnings to atris/logs/

## Completion

When ALL acceptance criteria pass, output exactly:

```
<promise>COMPLETE</promise>
```

This signals the stop hook to end the loop.

## Start

Read atris/MAP.md now. Then begin iteration 1.
