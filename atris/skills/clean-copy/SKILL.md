---
name: clean-copy
description: Cut interface copy that should not exist. Captions that restate a label, hints that answer a worry the user never had, warnings left over from a fixed bug. Use when writing or reviewing any user-facing string (labels, hints, empty states, toasts, confirmations, button text) or when asked to clean up or tighten copy. Triggers on clean copy, tighten copy, cut copy, review strings, too much text, ui copy.
version: 1.0.0
tags:
  - copy
  - interface
  - writing
  - quality
---

# Cleaning copy

Most bad copy is not badly written. It is copy that should not be on the screen. Editing it for tone just makes the wrong thing read better. The first question is never "how should this be phrased". It is **should this exist**.

## The ladder

Walk a string down these in order. Stop at the first one that fires. Cut the string or cut the part that fired.

1. **Does this need to surface at all?**
   Is the thing being described something the user would ever have wondered about, unprompted? If they would never have thought to ask, you are not answering a question. You are planting one. Nobody opens an avatar cropper wondering whether the circle is a true circle. A caption reading "the preview is rendered at the exact size used on your profile" makes them wonder whether it might not be.

2. **Does the caption need to exist?**
   A caption earns its place only when the value is meaningless without it. If the label, the field or the value beside it already says the thing, the caption is noise. A field labelled "Retry limit" does not need "how many times we retry" beneath it. A bare "30" does need "seconds" beside it. That one stays.

3. **Is it answering something the user would never have had to consider?**
   The tell: copy that rules out a failure instead of describing a behaviour.

   > Cancel upload
   > *Always keeps the files already transferred. Never wipes the folder like the old cancel did.*

   That second sentence exists because of a bug. The user does not know about the bug, does not share your memory of fixing it and now has a worry they arrived without. **The fix for a fixed bug is the fix. Not a caption about the fix.** The same goes for copy defending a design decision or hedging about something that simply works: "this may look slow but it is not", "don't worry if the count seems off for a moment".

4. **Rewrite to remove the part that fired. If nothing is left, delete the element.**
   Do not preserve a hint just because there was a hint there. An empty `hint` prop comes off the component. An explanatory `<p>` gets deleted, not shortened to a stub.

## What survives

Copy stays when the user cannot act without it:

- A real consequence at the moment of choosing. Under a destructive button: *"Anything not yet synced is lost."* They need it before they click and they cannot infer it.
- A compatibility or scope fact they cannot see. *"Works with keys issued after March; older keys need rotating first."* The checkbox alone does not tell them whether it applies to them.
- What a blank state means and what to do next. *"No projects yet. Create one and it will appear here."*
- Units, scale or format on a bare value.

Note the first example is one sentence. Had it continued *"Only use this when a sync is stuck"*, that half would go: it tells the user when they are allowed to press a button they can already see. Keep the consequence. Cut the permission slip.

## Working style

- Read the string next to what is on screen around it: the label, the value, the button. Redundancy is invisible when you read the string alone.
- Cut whole clauses, not words. Tightening "Leave this blank to use the default setting for your account" into "Leave blank for the default" is a smaller win than noticing which half of a two-sentence hint is doing no work.
- When reviewing a batch, report as `file:line` with the current string and either the rewrite or `cut`. Say in a few words which rung it failed. Do not rewrite copy that passes.
- If a string matters only in a rare state, consider whether it belongs in that state instead of sitting on the page all the time.

## Go deeper

- [../copy-editor/SKILL.md](../copy-editor/SKILL.md): fixes how a sentence reads. Run this skill first, since a deleted string needs no editing.
- [../taste/SKILL.md](../taste/SKILL.md): where the taste of the people you work for lives.
- [../design/SKILL.md](../design/SKILL.md): the visual rules for the screen the copy sits on.
