---
name: taste
description: How an agent finds and keeps the taste of the people it works for. Use before making copy, pages, buttons, decks or anything a person will see. Also use it whenever someone corrects how something looks or reads.
version: 2.0.0
tags:
  - taste
  - design
  - copy
---

# Taste

Taste is how the people you work for like things to look and read. It is personal. It never lives in this skill. This skill says where to find it and how to keep it.

## Read it before you make anything a person will see

1. `atris/taste/TASTE.md` in this project, if it exists. It holds this project's brand and voice.
2. `~/.atris/taste/TASTE.md` in the person's home folder, if it exists. It holds their own taste across all their projects.

When the two disagree, the project file wins for work in that project. When neither exists, use the general rules in [principles.md](principles.md) and ask before you guess at a brand.

Each file is a one-screen list. Every line gives the rule and links to a short note with the reason and real examples. Open a note only when your work touches it.

## Keep it alive

- When someone corrects how something looks or reads, write the reason down the same day. A correction about this project goes in `atris/taste/TASTE.md`. A correction about the person's own taste goes in `~/.atris/taste/TASTE.md`.
- Never write a correction into this skill folder. Updates replace it and the correction would be lost.
- A single verdict can also go in with `atris taste keep|kill "<thing>" --why "<reason>"`. Matching verdicts then flow into agent work automatically.

Open [notes.md](notes.md) when you write a taste file, add a line or start a new note.

## Go deeper

- [principles.md](principles.md): general rules that hold for most readers, for when no taste file exists.
- [notes.md](notes.md): the shape of a taste list, a taste note and a recorded correction.
- [../design/SKILL.md](../design/SKILL.md): the full visual rules. Taste says what people like; design says how to build it.
- [../../policies/ANTISLOP.md](../../policies/ANTISLOP.md): the tells that make work read as generated.

Keep this page to one screen. Detail goes in the notes.
