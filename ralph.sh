#!/bin/bash
# Ralph Wiggum Loop - PRD-driven autonomous execution

MAX_ITERATIONS=10
PROGRESS_FILE="progress.txt"
PRD_FILE="prd.json"

echo "🔁 Ralph starting at $(date)" >> "$PROGRESS_FILE"

for i in $(seq 1 $MAX_ITERATIONS); do
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "🔄 Iteration $i/$MAX_ITERATIONS"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # Run Claude Code with PRD-focused prompt
  OUTPUT=$(claude -p "You are Ralph, a PRD-driven autonomous executor.

## YOUR PRD
$(cat $PRD_FILE)

## INSTRUCTIONS
1. Find the FIRST story where passes: false (lowest priority number)
2. If ALL stories have passes: true, reply ONLY: <promise>COMPLETE</promise>
3. Implement that ONE story:
   - Read the file specified
   - Check atris/MAP.md for context
   - Make minimal changes to satisfy acceptance criteria
   - Test manually: run the command, verify output matches acceptance
4. Update prd.json: set that story's passes: true
5. Commit: git add -A && git commit -m 'Ralph: [story title]'
6. Append to progress.txt: '- [timestamp] US-XXX: [title] ✓'

## ACCEPTANCE = STOP CONDITION
Only flip passes: true when ALL acceptance criteria are met.
If stuck or uncertain, skip and note in progress.txt.

## RULES
- ONE story per iteration
- Verify before marking passes: true
- Minimal changes only

Go." --allowedTools "Bash,Read,Write,Edit,Glob,Grep" 2>&1)

  echo "$OUTPUT"

  # Check for completion signal
  if echo "$OUTPUT" | grep -q "<promise>COMPLETE</promise>"; then
    echo ""
    echo "✅ Ralph finished! All stories pass."
    echo "🏁 Ralph finished at $(date) - all stories pass" >> "$PROGRESS_FILE"
    exit 0
  fi

  sleep 2
done

echo ""
echo "⏰ Ralph hit max iterations ($MAX_ITERATIONS)"
echo "⏰ Ralph stopped at $(date) - max iterations" >> "$PROGRESS_FILE"
