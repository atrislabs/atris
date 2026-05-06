# atris-design.md — frontend aesthetics

> ai-generated ui has a look. you know it when you see it. this policy helps you not make that.

---

## the problem

models default to safe choices because that's what dominates training data. without guidance you get:
- inter/roboto fonts
- purple gradients on white
- hero + 3 cards + testimonials + footer
- zero animation
- flat, lifeless backgrounds

this is the "distribution center" — statistically average, aesthetically dead.

---

## typography

**avoid:** inter, roboto, open sans, lato, arial, montserrat, system defaults. also avoid monospace as lazy shorthand for "technical/developer" vibes.

**never:** all-caps UI labels, tracked-uppercase labels, faux small-caps, or eyebrow-style metadata on ordinary product surfaces. Keshav strongly dislikes this style. Use natural title case or sentence case instead: `Threads`, `Active tasks`, `Team`, not `THREADS`, `ACTIVE TASKS`, or letter-spaced microcopy.

**try instead:**
- instead of inter → instrument sans, plus jakarta sans, outfit
- instead of roboto → onest, figtree, urbanist
- instead of open sans → source sans 3, nunito sans, dm sans
- editorial/premium → fraunces, newsreader, lora, playfair display, crimson pro
- dev tools → jetbrains mono, fira code
- clean technical → ibm plex, source sans

**the move:** pick ONE distinctive font. use weight extremes (200 vs 800, not 400 vs 500). size jumps should be dramatic (3x), not timid (1.2x).

**type scale:** use a modular scale with fluid sizing. 5 sizes covers most needs:

| role | size | use |
|------|------|-----|
| xs | 0.75rem | captions, legal |
| sm | 0.875rem | secondary UI, metadata |
| base | 1rem | body text |
| lg | 1.25-1.5rem | subheadings, lead |
| xl+ | 2-4rem | headlines, hero |

use `clamp()` for fluid sizing: `clamp(1rem, 0.5rem + 2vw, 2rem)`. use `ch` units for measure: `max-width: 65ch` for readable body text.

**vertical rhythm:** your `line-height` should be the base unit for all vertical spacing. if body is `line-height: 1.5` on `16px` (= 24px), spacing values should be multiples of 24px.

**font loading:** prevent layout shift with proper loading:
```css
@font-face {
  font-family: 'CustomFont';
  src: url('font.woff2') format('woff2');
  font-display: swap;
}
```
match fallback metrics with `size-adjust`, `ascent-override`, `descent-override` to minimize FOUT reflow.

---

## color

**avoid:** purple/violet on white, generic startup palettes, safe grays, pure black (#000), pure white (#fff), the AI color palette (cyan-on-dark, purple-to-blue gradients, neon accents on dark backgrounds), gradient text for "impact"

**the move:** commit to a palette and stick to it. use css variables. one dominant color with a sharp accent beats five evenly-distributed colors.

**use OKLCH:** modern, perceptually uniform color space. equal steps in lightness actually look equal.
```css
:root {
  --brand: oklch(65% 0.2 250);
  --brand-light: oklch(90% 0.05 250);
  --brand-dark: oklch(30% 0.15 250);
}
```

use `color-mix()` for variants: `color-mix(in oklch, var(--brand) 80%, white)`. use `light-dark()` for theme-aware values.

**tint your neutrals:** never use pure gray. always tint toward your brand hue — even 0.01 chroma in OKLCH creates subconscious cohesion:
```css
--gray-100: oklch(95% 0.01 250); /* not #f5f5f5 */
--gray-900: oklch(15% 0.01 250); /* not #1a1a1a */
```

**gray on color:** never put gray text on colored backgrounds. it looks washed out. use a darker shade of the background color or transparency instead.

dark backgrounds are easier to make look good. steal from places you like — linear.app, vercel.com, raycast.com, arc browser. but don't default to dark mode with glowing accents — it looks "cool" without requiring actual design decisions.

---

## layout

**avoid:** the template look — hero section, 3 feature cards, testimonial carousel, big footer. every ai does this. also avoid:
- wrapping everything in cards — not everything needs a container
- nesting cards inside cards — visual noise, flatten the hierarchy
- identical card grids — same-sized cards with icon + heading + text, repeated endlessly
- the hero metric layout — big number, small label, supporting stats, gradient accent
- centering everything — left-aligned text with asymmetric layouts feels more designed
- same spacing everywhere — without rhythm, layouts feel monotonous

**the move:** break the grid sometimes. asymmetry is interesting. whitespace is a feature, not wasted space. don't cram everything into 16px/24px spacing — use dramatic gaps.

**fluid spacing:** use `clamp()` for spacing that breathes on larger screens:
```css
padding: clamp(1rem, 3vw, 4rem);
gap: clamp(1.5rem, 4vw, 6rem);
```

**container queries:** use `@container` for component-level responsiveness instead of only viewport breakpoints. components should adapt to their container, not just the screen.

---

## motion

**avoid:** static pages with nothing moving, or the opposite — bouncing everything

**specific anti-patterns:**
- cursor-following lines or elements
- meteor/particle effects shooting across screen
- buttons that follow the cursor (harder to click, not clever)
- FAQ/content that breaks if you scroll past before the fade-in finishes
- animations that swap styles endlessly without purpose (rotating shapes, morphing buttons)
- bounce or elastic easing — they feel dated and tacky. real objects decelerate smoothly.

**the move:** one well-timed animation beats ten scattered ones. page load with staggered reveals (50-100ms delays) creates more impact than hover effects on every button.

**easing:** use exponential easing for natural deceleration:
```css
--ease-out-quart: cubic-bezier(0.25, 1, 0.5, 1);
--ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
```
never linear, never bounce, never elastic. 150-300ms duration for most transitions.

**only animate transform and opacity.** never animate width, height, padding, margin — they trigger layout recalculation and cause jank. for height animations, use `grid-template-rows` transitions.

**reduced motion:** always respect `prefers-reduced-motion`. provide a beautiful static alternative:
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## interaction

**progressive disclosure:** start simple, reveal sophistication through interaction. basic options first, advanced behind expandable sections. hover states that reveal secondary actions.

**optimistic UI:** update immediately, sync later. makes everything feel fast.

**empty states:** design empty states that teach the interface, not just say "nothing here." show users what to do next.

**button hierarchy:** don't make every button primary. use ghost buttons, text links, secondary styles. hierarchy matters.

**every interactive element needs ALL states:**
- default — resting
- hover — subtle feedback (brighten, scale 1.02-1.05)
- focus — visible keyboard indicator (never remove without replacement)
- active — click/tap feedback
- disabled — clearly non-interactive
- loading — async action feedback
- error — validation state
- success — confirmation

missing states create confusion and broken experiences.

---

## hover states

**avoid:**
- elements that fade out or disappear on hover
- nav items that shift position or slide horizontally on hover
- arrows/icons that move backwards or vertically on hover
- hiding critical info or functionality behind hover (hover doesn't exist on mobile)

**the move:** hover should make elements feel "lickable" — inviting to click. slightly brighten, scale up (1.02-1.05), or add a subtle glow. the user should feel pulled toward clicking, not confused about what happened.

test every hover on mobile. if something only works on hover, it's broken for half your users.

---

## responsive

**avoid:** hiding critical functionality on mobile — adapt the interface, don't amputate it. also avoid:
- fixed widths that break on small screens
- touch targets smaller than 44x44px
- text smaller than 14px on mobile
- horizontal scroll from content overflow

**the move:** mobile-first, then enhance for larger screens. use fluid layouts with `clamp()` and container queries. adapt the interface for different contexts — don't just shrink it.

```css
/* container queries > media queries for components */
@container (min-width: 400px) {
  .card { flex-direction: row; }
}
```

---

## scroll behavior

**avoid:** scrolljacking — never override native browser scroll with custom scroll logic. it feels like "moving through molasses" and users hate it.

**the move:** let the browser handle scrolling. if you want scroll-triggered effects, use intersection observer to trigger animations as sections enter the viewport — but don't mess with scroll speed or direction.

use the "peeking" technique: let a few pixels of the next section peek above the fold instead of full-screen heroes with "scroll down" arrows. this naturally signals more content below.

---

## backgrounds

**avoid:** solid white, solid light gray, flat nothing

**the move:** add depth. layered gradients, subtle patterns, mesh effects. backgrounds set mood — flat backgrounds say "I didn't think about this."

but don't use glassmorphism everywhere — blur effects, glass cards, glow borders used decoratively rather than purposefully. it's AI slop.

---

## accessibility

this isn't optional — it's part of good design.

- **contrast:** 4.5:1 minimum for text, 3:1 for UI components (WCAG AA)
- **focus indicators:** visible, high-contrast focus rings on all interactive elements. never `outline: none` without a replacement.
- **semantic HTML:** use proper heading hierarchy, landmarks, buttons (not divs), labels on inputs
- **color independence:** never use color as the only indicator. add icons, labels, or patterns alongside.
- **keyboard nav:** logical tab order, no keyboard traps, all functionality accessible without a mouse

---

## visual details

**avoid:**
- glassmorphism everywhere (blur effects, glass cards, glow borders)
- rounded elements with thick colored border on one side — lazy accent
- sparklines as decoration — tiny charts that convey nothing meaningful
- rounded rectangles with generic drop shadows — safe, forgettable
- large icons with rounded corners above every heading — templated look
- modals unless there's truly no better alternative — modals are lazy
- non-system emojis used as decoration (lazy AI tell)

---

## ux writing

**make every word earn its place.**
- don't repeat information users can already see
- don't repeat the same information — redundant headers, intros that restate the heading
- labels and buttons should be unambiguous
- error copy should help users fix the problem, not blame them
- empty states should guide toward action

---

## information hierarchy

**avoid:** mixing 4-5 competing text styles on one page. labels, headers, subheaders, badges, and body text all fighting for attention.

**the move:** pick 2-3 levels max. one dominant style, one supporting, one accent. if you add a new style, ask: does this earn its place or is it clutter?

---

## hero section (the H1 test)

your hero must answer four questions in seconds:
1. **what is it?** — clear product description
2. **who is it for?** — the target user
3. **to what end?** — why should they care
4. **what's the CTA?** — one clear next step

if a stranger can't answer all four in 5 seconds of looking at your hero, rewrite it.

---

## assets

**avoid:**
- blurry or low-res screenshots
- "fake dashboard" mockups with Fisher-Price primary colors (red/yellow/green/blue)
- non-system emojis used as decoration (lazy AI tell)

**the move:** real product screenshots at high resolution. if you don't have a product yet, use a well-designed mockup — but make it sharp and believable.

---

## context matters

don't impose an aesthetic — match the project. a fintech dashboard shouldn't look like a gaming site. read the room.

if the project already has a design system, use it. don't fight it to show off.

---

## the convergence trap

even with this guidance you'll find new defaults. space grotesk becomes the new inter. dark mode with amber accents becomes the new purple gradient.

vary your choices. alternate themes. try different directions between projects.

---

## before shipping

- can you name the aesthetic in 2-3 words?
- did you pick a real font, not a default?
- is there at least one intentional animation?
- does the background have depth?
- do hover states feel inviting, not confusing?
- does scrolling feel native?
- does the hero pass the H1 test (what/who/why/CTA)?
- are all screenshots/assets crisp?
- do all interactive elements have all states (hover/focus/active/disabled/loading/error)?
- does it meet WCAG AA contrast (4.5:1 text, 3:1 UI)?
- does it work on mobile (touch targets, no horizontal scroll, readable text)?
- does it respect `prefers-reduced-motion`?
- would a designer immediately clock this as ai-generated?

if the last answer is yes, you're not done.

---

## the ai slop test

> "if you showed this interface to someone and said 'AI made this,' would they believe you immediately? if yes, that's the problem."

the fingerprints of AI-generated work:
- inter/roboto/system fonts
- purple-to-blue gradients
- cyan-on-dark color schemes
- glassmorphism everywhere
- gradient text on headings/metrics
- hero metric layout (big number + small label)
- identical card grids
- bounce/elastic easing
- dark mode with neon accents
- sparklines as decoration
- rounded rectangles with drop shadows
- large icons with rounded corners above headings

a distinctive interface should make someone ask "how was this made?" not "which AI made this?"

---

## references

look at these for inspiration, not to copy:
- linear.app (dark, polished, purposeful motion)
- vercel.com (clean, confident, good typography)
- raycast.com (dark ui done right)
- stripe.com (light mode that doesn't feel generic)
- notion.so (simple but distinctive)

---

## the test

> "does this look like something, or does it look like nothing?"

generic ai output looks like nothing. it's not ugly, it's just... there. forgettable.

good design has a point of view. pick one.
