---
name: designer-1
description: Build complete web screens from a fixed set of parts, on one spacing scale, with few words and check them before reporting. Use when designing or changing an interface.
version: 1.2.1
tags:
  - design
  - frontend
---

# designer-1

Design is everything. Make a part once, then use it again.

Covers web. iOS is next.

## 0. taste first

1. Read `atris/taste/TASTE.md` in the project, then the person's own `~/.atris/taste/TASTE.md`. Project taste wins over the person's; both win over this file.
2. Taste can change a default. It cannot remove the rule that every control has a name.
3. Never write a correction into this skill. Project corrections go in `atris/taste/TASTE.md`.

## 1. the list

Completeness comes before restraint. Before designing, write:

1. Every capability the request names. If a thing can be added and can change, changing it is a capability too.
2. Every state of each one: empty, error, pending, done, undo. Write "none" with a reason when a state cannot happen.

Nothing on the list is cut to save words. Restraint decides how a thing is said, never whether it is there.

## 2. reuse first

Before writing any control:

1. Look for the Atris parts: `package.json` lists `@atris/design-react`, or the code imports from it. Use these 19: `Button`, `Field`, `Input`, `Textarea`, `Checkbox`, `Switch`, `RadioGroup`, `Select`, `Dialog`, `Popover`, `Menu`, `Tooltip`, `Toast`, `Tabs`, `Accordion`, `SegmentedControl`, `Combobox`, `Slider`, `RowList`.
2. No Atris parts: search the project's component folder for a control with the same job.
3. Nothing fits: build the part once, in the one shape, in the folder where parts live. Export it, then import it.
4. Never restyle a part inline for one screen: no `style` or `className` that changes its color, size, radius or spacing. Change the part, or use a `size` or `tone` value.
5. A native `<button>`, `<input>` or `<select>` in a screen file, where a part covers that job, fails.

## 3. the one shape

- `label`: required plain string, the accessible name. `hideLabel` hides it on screen only.
- Pickers take `options`. Containers take `items`. Each entry is `{ value, label, disabled?, data? }`. Empty choice is `null`.
- Callbacks: `onValueChange`, `onCheckedChange`, `onOpenChange`; an action that is not a value is `onSelect`.
- `disabled` is the only disabled prop. `readOnly` refuses every change.
- Sizes: `small`, `default`, `large`. Tones: `default`, `primary`, `quiet`, `success`, `danger`.
- Pass `value`, `checked` or `open` to own the state; the callback runs on every attempt so a parent can refuse.

Props for all 19: [parts.md](parts.md). Open it only when you place or build a part.

## 4. spacing

One scale, Atris token names first. A project token file maps the same steps to its names. No token file: make one, once, with this scale.

| token | px | use |
|---|---|---|
| `--atris-part-space-1` | 2 | icon nudge |
| `--atris-part-space-2` | 4 | label to control, control to hint |
| `--atris-part-space-3` | 6 | icon to text inside a control |
| `--atris-part-space-4` | 8 | between sibling buttons, chips, options |
| `--atris-part-space-6` | 12 | between fields in one group |
| `--atris-part-space-8` | 16 | panel padding on phone |
| `--atris-part-space-10` | 24 | between groups; panel padding on desktop |
| `calc(var(--atris-part-space-10) * 2)` | 48 | between page regions |

Steps `-5` (10px), `-7` (14px), `-9` (20px) are for inside a part only.

1. No spacing value outside the scale: every margin, padding, gap and inset is a token, `0`, or `calc(var(--atris-part-space-10) * n)`.
2. The gap between groups is at least twice the gap inside a group.
3. Siblings of the same kind share one gap.
4. One left edge per column.
5. Labels sit above controls.
6. Numbers in a column align right.
7. A row of controls shares one size. Dialog and form buttons end-align, primary last.
8. Nothing fixed to a screen edge covers content: a sticky or fixed bar reserves its own height in the page.

| height token | px | use |
|---|---|---|
| `--atris-part-height-small` | 30 | dense tables, desktop toolbars |
| `--atris-part-height` | 36 | default |
| `--atris-part-height-large` | 44 | phone, primary action |
| `--atris-part-touch` | 44 | minimum touch target on phone |

Text: page title `calc(var(--atris-part-text-title) * 1.25)` (20), section headings `--atris-part-text-title` (16), body `--atris-part-text-body` (14), one secondary size (`--atris-part-text-metadata`, 12). The title is at least 1.25 times a section heading, or one step above it in a project scale. At most four sizes.

Color, radius, motion: house tokens only (`--ink`, `--accent`, `--line`, `--radius-control`, `--motion`, `--ease-out`). One accent, on the primary action.

## 5. words

Three kinds of text:

- label: names a thing or an action and must be enough to act on. "anyone with the link", not "anyone".
- consequence: what an action will do, in numbers. Example: "charge $40.00 today, then $120.00 a month from 1 dec".
- explanation: how to work the screen. Example: "click here to change your plan".

Consequence is required. Explanation is never allowed.

Before any action that spends money, deletes, sends, or cannot be undone, the screen states the amount, when and what changes. "an adjustment on your next invoice" fails: no amount, no date.

Words follow the truth. Never promise what the screen does not do. Two places never contradict. Text tied to a state changes with the state: "charged today" does not survive a declined payment.

After an action that cannot be undone, withdraw any earlier undo it would conflict with.

A choice carries enough to choose. When options differ in ways a label cannot hold (plans, roles, visibility), each shows its difference in one short line, or the group gets a small comparison of at most five rows.

## 6. never

| never | detect |
|---|---|
| em dash (U+2014) in copy, code or docs | `atris slop detect <path>` rule `em-dash` |
| explanation text | visible copy containing "click", "tap", "here you can", "this page", "this button", "below", "above", "lets you", "allows you", "simply" |
| a risky action without its consequence | confirm text for spend, delete, send or no-undo with no number or no date |
| a vague label | a label that does not say who, what or how much |
| too much text | any region over the word budget |
| pulsing, glowing or looping animation | `atris slop detect` rules `pulse-animation` and `colored-glow-shadow`; an infinite iteration count |
| raw colors or sizes outside tokens | hex, `rgb(`, `hsl(` or `oklch(` outside the token file; a number with `px`, `rem` or `em` outside a `var(`; a Tailwind arbitrary value like `[13px]` |
| a control without a name | snapshot entry with an empty `label`; a part used without `label` |

Word budget, on what the person sees, not their own data:

| region | max words |
|---|---|
| button, tab, option, menu item | 3 |
| field label | 4 |
| heading | 6 |
| toast | 6 |
| option difference line | 8 |
| hint or error | 12 |
| empty state | 12 |
| dialog description | 20 |
| consequence confirmation | 40 |
| whole screen, without consequence and comparison text | 120 |

A consequence confirmation gets 40 because amount, date, what changes and what stays each need about ten words.

Labels are lowercase unless project taste says otherwise.

## 7. opinions and pace

Asked for options, pick one and say why in one sentence: "tabs, because the views share one record."

One screen per pass. Change one thing per round.

## 8. self-check before reporting

A check that cannot run is reported as not run, never as passed.

1. **list**: reach every capability and state from section 1 on the screen.
2. **keyboard**: Tab through the main flow: visual order, visible focus ring, Enter or Space works, Escape closes the top popup and returns focus to its trigger.
3. **names**: load the atris package's `lib/agent-page.js` into the running page and call `AgentPage.createAgent().snapshot()`. Pass when every entry has a non-empty `label`, unique within its region. Report entries of kind `unread`.
4. **flow by name**: run the main flow with `act`, each step named by `label` only. Dropdowns take `set`; menu items take `click` once the menu is open. A part the reader cannot operate stays and is named in the report; never change the design silently to pass.
5. **failure path**: every form and money action has an error state designed. Reach one per form or money action (bad input, declined payment, lost connection).
6. **truth**: after each failure path and each risky action, read every sentence on the screen against "words follow the truth". Then try each undo still offered; one that conflicts with the later action fails.
7. **words**: count each region against the budget.
8. **widths**: 390px (real phone emulation) and 1280px. Pass when nothing scrolls sideways or clips.
9. **targets**: at 390px, measure every control's box in the running page (`getBoundingClientRect`). Fail any under 44px wide or tall. Never assume a size from the code.
10. **edges**: at 390px, scroll to the bottom. Pass when the last control and its label are fully visible, clear of any fixed bar.
11. **slop**: `atris slop detect <changed paths>` exits 0.

## 9. report

Lowercase. No prose around it.

```
reused: Button, Field, Select
new: PlanCard (components/parts/plan-card.tsx)
list: pass, 5 capabilities, 21 states reached
keyboard: pass, 7 stops in order
names: pass, 12 controls named, 0 unread
flow by name: pass, 4 steps; DatePicker not operable, kept
failure path: pass, 2 of 2 reached
truth: pass, 31 sentences after 3 changes, 1 undo withdrawn
words: pass, 64 of 120
widths: pass at 390 and 1280
targets: pass, smallest 44px
edges: pass, last control clear
slop: pass
```
