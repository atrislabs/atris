# Learning team

A sibling to Sentinel. Sentinel guards your code. This team keeps your agents current.

Every week it reads the newest papers, posts, repos, releases and talks on the topics you pick. It writes what matters into your Atris wiki as small linked notes. Your agents read those notes before they work.

## Names

- **Atris Scholar.** Pairs with Sentinel: one guards and one studies. This is the pick.
- **Atris Lookout.** Says it watches the field for you.
- **Atris Study Hall.** Friendlier, for owners who are not engineers.

## Who buys it

An owner who runs agents on real work and has no time to read the field: a founder with a coding team of agents, a lab, a fund, a small agency. They already pay for Atris and keep a wiki.

## What they get each week

- One brief per topic: three to five rules, each with the line that says when to open its note.
- The notes behind it. Each note holds one rule, what the sources show, one example and links to related notes.
- Every claim cites a source with its date and link. A note with no real source is dropped before it is written.
- A line in the wiki index. Every agent that boots finds the brief there.
- An honest list of what it could not read that week.

## Why it beats reading the internet

- It reads every week. Nobody has to remember to.
- It writes rules an agent can act on, not a reading list.
- The notes land where agents already look. The next run uses them with no new setup.
- The recall exam checks it. On the first real run, an agent starting from the wiki index found all three answers by opening two files or fewer. Those questions were written after the notes. A held-out set is still owed.

## How it plugs into the wiki

Run `atris wiki learn "<topic>" --into <wiki folder>`. Notes go in `concepts/<topic>/`, the brief in `briefs/<topic>.md` and one line under `## Learning` in `index.md`. Rerunning a topic replaces its index line and lists older notes in the brief. Nothing learned is lost. The output passes `atris wiki verify` and `atris slop detect` as written.

## What it costs

The local command costs 0 credits. It runs on the owner's own engine login and strips paid API keys before the engine starts.

A hosted weekly run would bill these real rates from the backend:

- Each page fetch: 1 credit. One topic needs 3 fetches for 3 credits.
- Model work: 1 credit per 1,000 tokens with a floor of twice the provider cost. The real run sent about 1,200 tokens and got about 1,600 back. That is about 3 credits before the floor. The floor depends on the model and is unknown until hosted.
- Video search adds 5 credits if turned on.

So one topic costs about 6 credits a week to run. Five topics cost about 130 credits a month.

## How that fits the business

Credits cost 1 cent each. Plans include Free 50 a month, Pro $20 for 1,000, Business $50 for 5,000 and Max $200 for 20,000. Five weekly topics fit inside Pro with room to spare. Sentinel's agent review bills 25 credits a call. A matching price of 25 credits per topic per week is a proposal, not a set price. At that price five topics use about 540 of Pro's 1,000 credits a month. Heavy users move up to Business.

## Unknowns

- The final price per topic.
- The model cost floor for the hosted run.
- Whether the backend's Pro price is $20 or $29. The plan list says $20. The audit pricing code says $29.
- Video sources: the free search gives no upload dates. The proof skips videos until it can check how old they are.
