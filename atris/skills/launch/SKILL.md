---
name: launch
description: "Write a release post for Twitter and LinkedIn. 3 emoji bullets, plain English, no jargon. Triggers on: /launch, write a launch post, release announcement, ship post."
version: 1.0.0
tags: [launch, release, social, twitter, linkedin]
---

# /launch

Writes a copy-paste-ready release post for Twitter and LinkedIn.

## Format

```
<project> <version> update

<emoji> What it does, one sentence. Plain English.
<emoji> What it does, one sentence. No buzzwords.
<emoji> What it does, one sentence. Concrete.

<install command>
<release URL>
```

## Example (atris v3.0.1)

```
atris v3.0.1 update

🎯 Write what "done" looks like. The loop plans, builds, and reviews until it gets there.
🧠 Reads past lessons and notes every run. Better decisions over time.
📂 One command sets up a workspace with team, wiki, and context wired in.

npm install -g atris
https://github.com/atrislabs/atris/releases/tag/v3.0.1
```

## How to invoke

User says "write a launch post", "post the release", "/launch", or "announce this version".

The agent then:

1. Read the latest git tag and release notes (or ask what shipped)
2. Distill into exactly 3 bullets, one sentence each
3. Pick an emoji per bullet that fits the content
4. Add install command + release URL at the bottom
5. Output the final text ready to copy-paste

## Rules

- 3 bullets max. Never 4, never 5.
- Each bullet is one sentence about what it does, not what it is
- No em dashes
- No jargon ("canonical", "substrate", "two-engine architecture", "self-improving")
- No mentioning specific tools by name (Claude Code, Cursor, etc.)
- No model/AI buzzwords ("LLM", "same model", "agentic")
- No marketing speak. If it sounds like a pitch deck, rewrite it.
- Plain English a high schooler would understand
- Install command + release URL always at the bottom
- Same post works for both Twitter and LinkedIn
- Optional witty one-liner closer if it fits naturally. Never forced.
