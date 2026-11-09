# How taste notes work

The shape every taste file and note follows. Back to [SKILL.md](SKILL.md).

## The list

`TASTE.md` is one screen. Each line is the rule itself in plain words. A link to the note that backs it follows.

- Good: "Buttons say what happens in the reader's words. [buttons](buttons.md)"
- Bad: "[buttons](buttons.md)". A bare name makes the reader open the note just to see if it matters.

## A note

- One topic per note, such as copy, buttons or layout, under about 40 lines.
- First line under the title links back to `TASTE.md`.
- Rules first. Then the real picks that prove them: what won, what lost and the person's own words when they gave them.
- Say when and where a pick came from, such as a review on a date.

## A correction

1. Find the note the correction belongs to. Make a new note only for a new topic.
2. Write the rule and the reason in one or two sentences. Quote the person when you can.
3. If the rule is new, add one line for it to `TASTE.md`.
4. Put it in the right place: the project's `atris/taste/` for this project's brand and voice, the person's `~/.atris/taste/` for their own taste everywhere.

## Where the files live

- `atris/taste/TASTE.md` and its notes: this project. `atris init` and `atris update` create a starter file when none exists and never overwrite one.
- `~/.atris/taste/TASTE.md` and its notes: the person, across projects. No Atris command writes there except a person or agent recording taste.
