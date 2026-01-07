#!/bin/bash
# Atris Autopilot Stop Hook
# Catches exit, re-injects with MAP/TODO context

STATE_FILE=".claude/atris-autopilot.state.md"

# Read stdin JSON for transcript path
INPUT=$(cat)
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')

# Prevent infinite loops
if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
  exit 0
fi

# No state file = not in autopilot mode
if [ ! -f "$STATE_FILE" ]; then
  exit 0
fi

# Parse state from YAML frontmatter
iteration=$(grep "^iteration:" "$STATE_FILE" | cut -d' ' -f2)
max_iterations=$(grep "^max_iterations:" "$STATE_FILE" | cut -d' ' -f2)

# Validate numbers
if ! [[ "$iteration" =~ ^[0-9]+$ ]] || ! [[ "$max_iterations" =~ ^[0-9]+$ ]]; then
  echo '{"decision": "block", "reason": "Error: Invalid state file. Run /cancel-autopilot and restart."}'
  exit 0
fi

# Max iterations reached - allow exit
if [ "$iteration" -ge "$max_iterations" ]; then
  rm -f "$STATE_FILE"
  exit 0
fi

# Check transcript for completion promise
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  if grep -q "<promise>COMPLETE</promise>" "$TRANSCRIPT_PATH"; then
    rm -f "$STATE_FILE"
    exit 0
  fi
fi

# Increment iteration
new_iteration=$((iteration + 1))
sed -i.bak "s/^iteration:.*/iteration: $new_iteration/" "$STATE_FILE"
rm -f "${STATE_FILE}.bak"

# Extract original prompt
prompt=$(sed -n '/^---$/,/^---$/!p' "$STATE_FILE" | tail -n +2)

# Load context
map_context=""
[ -f "atris/MAP.md" ] && map_context=$(head -200 atris/MAP.md)

todo_context=""
[ -f "atris/TODO.md" ] && todo_context=$(cat atris/TODO.md)

# Build reason (this is what Claude sees)
reason="[AUTOPILOT ITERATION $new_iteration/$max_iterations]

TASK: $prompt

CONTEXT:
- MAP.md loaded (use for navigation)
- TODO.md loaded (track progress)

RULES:
- ONE thing this iteration
- Search before assuming not implemented
- When ALL done: output <promise>COMPLETE</promise>

Continue working."

# Block exit, provide reason
echo "{\"decision\": \"block\", \"reason\": $(echo "$reason" | jq -Rs .)}"
exit 0
