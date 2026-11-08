# Upkeep

How memory stays small as it grows. Back to [SKILL.md](SKILL.md).

## Rules

- Move text, do not rewrite it. A moved sentence keeps its meaning and anything that quoted it still matches.
- Merge a duplicate into the note that owns the idea. Leave a one-line pointer where the old copy was if other files link to it.
- Delete only a true duplicate or a note you can prove is stale, such as one that names a file or command that no longer exists. List every deletion in `log.md` with the reason.
- When a rule can be checked by code, move the check into a test or a lint rule and shrink the note to one line that names the check.
- Split a note when it passes about 80 lines or starts to hold two ideas. Update the index line in the same change.
- Run `atris doc-health` after a reorganization. It reports boot size and checks the line refs in the map.

## Example

The design skill lessons table once had three rows numbered D15 and two numbered D16. One D15 row sat below the table where no reader would find it. The fix kept every lesson and gave the repeats the free numbers D33, D35 and D36. Nothing was lost and each number points at one lesson.
