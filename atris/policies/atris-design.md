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

**avoid:** inter, roboto, open sans, lato, system defaults

**try instead:**
- monospace for dev tools: jetbrains mono, fira code
- editorial vibes: playfair display, crimson pro
- clean technical: ibm plex, source sans

**the move:** pick ONE distinctive font. use weight extremes (200 vs 800, not 400 vs 500). size jumps should be dramatic (3x), not timid (1.2x).

---

## color

**avoid:** purple/violet on white, generic startup palettes, safe grays

**the move:** commit to a palette and stick to it. use css variables. one dominant color with a sharp accent beats five evenly-distributed colors.

dark backgrounds are easier to make look good. steal from places you like — linear.app, vercel.com, raycast.com, arc browser.

---

## layout

**avoid:** the template look — hero section, 3 feature cards, testimonial carousel, big footer. every ai does this.

**the move:** break the grid sometimes. asymmetry is interesting. whitespace is a feature, not wasted space. don't cram everything into 16px/24px spacing — use dramatic gaps.

---

## motion

**avoid:** static pages with nothing moving, or the opposite — bouncing everything

**specific anti-patterns:**
- cursor-following lines or elements
- meteor/particle effects shooting across screen
- buttons that follow the cursor (harder to click, not clever)
- FAQ/content that breaks if you scroll past before the fade-in finishes
- animations that swap styles endlessly without purpose (rotating shapes, morphing buttons)

**the move:** one well-timed animation beats ten scattered ones. page load with staggered reveals (animation-delay) creates more impact than hover effects on every button.

css transitions: 200-300ms, ease-out. that's it.

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

## scroll behavior

**avoid:** scrolljacking — never override native browser scroll with custom scroll logic. it feels like "moving through molasses" and users hate it.

**the move:** let the browser handle scrolling. if you want scroll-triggered effects, use intersection observer to trigger animations as sections enter the viewport — but don't mess with scroll speed or direction.

use the "peeking" technique: let a few pixels of the next section peek above the fold instead of full-screen heroes with "scroll down" arrows. this naturally signals more content below.

---

## backgrounds

**avoid:** solid white, solid light gray, flat nothing

**the move:** add depth. layered gradients, subtle patterns, mesh effects. backgrounds set mood — flat backgrounds say "I didn't think about this."

---

## context matters

don't impose an aesthetic — match the project. a fintech dashboard shouldn't look like a gaming site. read the room.

if the project already has a design system, use it. don't fight it to show off.

---

## the convergence trap

even with this guidance you'll find new defaults. space grotesk becomes the new inter. dark mode with amber accents becomes the new purple gradient.

vary your choices. alternate themes. try different directions between projects.

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

## before shipping

- can you name the aesthetic in 2-3 words?
- did you pick a real font, not a default?
- is there at least one intentional animation?
- does the background have depth?
- do hover states feel inviting, not confusing?
- does scrolling feel native?
- does the hero pass the H1 test (what/who/why/CTA)?
- are all screenshots/assets crisp?
- would a designer immediately clock this as ai-generated?

if the last answer is yes, you're not done.

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
