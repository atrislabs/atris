# Atris Autopilot Loop

Autopilot runs the navigator → executor → validator cycle until the agreed success criteria are satisfied. It keeps humans in the loop by recording the vision, pausing for confirmation at each stage, and appending outcomes back to the daily journal.

## Outcomes

- Capture a clear **Vision** for the session (problem, desired change, acceptance tests).
- Drive `atris plan`, `atris do`, `atris review` with a shared context object.
- Append cycle notes and completion markers into today's log.
- Stop when the validator confirms the success criteria are met or the user chooses to abort.

## Vision Intake

1. **Source selection**
   - `Journal`: choose an item from today's `## Inbox` section.
   - `Fresh idea`: type a new vision; the CLI will add it to the Inbox with the next `I#`.
2. **Success criteria**
   - Prompt for 2–5 acceptance bullets (files to touch, tests to pass, definition of done).
   - Optional additional notes / risks.
3. **Persist**
   - Write a `### Autopilot Vision` block under today's `## Notes` with:
     - Timestamp
     - Source (Inbox item ID or “Ad-hoc”)
     - Summary
     - `Success Criteria:` list
     - `Risks / Notes:` (if provided)

## Cycle Flow

Repeat until success:

1. **Plan phase**
   - Run `atris plan` (navigator).
   - User/agent reviews output, optionally edits TASK_CONTEXTS.
   - CLI waits for confirmation before proceeding.
2. **Do phase**
   - Run `atris do` (executor).
   - User/agent implements work; CLI pauses for confirmation.
3. **Review phase**
   - Run `atris review` (validator).
   - Validator validates changes, updates docs, cleans tasks.
   - CLI prompts for outcome:
     - `Success` → mark completion.
     - `Needs follow-up` → capture blockers/next steps, optionally start another loop.

## Logging Schema

During the run the CLI updates today's log:

- Under `## Notes`
  - `### Autopilot Vision — HH:MM`
  - `### Autopilot Iteration N — HH:MM`
    - `Phase Notes:` (optional quick bullet)
    - `Validator Result:` `Success` | `Follow-up required`
    - `Next Steps:` (if provided)
- On `Success`
  - Append to `## Completed ✅` a new `C#` entry summarising the outcome.
- On `Follow-up`
  - Ensure the related Inbox item remains (or re-add new `I#` with updated wording).

## CLI Guardrails

- Ensure today's log and directories exist (`atris/logs/YYYY/YYYY-MM-DD.md`).
- For new ideas, automatically assign incremental IDs (`I{n}`) in the Inbox.
- All prompts accept `exit` to abort safely.
- Any file updates are done atomically; if something fails, no partial write is left behind.

## Next Enhancements

- Allow selecting Inbox items from previous dates.
- Stream plan/do/review output into a single session transcript.
- Generate automatic TODOs when validator reports follow-up work.

