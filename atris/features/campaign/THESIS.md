# The Campaign Thesis

> Keshav's notebook, 2026-10-15. The one page everything else in this folder serves.

## The struct

A campaign is a struct for long-horizon work managed by multiple intelligences.

```text
Campaign   vision      one big goal, a team, one outside judge
Mission    strategy    one specific piece, one owner, it ends
Task       tactics     one step, with proof
Behavior   each move   one action an agent takes
```

## The result

Every level is judged. The campaign by an outside judge, a mission by someone else's validation, a task by its proof, and a move by whether it worked and whether a person corrected it.

So every campaign is an episode in a reinforcement learning environment, for any industry:

- **Real work.** Every episode is something a business actually needed.
- **Rewards you can check.** The judge sits outside the agents.
- **Human preference built in.** Every correction a person makes is a labeled example of what they wanted.
- **Long horizons with credit.** Judge readings before and after each mission show what actually worked.
- **Multiplayer.** Many agents and many models work the same goal, side by side.

The traces of that work (what each agent tried, what worked, what a person corrected) are data no lab can get anywhere else. With consent, Atris is where labs can see how agents do real work.

## What actually improves

Atris doesn't train the model. It learns the harness: lessons, which member and engine take which work, prompts, and judges. Labs make the models. Every new model plugs into a harness that already knows the team and its standard.

Campaigns point attention. Each member's constant loop (wake, work, get judged, get coached, keep the lesson) is practice. The skill compounds in the member, whichever engine runs it.

## The rule of prompt

One shift in your head, then repeated success: stop prompting tasks and set the vision and the standard. The team does the rest and asks only for what is truly yours.

Agents work in blocks: about 50 minutes, then a short reset (save, reflect, fresh context) instead of a rest.

## What keeps it honest

1. **Judges the team cannot write, game, or misread,** tracking something a person can confirm. For anything a person uses, the judge is a person doing it.
2. **Gauges audited by hand before they are trusted.** On 2026-10-15 the morning gauge said 25 fixes; the truth was 1 fix and 18 coaching edits.
3. **Consent for traces.** A customer's work is the customer's data.
4. **One finished campaign before more surfaces.** Prove it once, then spread it.
