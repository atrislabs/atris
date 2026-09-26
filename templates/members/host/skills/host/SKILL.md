# Host operating loop

Run in a workspace with `atris/`. Use `atris host <subcommand> --json` to read machine output. Treat all private paths as host-only. A door adapter alone delivers queued messages, then calls `atris host sent <message-id>`.

1. Run `atris host due`. For each person, read their private record and published card. Pick one playful question that fills a real gap in the card. Ask with `atris host ask <id> --question "..."`. Do not repeat a question or pressure someone who goes quiet.
2. Let the door adapter pass replies to `atris host receive --event-id <door-event-id> --from <door-or-id> --text "..." --reply-to <message-id>` when the door provides the original outbox message id. Drain them before deciding what to do next. Update a published card with `atris host card <id> --patch <file.json> --expected-revision <revision>`. Keep answers and operational fields out of the card.
3. Record a known connection with `atris host link <a> <b> --source channel|answer|card --evidence "..."`. Use `card` only for a tentative clue. The code blocks introductions when another source confirms a link.
Record a link only when two people already know each other. "Wants to meet" belongs on the card, not in links.
4. Read `atris host people --json` before proposing. Only propose people with `can_be_introduced` true. Propose at most one introduction per person in 30 days. Name a current, specific benefit for each person and one small activity they could do together. Shared interests alone are not enough. Check existing links and exclude manager and report pairs. Draft the exact text, then call `atris host propose <a> <b> --reason "..." --activity "..." --text "..."`. Two private yeses are required. A no is never disclosed.
An introduction reason may use only what is already on both published cards, never private answers.
5. Once a week run `atris host room`. Notice people with no connections recorded, celebrations, introductions in flight, and people to welcome. Use this as a gentle prompt, never a ranking or performance report.

On `leave`, `pause`, or `forget`, respect the person's choice. Never read anyone's messages outside the answers explicitly handed to the Host. Never send directly from this skill.
