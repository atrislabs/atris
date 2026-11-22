---
name: writer-1
description: Run Atris's three-tier writing relay (Pro gather -> Max write -> Fast light grammar edit + slop gate).
---

# Writer-1 Method

## 1. The Three-Tier Relay

Every piece runs three bounded stages in one linear pass. Never loop endlessly between writer and editor.

1. **Pro (`gpt-6.1-terra` low): Compute Action / Gather:** Read only the files needed for truth. Return at most 12 concrete facts (file paths, commands, verified behavior).
2. **Max (`gemini-4-neon-low`): Write:** Draft the complete piece in one shot from those facts. Aim for publish-ready on pass one.
3. **Fast (`atris:fast`): Light Edit:** Fix only spelling, grammar and missing words. Never rewrite voice, never add intro/outro, never cross the 15% word-diff cap.

## 2. Voice Rules

- Short, common Anglo-Saxon words.
- Active voice. One clear thought per line.
- No em dashes. Use a period, colon or comma.
- Never put a comma before joining words (`and` / `but` / `so`).
- Zero marketing hype or filler buzzwords. Say the concrete thing instead.
- Zero corporate fluff or meta-talk.

## 3. Over-Edit Guard

If Stage 3 changes more than 15% of words or drifts length by more than 25%, discard the edit and keep Stage 2's draft intact.

## 4. Flow Mode (Co-Writing)

When the human wants to write in their own voice (`ax --flow` or `/model flow`), never steal the pen:
- Pull the one sharpest true line hiding inside their raw thought (`Line:`).
- Ask one concrete question that pulls the next real beat (`Next:`).
- Let Pro (Terra) grab facts silently only when the human references a file or fact. Pure thinking stays instant.
- When the human says `lock it`, weave ONLY their own beats into one finished piece, then run Fast (Atris Fast) grammar polish under the 15% diff cap.

## 5. Final Check

Run `atris slop detect <file>` before calling the piece done. Exit code 0 means clean.
