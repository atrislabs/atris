# Copy

How words should read. Back to [SKILL.md](SKILL.md).

## Rules

- Tell a story in plain connected sentences. Lead with what it means for the reader.
- Never put a comma in front of a joining word. That covers and / but / so / then / because / which / when. The owner called this "one of the worst."
- No em dashes. No small labels above headlines. No hype words.
- No choppy fragments. "Found today. Fixed today." lost because it reads like an ad.
- Every line must be true for every reader. "Your product has never had a security team" failed because many readers do have one.
- Make the reader feel strong, not wrong. Show what we are good at instead of what they lack.
- Never claim something we haven't checked. If a feature isn't built, say "coming next."
- Don't explain our machinery. "Why do I give a shit about a second reader" killed a line about our review step.

## Real picks

Winners came from the copy rounds on 2026-11-07.

- "Check my code" beat "Run the check."
- "Let's look for holes." beat "Find what is exposed."
- "See what your code reveals." beat "Code, under examination."
- "We've read 51 of 966 areas so far." beat "51 of 966 areas read; one question awaits its owner."
- "We found that someone on one team could guess an ID and read..." beat "We found cross-team code access through a guessable..."

The pattern is that the human, spoken version wins over the clipped technical one.

## Check before showing

Run this on any draft. No output means clean.

`perl -CSD -ne 'print "$.: $_" if /,\s*(and|but|or|so|then|though|yet|because|while|which|when|nor)\b|[\x{2013}\x{2014}]/' FILE`
