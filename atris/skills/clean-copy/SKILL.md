---
name: clean-copy
description: Cut interface copy that should not exist. Captions that restate a label, hints that answer a worry the user never had, lines that defend a choice or give permission for a button already on screen. Use when writing or reviewing any user-facing string (labels, hints, empty states, toasts, confirmations, button text) or when asked to clean up or tighten copy. Triggers on clean copy, tighten copy, cut copy, review strings, too much text, ui copy.
version: 1.1.0
tags:
  - copy
  - interface
  - writing
  - quality
---

# Cleaning copy

Most bad copy is not badly written. It is copy that should not be on the screen. Editing it for tone just makes the wrong thing read better. The first question is never "how should this be phrased". It is **should this exist**.

Every example below is a real line from an Atris screen and what happened to it.

## The ladder

Walk a string down these in order. Stop at the first one that fires. Cut the string or cut the part that fired.

1. **Does this need to surface at all?**
   Would the user ever have wondered about this, unprompted? If not, you are not answering a question. You are planting one. Under the theme picker sat "Theme changes apply instantly across the entire app". Nobody picks a theme wondering whether it will reach the whole app. The line went and the picker lost nothing.

2. **Does the caption need to exist?**
   A caption earns its place only when the thing beside it is meaningless without it. A checkbox labelled "Require sign-in" had "Users must sign in before accessing this app." beneath it. A heading "Recent payments" had "The latest payments received by this business." Both went. A bare "30" does need "minutes" beside it. That one stays.

3. **Is it answering something the user would never have had to consider?**
   The tell: copy that rules out a failure, defends a choice or hedges about something that simply works.

   > Bring the existing site into blocks.
   > *Your current index.html will become one custom HTML block, so every byte stays intact.*

   The first half says what will happen. The second half denies a loss the user had not imagined until we named it. A list of job postings said "Every link is a real posting." An error said "Could not regenerate the scoreboard. Your current one is unchanged." Each one hands the reader a worry they arrived without. The same goes for a line that remembers an old bug. **The fix for a fixed bug is the fix. Not a caption about the fix.**

4. **Rewrite to remove the part that fired. If nothing is left, delete the element.**
   Do not preserve a hint just because there was a hint there. An empty `hint` prop comes off the component. An explanatory `<p>` gets deleted, not shortened to a stub.

## What survives

Copy stays when the user cannot act without it. These lines went through the same review and stayed word for word:

- A real consequence at the moment of choosing. *"Remove Dana from the team? Their notes are kept."* They need it before they click and they cannot infer it.
- A fact about scope they cannot see. *"Visitor chat history from the last 90 days."* Nothing else on the page says where the history stops.
- What a blank or stuck state means and what to do next. *"This computer is asleep. Send it one message to wake it, then come back."*
- Units, scale or format on a bare value.

A line can be half of each. *"Only work you start uses it. Your teammates never do, and you can disconnect any time."* The first part is scope the user cannot see. The last part tells them they may press a Disconnect button that is already on the screen. Keep the scope. Cut the permission slip.

## Working style

- Read the string next to what is on screen around it: the label, the value, the button. Redundancy is invisible when you read the string alone.
- Cut whole clauses, not words. Noticing which half of a two-sentence hint does no work beats trimming three words from both halves.
- When reviewing a batch, report as `file:line` with the current string and either the rewrite or `cut`. Say in a few words which rung it failed. Do not rewrite copy that passes.
- If a string matters only in a rare state, consider whether it belongs in that state instead of sitting on the page all the time.

## Get a second reader before you cut

Cutting is easy to overdo. On the first real run the first reader marked 40 lines and a second reader kept 15 of them, mostly lines about billing and failed states that told the user something they could not see.

- Hand the batch to a second reader on a different model. Give it the strings and this skill, not your verdicts or your reasons.
- Mix in lines you are sure should stay. A reader that cuts those is cutting too much and its other verdicts are not worth much.
- Change a line only where both readers agree. When they disagree the line stays.

## After the cut

- A removed line takes its spacing with it. Look at the gap it leaves between the heading and the button.
- Tests often quote the old string. Search for it before you run them.

## Go deeper

- [../copy-editor/SKILL.md](../copy-editor/SKILL.md): fixes how a sentence reads. Run this skill first, since a deleted string needs no editing.
- [../taste/SKILL.md](../taste/SKILL.md): where the taste of the people you work for lives.
- [../design/SKILL.md](../design/SKILL.md): the visual rules for the screen the copy sits on.
