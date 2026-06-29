# design-seed.md — atris visual identity

> Generated from a design interview on 2026-06-23.
> This is the project's unique design DNA. Not a template — a conviction.
> Every design decision for Atris surfaces should reference this seed.

---

## the interview (source signal)

| question | answer |
|----------|--------|
| audience | designers, product enthusiasts, apple lovers, artsy people |
| anti-attractor | AI startup slop — purple gradients, claude beige, instrument serif |
| personality | warm-technical — sharp but human, approachable craft |
| color mood | warm earth — clay, bone, ink, ochre |

**the move:** this is not a dev tool that needs to look "technical." this is a crafted object that happens to be powerful. the bar is set by people who notice the kerning on a restaurant menu.

---

## typography

**display: Spectral**
- warm serif designed for screens (Production Type)
- intellectual without being precious
- has optical sizing — gets more expressive at large sizes
- NOT instrument serif (the AI tell), NOT Fraunces (getting there), NOT Playfair (overused)
- weights: 200 (light, for quiet headlines) and 700 (for bold statements)
- italic available — use sparingly, for emphasis only

**body: Hanken Grotesk**
- humanist sans with warmth and character
- not inter, not roboto, not system — has a hand to it
- weights: 400 (body), 600 (emphasis)
- slightly more readable than geometric sans at small sizes

**mono: JetBrains Mono**
- for code, CLI output, technical labels only
- never as a "developer vibe" design choice

**type scale (fluid):**
```css
--font-display: 'Spectral', Georgia, serif;
--font-body: 'Hanken Grotesk', system-ui, sans-serif;
--font-mono: 'JetBrains Mono', monospace;

--text-xs: 0.75rem;
--text-sm: 0.875rem;
--text-base: 1rem;
--text-lg: clamp(1.25rem, 1rem + 1vw, 1.5rem);
--text-xl: clamp(1.75rem, 1rem + 3vw, 2.5rem);
--text-display: clamp(2.5rem, 1rem + 6vw, 5rem);
```

**rules:**
- display font for headlines only. body stays in Hanken.
- weight extremes: 200 vs 700, never 400 vs 500.
- size jumps are dramatic (3x), not timid.
- line-height: 1.6 for body (generous, warm). 1.1 for display (tight, confident).
- max-width: 62ch for long-form. let it breathe.

---

## color

warm earth palette. everything tinted warm. no pure gray, no pure black, no pure white.

```css
:root {
  /* surfaces */
  --bone:     oklch(96% 0.012 75);   /* warm paper — the base */
  --bone-2:   oklch(93% 0.014 72);   /* slightly deeper, for sections */
  --ink:      oklch(22% 0.015 55);   /* warm near-black — primary text */
  --ink-soft: oklch(35% 0.012 55);   /* secondary text, still warm */
  --ink-faint:oklch(55% 0.010 60);   /* tertiary, metadata */

  /* accents — used rarely, earn their place */
  --clay:     oklch(58% 0.13 45);    /* terracotta — the sharp accent */
  --ochre:    oklch(72% 0.09 75);    /* warm gold — for highlights */
  --moss:     oklch(42% 0.04 145);   /* deep muted green — secondary accent */

  /* depth */
  --shadow:   oklch(15% 0.01 55);    /* deepest warm dark */
  --line:     oklch(88% 0.010 70);   /* warm hairline borders */
}
```

**usage rules:**
- `--bone` is the default background. never `#fff`. never `#f5f5f5`.
- `--ink` is the default text. never `#000`. never `#1a1a1a`.
- `--clay` is the one sharp accent. use it for one thing per view — a link, a CTA, a key number. if you use it for three things, it's not an accent anymore.
- `--ochre` for subtle highlights (selection, hover warmth). never for text.
- `--moss` appears rarely — maybe a status indicator, a secondary chart. it's the surprise.
- never put `--ink-faint` text on `--clay` backgrounds. use `--bone` on `--clay`.
- dark mode: invert to warm dark (`oklch(18% 0.015 55)` background, `--bone` text). never zinc, never pure dark.

---

## spacing

warm-technical means generous but not wasteful. more space than feels comfortable, then a little more.

```css
--space-xs:  0.5rem;
--space-sm:  1rem;
--space-md:  2rem;
--space-lg:  4rem;
--space-xl:  8rem;    /* section gaps — dramatic */
--space-2xl: 12rem;   /* used sparingly, for major breaks */
```

**rhythm:** vertical spacing locked to `--space-md` (2rem) as the base unit. section gaps are `--space-xl` (8rem). this creates a 1:4 ratio between content rhythm and section breaks — you feel the structure without seeing it.

---

## layout

**editorial, not templated.**

- no hero + 3 cards + footer. ever.
- asymmetric layouts. left-aligned with intentional negative space on the right.
- wide margins (clamp(1.5rem, 8vw, 8rem)) — content sits in the center 60-70% of the viewport.
- sections separated by `--space-xl` (8rem) of pure `--bone`. the space IS the design.
- no cards unless content genuinely needs a container. most things sit directly on `--bone`.
- if you must group, use `--bone-2` (slightly deeper) with no border, or a single `--line` hairline.

**the page should feel like a well-set book page, not a dashboard.**

---

## motion

warm-technical = things take their time, but nothing wastes it.

```css
--ease: cubic-bezier(0.25, 1, 0.5, 1);   /* exponential ease-out */
--dur-fast: 200ms;
--dur-base: 350ms;    /* slightly slower than default — warm */
--dur-slow: 600ms;    /* for page reveals */
```

- one reveal animation on page load: staggered fade-up, 80ms between elements, `--dur-slow`.
- hover: subtle warm brighten (filter: brightness(1.05)) + scale 1.02. never shift, never hide.
- no cursor effects. no meteor showers. no parallax.
- `prefers-reduced-motion`: everything instant. the static version must be beautiful on its own.

---

## the anti-attractor lock

these are banned for Atris surfaces, derived from the interview:

| banned | why |
|--------|-----|
| purple-to-blue gradients | AI slop fingerprint #1 |
| off-white / `#fafafa` backgrounds | "claude beige" — the new AI default |
| instrument serif (italic) | the new AI tell — everyone uses it |
| inter / roboto / system fonts | statistically average, aesthetically dead |
| glassmorphism | decorative blur = no point of view |
| dark mode with neon accents | "cool" without a design decision |
| hero + 3 cards + footer | the template. every AI does this. |
| gradient text on headlines | looks impressive, means nothing |
| rounded-rect with drop shadow | safe, forgettable, templated |
| all-caps tracked labels | keshav hates it. not warm. |

---

## the conviction

this design says: **we care about the thing you're looking at, not the fact that we made it.**

it's warm paper, warm ink, one sharp terracotta accent, a serif that has opinions, and enough negative space that you notice the content. it doesn't shout. it doesn't perform. it's made well, and you can feel that before you can name it.

if a designer looks at this and thinks "AI made this," we failed.
if they think "someone made this," we're on track.
if they think "who made this?" — that's the goal.

---

## references (inspiration, not copies)

- Aesop.com — warm earth, editorial, restraint
- Apple product pages — typography confidence, negative space
- Linear changelog — warm-technical writing in a UI
- Istituto Marangoni — editorial layout, Italian craft
- a well-printed paperback — the feeling we're chasing
