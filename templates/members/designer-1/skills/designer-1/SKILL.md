---
name: designer-1
description: Build web screens from a fixed set of parts, on one spacing scale, with almost no text, and check them before reporting. Use when designing or changing an interface.
version: 1.0.0
tags:
  - design
  - frontend
---

# designer-1

Design is everything. Make a part once, then use it again.

Every rule here is a check. A reviewer can run it and get pass or fail.

Covers web. iOS is next.

## 0. taste first

1. Read `atris/taste/TASTE.md` in the project if it exists. Then the person's own taste file, `~/.atris/taste/TASTE.md`, if it exists.
2. Order when they disagree: project taste, then the person's taste, then this file.
3. Taste can change a default. It cannot remove the rule that every control has a name.
4. Never write a correction into this skill. Project corrections go in `atris/taste/TASTE.md`.

## 1. reuse first

Before writing any control:

1. Look for the Atris parts. The project has them when `package.json` lists `@atris/design-react` or the code imports from it. Use these 18: `Button`, `Field`, `Input`, `Textarea`, `Checkbox`, `Switch`, `RadioGroup`, `Select`, `Dialog`, `Popover`, `Menu`, `Tooltip`, `Toast`, `Tabs`, `Accordion`, `SegmentedControl`, `Combobox`, `Slider`.
2. No Atris parts: search the project's own component folder (`components/`, `src/components/`, `app/components/`, `ui/`) for a control with the same job. Use it.
3. Nothing fits: build the part once, in the one shape (section 2), in the folder where the other parts live. Export it. Then import it on this screen.
4. Never restyle a part inline for one screen. No `style` or `className` on a part that changes its color, size, radius or spacing. A new look for everyone changes the part. A variant uses a `size` or `tone` value.
5. A native `<button>`, `<input>`, `<select>` or `role=` element written straight into a screen file, when a part covers that job, fails this rule.

Check: list every control on the screen. Each one is a part import or a project component. Count the new ones.

## 2. the one shape

Every part, new or old:

- `label`: required plain string, the accessible name. `hideLabel` hides it on screen and keeps it for screen readers and agents.
- Pickers take `options`. Containers take `items`. Each entry is `{ value, label, disabled?, data? }`.
- Empty choice is `null`.
- Callbacks: `onValueChange`, `onCheckedChange`, `onOpenChange`. An action that is not a value is `onSelect`.
- `disabled` is the only disabled prop. `readOnly` refuses every change.
- `ref`, `id`, `data-*` land on the real control. `className` lands on the outer element.
- Sizes: `small`, `default`, `large`. Tones: `default`, `primary`, `quiet`, `success`, `danger`. No other values.
- Pass `value`, `checked` or `open` to own the state. The callback runs on every attempt so a parent can refuse.

Props for all 18: [parts.md](parts.md). Open it only when you place or build a part.

## 3. spacing

One scale. Atris token names first. A project with its own token file maps the same steps to its names. A project with no token file gets one, made once, with this scale.

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

The other steps (`-5` 10px, `-7` 14px, `-9` 20px) are for inside a part only.

Rules:

1. No spacing value outside the scale. Every margin, padding, gap and inset is a token, `0`, or `calc(var(--atris-part-space-10) * n)`.
2. The gap between groups is at least twice the gap inside a group.
3. Siblings of the same kind share one gap.
4. One left edge per column. Labels, controls, headings and text in a column start at the same x.
5. Labels sit above controls.
6. Numbers in a column align right.
7. A row of controls shares one size. Dialog and form buttons end-align, primary last.

Control heights:

| token | px | use |
|---|---|---|
| `--atris-part-height-small` | 30 | dense tables, toolbars on desktop |
| `--atris-part-height` | 36 | default |
| `--atris-part-height-large` | 44 | phone, primary action |
| `--atris-part-touch` | 44 | minimum touch target on phone |
| `--atris-part-icon-button` | 32 | icon button; wrap in a 44 target on phone |

Text: `--atris-part-text-body` (14) for reading, `--atris-part-text-title` (16) for headings, `--atris-part-text-supporting` (13) and `--atris-part-text-metadata` (12) for secondary lines. At most three text sizes per screen.

Color, radius and motion: house tokens only (`--ink`, `--surface`, `--accent`, `--line`, `--radius-control`, `--radius-card`, `--motion`, `--ease-out`). One accent per screen, on the primary action.

## 4. never

| never | detect |
|---|---|
| em dash (U+2014) in copy, code or docs | `atris slop detect <path>` rule `em-dash` |
| text that explains the interface instead of labelling it | visible copy containing "click", "tap", "here you can", "this page", "this button", "below", "above", "lets you", "allows you", "simply" |
| too much text | any region over the word budget |
| pulsing, glowing or looping animation | `atris slop detect` rules `pulse-animation` and `colored-glow-shadow`; any animation with an infinite iteration count |
| raw colors or sizes outside tokens | hex, `rgb(`, `hsl(` or `oklch(` outside the token file; a number with `px`, `rem` or `em` outside a `var(`; a Tailwind arbitrary value like `[13px]` |
| a control without a name | page reader snapshot entry with an empty `label`; a part used without `label` |

Word budget, counted on what the person sees, not their own data:

| region | max words |
|---|---|
| button, tab, option, menu item | 3 |
| field label | 4 |
| heading | 6 |
| toast | 6 |
| hint or error | 12 |
| empty state | 12 |
| dialog description | 20 |
| whole screen | 120 |

Labels are lowercase unless project taste says otherwise.

## 5. opinions

Asked for options, pick one. Say why in one sentence. Show the others only if asked, one line each.

Example: "tabs, because the three views share one record and the person switches often."

## 6. pace

One screen per pass. Show it. Change one thing per round. Reused parts make each round cheap.

## 7. self-check before reporting

Run all five on the changed screen. A check that cannot run is reported as not run, never as passed.

1. Keyboard: Tab from the top through the main flow. Every control is reached in visual order, shows a focus ring, works with Enter or Space. Escape closes the top popup and focus returns to its trigger.
2. Page reader: load `lib/agent-page.js` from the atris package (`node_modules/atris/lib/agent-page.js`, or under `npm root -g` for a global install) into the running page. Call `AgentPage.createAgent().snapshot()`. Pass when every entry has a non-empty `label` and no two controls in one region share a label. Report any entry of kind `unread`. Then run the main flow with `act`, naming each step by `label` only. Pass when every step returns ok.
3. Words: count each region against the budget.
4. Widths: open the screen at 390px (phone, real device emulation) and 1280px (desktop). Look at both. Pass when nothing scrolls sideways, touch targets are at least 44px on phone, and no text overlaps or clips.
5. Gate: `atris slop detect <changed paths>` exits 0.

## 8. report

Lowercase. No prose around it.

```
reused: Button, Field, Select
new: PlanCard (components/parts/plan-card.tsx)
keyboard: pass, 7 stops in order
names: pass, 12 controls named, 0 unread
flow by name: pass, 4 steps
words: pass, 64 of 120
phone 390: pass
desktop 1280: pass
slop: pass
```
