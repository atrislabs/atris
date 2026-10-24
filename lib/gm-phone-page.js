'use strict';

// The one page gm phone serves. Plain html, css, and vanilla js, no build
// step. Every piece of text from the task list goes in with textContent,
// never as html. The nonce matches the page's content security policy.
//
// One theme, the homepage letter's (atrisos-web LetterHome.tsx, dark values
// from app/config/theme-css.ts .dark): the
// brand colors, the letter serif, and the lava orb's amber as the only
// accent. The orb is a port of the landing orb (StippleOrb.tsx, LavaOrb.tsx,
// orb.module.css, LetterOrb.tsx) with the homepage tap 1:1: the dots spiral
// into one bright point and the lava orb is born there and grows. Here it
// then settles small at the top and the card fades up. Tap again and the
// card dissolves, the lava melts back into the sphere, and the next bet plays.
// Bets wait in a queue on the Mac, so a tap rarely waits; when it does, the
// spiral follows the real progress. Once a card is up nothing moves, but
// while the next card is on its way the dots never stop: after an answer
// they swarm in the sphere until it lands, and on the calm line (writing
// your next idea) the sphere stays above the card, swarming, its box open
// for a note, until the idea grows out of the dots. The footer is only the
// count of jobs the team is working on.
//
// Every card is big type in two parts: what is going on, and why it matters
// to the business. Nothing about how work is run or checked reaches the page.

// first: what GET /card answers right now, put in the page so the first
// paint is the card on screen (no cut from the big orb a round trip later)
const firstJson = first => (first ? JSON.stringify(first).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') : '');

const { iconSvg, touchIconPng } = require('./gm-phone-icon');

function phonePage(nonce, first = null) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#141110">
<meta name="color-scheme" content="dark">
<!-- added to the home screen it opens on its own, with no browser bars, the dark page under the status bar -->
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="orb">
<meta name="application-name" content="orb">
<link rel="icon" type="image/svg+xml" href="${iconSvg()}">
<link rel="apple-touch-icon" sizes="180x180" href="${touchIconPng()}">
<title>front office</title>
<style nonce="${nonce}">
:root {
  --bg: #141110;
  --text: #eae3d9;
  --text-2: #a39b92;
  --text-3: #9a9187;
  --line: #3d332d;
  /* the edge of a box you type in: 3.2:1 on the page, past WCAG AA's 3:1 for a text box */
  --edge: #6e635b;
  --amber: rgb(255, 140, 66);
  --amber-ink: #1a0f06;
  --serif: 'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif;
  /* the phone's top inset (a notch, the status bar in full screen): the small orb rests below it, the same gap above the title as on a phone without one */
  --safe-top: env(safe-area-inset-top, 0px);
  color-scheme: dark;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text); }
/* a phone turned on its side keeps the page's type sizes; Safari would scale the words up */
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body {
  font: 17px/1.5 var(--serif);
  min-height: 100vh;
  min-height: 100svh;
  -webkit-font-smoothing: antialiased;
}
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
/* a tap answers with the page's own chosen and armed looks, not the system's
   flash box; a double tap never zooms (a pinch still does); a long press on
   a button or the orb never selects its words or opens a menu. The words of
   a card stay selectable. */
html { -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
/* pulling down at the top never reloads the page mid card (it looks for new cards itself); the edge still gives */
html { overscroll-behavior-y: contain; }
/* the big orb's keyboard ring hugs the sphere, 8% inside the square the dots are drawn in */
.stage canvas:focus-visible { outline: none; }
.stage:has(canvas:focus-visible)::after { content: ''; position: absolute; inset: 8%; border-radius: 50%; outline: 2px solid var(--amber); outline-offset: 8px; pointer-events: none; }
button, .lava, .stage canvas { -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }
/* a button answers the moment a finger is down on it, and comes back when it lifts */
button:active:not(:disabled):not(.muted) { opacity: 0.7; }
:focus-visible { outline: 2px solid var(--amber); outline-offset: 4px; }
/* a link's ring hugs its own tall tap box, round, so it never touches the button above */
.links button:focus-visible, .quiet:focus-visible, .bet td button:focus-visible { outline-offset: 0; border-radius: 12px; }
[hidden] { display: none !important; }
/* dark until the page's script has run: a slow link never shows the words without the dots or the card */
body:not(.on) .screen, body:not(.on) nav { visibility: hidden; }
/* read by a screen reader, never seen */
.sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

/* ---- the screen: the orb in the middle, one line under it ---- */
.screen {
  position: relative;
  min-height: 100vh; min-height: 100svh;
  max-width: 34rem; margin: 0 auto;
  padding: max(24px, env(safe-area-inset-top)) max(24px, env(safe-area-inset-right)) max(24px, env(safe-area-inset-bottom)) max(24px, env(safe-area-inset-left));
  display: flex; flex-direction: column; align-items: center; justify-content: center;
}
.stage { position: relative; width: min(72vmin, 520px); aspect-ratio: 1 / 1; }
/* on a short screen (a phone on its side) the orb leaves room for its line and the footer */
.stage { width: min(72vmin, 520px, 100svh - 200px); }
.stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; border-radius: 50%; touch-action: none; cursor: pointer; }
.stage canvas:focus-visible { outline-offset: -8%; }
.line {
  min-height: 3em; margin: 4px 0 0; max-width: 22em; text-align: center;
  color: var(--text-3); font-size: 17px; line-height: 1.5; letter-spacing: -0.005em;
  opacity: 1; transition: opacity 0.28s ease;
}
.line.out { opacity: 0; }
.line.bad { color: var(--text-2); }
.foot { position: absolute; left: 0; right: 0; bottom: max(20px, env(safe-area-inset-bottom)); text-align: center; transition: opacity 0.3s ease-out 0.1s; }
/* while a card moves the footer steps aside, so it never jumps between the
   bottom of the screen and the end of a card; it comes back at rest */
body[data-busy]:not([data-in-place]) .foot { opacity: 0; transition: opacity 0.15s ease-in; }
/* until the first look says what is up, the line and the footer wait, and
   the orb is not drawn, so a card never opens over the big orb */
body.opening .line, body.opening .foot { opacity: 0; }
/* the yeses still waiting: a small line beside the team, never a card on its own */
#needs { margin-right: 20px; color: var(--amber); }
/* the footer never offers the page already open: no team link on the team, no need-you link on the job deck */
.bet[data-kind="team"]:not([hidden]) ~ .foot #working, .bet[data-kind="deck"]:not([hidden]) ~ .foot #needs { display: none; }
.quiet { color: var(--text-2); font-size: 17px; text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 0.25em; min-height: 44px; }
/* a card with a table (the team, one job) is wider, and at phone width the
   table scrolls sideways with the name column held in place; a line between
   every column and every row, and no column narrower than its words */
body.wide .screen { max-width: 64rem; }
.grid { margin: 14px 0 0; overflow-x: auto; -webkit-overflow-scrolling: touch; overscroll-behavior-x: contain; border: 1px solid var(--line); border-radius: 14px; }
/* more of the table is off to the right: its right edge fades out, still, until it is scrolled there */
.grid.more-right { -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 36px), transparent); mask-image: linear-gradient(to right, #000 calc(100% - 36px), transparent); }
.bet table { width: 100%; min-width: 44rem; border-collapse: separate; border-spacing: 0; font-size: 17px; line-height: 1.35; }
.bet table.k-deck { min-width: 56rem; }
.bet th, .bet td { padding: 10px 14px; text-align: left; vertical-align: baseline; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.bet th:last-child, .bet td:last-child { border-right: 0; }
.bet tbody tr:last-child td { border-bottom: 0; }
.bet th { color: var(--text-2); font-weight: 400; white-space: nowrap; }
.bet tr.row { cursor: pointer; }
@media (hover: hover) { .bet tr.row:hover td { background: #1c1816; } }
.bet td.member { position: sticky; left: 0; z-index: 1; background: var(--bg); white-space: nowrap; }
/* the team's member header is held with its names, so every header stays over its column */
.bet table.k-team th.member { position: sticky; left: 0; z-index: 2; background: var(--bg); }
.bet td.member button { font-size: 18px; font-weight: 700; text-align: left; min-height: 32px; }
/* a long name never takes over a phone: the held column stops at about fifteen letters and the name breaks at its hyphens */
.bet table.k-team td.member button { width: max-content; max-width: 8.5em; white-space: normal; overflow-wrap: break-word; }
.bet td.role { min-width: 9rem; color: var(--text-2); }
.bet td.ovr { white-space: nowrap; text-align: right; font-variant-numeric: tabular-nums; }
.bet th.ovr { text-align: right; }
.bet td.engine, .bet td.done { white-space: nowrap; }
.bet td.engine button { text-align: left; text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 0.25em; min-height: 32px; }
.bet td.status { min-width: 16rem; color: var(--text-2); }
.bet td.status.working { color: var(--text); }
.bet td.status.waiting-for-your-yes, .bet td.status.needs-you { color: var(--amber); }
.bet td.work { min-width: 14rem; }
/* a job card's one row, where its columns cannot all fit: one line per column, its name beside its words, nothing to scroll sideways */
@media (max-width: 60rem) {
  .bet table.k-deck { min-width: 0; }
  .bet table.k-deck thead { display: none; }
  .bet table.k-deck tbody, .bet table.k-deck tr { display: block; }
  .bet table.k-deck td { display: flex; gap: 14px; min-width: 0; border-right: 0; position: static; white-space: normal; }
  .bet table.k-deck td + td { border-top: 1px solid var(--line); }
  .bet table.k-deck td::before { content: attr(data-col); flex: none; width: 4.5rem; color: var(--text-2); }
}
/* a job deck card: its place in the deck and its status above the title */
.bet .count, .bet .label, .bet .time { display: block; font-size: 17px; color: var(--text-2); }
.deckhead { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.deckhead .pager { margin-right: -6px; white-space: nowrap; }
.bet .label.needs-you { color: var(--amber); }
.bet .time { margin: 10px 0 0; }
.jobline { margin: 10px 0 0; color: var(--text-2); font-size: 17px; }
.thread { margin: 12px 0 0; }
.sayline { margin: 10px 0 0; display: flex; flex-direction: column; align-items: center; gap: 8px; }
.sayline .thread, .sayline .reply { width: 100%; text-align: left; margin: 0; }
.unsent { margin: 0; text-align: center; }
.act > .links:empty { display: none; }
.turn { margin: 0 0 6px; font-size: 17px; line-height: 1.4; }
.turn.you { color: var(--text-2); }
.turn.orb { color: var(--text); }
.say { width: 100%; padding: 12px 14px; border-radius: 14px; border: 1px solid var(--line); background: transparent; color: var(--text); font: inherit; font-size: 18px; line-height: 1.4; resize: none; }

/* the lava orb, LavaOrb variant sm: three drifting blobs, transform and opacity only */
.lava {
  position: absolute; left: 0; top: 0; width: 280px; height: 280px; z-index: 5;
  border-radius: 50%; overflow: hidden; pointer-events: none;
  visibility: hidden; opacity: 0;
  background: rgb(20, 18, 16);
  box-shadow: 0 0 40px rgba(255, 140, 66, 0.1);
  filter: saturate(1.3);
  transform-origin: 50% 50%;
  /* nothing until it is first placed, so its 280px box never widens a narrow page */
  transform: scale(0);
  will-change: transform, opacity;
}
.lava .tx, .lava .ty { position: absolute; inset: 0; will-change: transform; }
.lava .blob { position: absolute; will-change: transform; }
/* one pass only: the lava drifts while it is born, never on a loop */
.lava.alive .tx { animation: sine-x var(--dur) ease-in-out var(--delay) 1 both; }
.lava.alive .ty { animation: sine-y var(--dur) ease-in-out var(--delay) 1 both; }
.lava.alive .blob { animation: spin var(--spin) linear 1 both; }
.lava.alive .blob.rev { animation-direction: reverse; }
.lava .b1 { width: 70%; height: 45%; left: 20%; top: 25%; background: rgba(255, 140, 66, 0.55); border-radius: 60% 40% 50% 70% / 50% 60% 40% 50%; filter: blur(24px); }
.lava .b2 { width: 55%; height: 60%; left: 35%; top: 40%; background: rgba(255, 100, 50, 0.45); border-radius: 40% 60% 70% 30% / 60% 40% 60% 40%; filter: blur(24px); }
.lava .b3 { width: 50%; height: 40%; left: 10%; top: 50%; background: rgba(255, 180, 100, 0.4); border-radius: 50% 70% 30% 60% / 40% 50% 60% 50%; filter: blur(16px); }
.lava .core { position: absolute; inset: 0; border-radius: 50%; background: radial-gradient(circle, rgba(255,232,170,0.95) 0%, rgba(251,150,44,0.6) 30%, rgba(251,130,36,0) 62%); }
.lava .dim { position: absolute; inset: 0; border-radius: 50%; background: var(--bg); opacity: 0; }
.lava.tap { pointer-events: auto; cursor: pointer; }
/* the small orb is the big one drawn small, so its ring is set against that scale (settled) */
.lava:focus-visible { outline-width: var(--ring, 2px); outline-offset: var(--ring-off, 4px); }
.lava.still .tx, .lava.still .ty, .lava.still .blob { animation-play-state: paused; }
@keyframes sine-x { 0%, 100% { transform: translate3d(calc(var(--amp) * -1), 0, 0); } 50% { transform: translate3d(var(--amp), 0, 0); } }
@keyframes sine-y { 0%, 100% { transform: translate3d(0, calc(var(--amp) * -1), 0); } 50% { transform: translate3d(0, var(--amp), 0); } }
@keyframes spin { from { transform: rotate(var(--rot0, 0deg)); } to { transform: rotate(calc(var(--rot0, 0deg) + 360deg)); } }

/* ---- the card: same dark page, the lava orb small on top ---- */
body.has-card .screen { justify-content: flex-start; padding-top: calc(max(16px, env(safe-area-inset-top)) + 76px); }
body.has-card .stage, body.has-card .line { display: none; }
/* the footer sits at the bottom of the screen on a card too, where it is on the big orb, and only
   moves below a card taller than the screen, 28px under it */
body.has-card .foot { position: static; margin-top: auto; padding-top: 28px; }
/* it spans the card's column and keeps the room of its one line of links when none shows
   (the team card hides its own), so a link that comes back with the next card never moves it */
body.has-card:not(.waiting) .foot { align-self: stretch; min-height: calc(28px + 44px); }
body.has-card:not(.waiting) .screen { padding-bottom: max(20px, env(safe-area-inset-bottom)); }
.bet { width: 100%; opacity: 0; transform: translateY(20px); transition: opacity 0.45s ease-out, transform 0.55s cubic-bezier(0.22, 1, 0.36, 1); }
.bet.up { opacity: 1; transform: none; }
.bet.quick { transition-duration: 0.4s, 0.5s; }
/* after an act the next card fades up as the sphere settles, so the whole motion is about a
   second, and its title drifts only a few pixels into the spot the last title had */
.bet.acted { transform: translateY(4px); transition-duration: 0.3s, 0.38s; }
.bet.acted.up { transform: none; }
/* card to card: a crossfade in place. the old card is a still copy that
   fades over the box while the new card fades in under it from a small
   drift, its title landing where the old title was; the box eases to the
   new height. The copy fades on the new card's own curve and delay, so the
   two always add up to one whole card, with no blink between them */
.bet.ghost { position: absolute; z-index: 1; margin: 0; pointer-events: none; transition: opacity 0.32s ease-out 0.08s; }
.bet.ghost.gone { opacity: 0; }
.bet.turning { overflow: hidden; transition: opacity 0.32s ease-out 0.08s, transform 0.32s cubic-bezier(0.22, 1, 0.36, 1) 0.08s, height 0.36s cubic-bezier(0.4, 0, 0.2, 1); }
.bet.turn-in { opacity: 0; transform: translateY(4px); transition: none; }
/* leaving: a soft fade in place, never a cut */
.bet.leave { opacity: 0; transform: none; transition: opacity 0.4s ease-out; }
.bet h1 { margin: 0; font-size: clamp(23px, 6.2vw, 30px); line-height: 1.12; font-weight: 700; letter-spacing: -0.03em; text-align: left; }
.why { margin: 14px 0 0; color: var(--text); font-size: 20px; line-height: 1.4; }
/* titles and labels wrap into even lines, and words to read never leave one word alone on the last line */
.bet h1, .option .t, .choice { text-wrap: balance; }
.why, .mission, .jobline, .turn, .option .w, .choice .w { text-wrap: pretty; }
/* a word longer than the screen (an email address) breaks instead of pushing the page sideways; the table keeps its own widths */
.bet, .line { overflow-wrap: anywhere; }
.bet .grid { overflow-wrap: normal; }
.act { margin: 18px 0 0; display: flex; flex-direction: column; align-items: center; gap: 6px; }
.pill {
  min-width: 12rem; height: 44px; padding: 0 28px; border-radius: 22px;
  background: var(--amber); color: var(--amber-ink); font-size: 17px; font-weight: 600; letter-spacing: -0.01em;
}
.pill.armed { background: var(--text); color: var(--bg); }
/* under 240px (a small phone at 200% zoom) the button is the card's width, never past its edges */
@media (max-width: 240px) { .pill { min-width: 100%; } }
.links { color: var(--text-2); font-size: 17px; text-align: center; }
/* a dot between two small links that falls where the row wraps becomes the break itself */
.links .sep.cut { display: block; height: 0; overflow: hidden; }
.links button { color: var(--text-2); text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 0.25em; min-height: 44px; padding: 0 6px; }
.links .pill { color: var(--amber-ink); text-decoration: none; padding: 0 28px; }
/* the quiet choice that is set now (who a swap is for) reads in full color over an amber line */
.links button.chosen { color: var(--text); text-decoration-color: var(--amber); }
/* a short quiet link ("no") still takes a finger: it answers a tap at least
   44px wide, centered on its words, and the words never move */
.links button { position: relative; }
.links button::after { content: ''; position: absolute; top: 0; bottom: 0; left: 50%; width: max(100%, 44px); transform: translateX(-50%); }
.mission { margin: 32px 0 0; padding: 16px 0 0; border-top: 1px solid var(--line); color: var(--text); font-size: 20px; line-height: 1.4; text-align: center; }
.mission.news { margin: 14px 0 0; padding: 0; border-top: 0; text-align: left; }
/* a choice: two or three ideas to tap, each a big title and one plain line of why */
.options { margin: 14px 0 0; display: flex; flex-direction: column; gap: 10px; }
.option { width: 100%; text-align: left; padding: 12px 16px; border-radius: 14px; border: 1px solid var(--line); color: var(--text); }
.option .t { display: block; font-size: 20px; line-height: 1.2; font-weight: 700; letter-spacing: -0.02em; }
.option .w { display: block; margin-top: 4px; font-size: 17px; line-height: 1.3; color: var(--text-2); }
/* a question card: the answers stack full width under the question */
.act.answers { align-items: stretch; gap: 10px; }
.act.answers .links { text-align: center; }

/* an answer to a question card */
.choice { width: 100%; min-height: 52px; text-align: left; padding: 12px 16px; border-radius: 14px; border: 1px solid var(--line); color: var(--text); font-size: 20px; }
/* an answer with a note (a model and its record): the name on its line, the note quiet under it */
.choice .t { display: block; }
.choice .w { display: block; margin-top: 2px; font-size: 17px; line-height: 1.3; color: var(--text-2); }
/* an answer that wraps keeps its lines together, like an idea's title */
.choice { line-height: 1.3; }

/* typing in place: the tapped answer becomes this box at its own size and
   spot, the cursor in it, and the rest of the card dims and stays put */
.field { position: relative; display: block; width: 100%; padding: 0; border: 1px solid var(--line); border-radius: 14px; color: var(--text); }
.field { border-color: var(--edge); }
.field input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; padding: 0 76px 0 16px; border: 0; border-radius: 14px; background: transparent; color: var(--text); font: inherit; outline: none; }
.field input::placeholder { color: var(--text-2); opacity: 1; }
.field:focus-within { border-color: var(--text-2); }
.field .send { position: absolute; top: 0; right: 0; bottom: 0; min-width: 64px; padding: 0 14px; color: var(--text-2); font-size: 17px; text-decoration: none; }
.sayline .field input { padding: 0 76px; text-align: center; }
/* on a narrow phone its words start at the left, so the hint and what is typed have room beside send */
.sayline .field { container-type: inline-size; }
@container (max-width: 335px) { .sayline .field input { padding-left: 16px; text-align: left; } }
/* send waits for words: dim while the box shows only its hint */
.field input:placeholder-shown + .send { opacity: 0.45; }
/* a chosen answer holds its spot with an amber edge, and the card takes no taps */
.choice.chosen, .option.chosen, .field.chosen { border-color: var(--amber); background: rgba(255, 140, 66, 0.1); }
.chosen .send { visibility: hidden; }
.chosen .send.reading { visibility: visible; }
.bet h1.said { font-size: 20px; line-height: 1.4; font-weight: 400; letter-spacing: 0; }
.bet.holding { pointer-events: none; }
.muted { opacity: 0.35; transition: opacity 0.2s ease; }
/* after an act the card fades all the way before it leaves the page, never cut mid fade */
.bet.leave.fast { transition: opacity 0.2s ease-in-out; }

/* ---- the calm line: the sphere stays, a little smaller and higher, its dots
   moving the whole time. The card under it takes no room of its own, so the
   sphere never jumps when the card comes or goes; it glides. ---- */
.stage { transform-origin: 50% 0; transition: transform 0.6s cubic-bezier(0.65, 0, 0.35, 1); }
body.has-card.waiting .screen { justify-content: center; padding-top: max(24px, env(safe-area-inset-top)); }
body.has-card.waiting .stage { display: block; transform: translateY(var(--wait-dy, 0px)) scale(var(--wait-k, 1)); }
body.has-card.waiting .line { display: block; }
body.has-card.waiting .foot { position: absolute; margin-top: 0; padding-top: 0; }
body.waiting .bet { position: absolute; left: 24px; right: 24px; width: auto; top: var(--wait-top, 62%); padding-bottom: 76px; }
.bet.wait-in { transform: translateY(8px); transition: opacity 0.4s ease-out 0.28s, transform 0.5s cubic-bezier(0.22, 1, 0.36, 1) 0.28s; }
.bet.wait-in.up { transform: none; }
.bet[data-kind="wait"] h1 { text-align: center; }
.waitstep { margin: 10px 0 0; min-height: 1.5em; text-align: center; color: var(--text-2); font-size: 17px; transition: opacity 0.26s ease; }
.waitstep.out { opacity: 0; }
.waittime { display: block; min-height: 1.5em; text-align: center; color: var(--text-3); font-size: 17px; }
.waitnotes { margin: 6px 0 0; overflow: hidden; transition: height 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
.waitnotes .turn { text-align: center; transition: opacity 0.3s ease-out; }
.waitnotes .turn.fresh { opacity: 0; }
.field.stay { height: 52px; }

@media (prefers-reduced-motion: reduce) {
  .lava .tx, .lava .ty, .lava .blob { animation: none !important; }
  .bet { transform: none; transition: opacity 0.2s linear; }
  /* the line's words change with the same plain fade as everything else */
  .line { transition: opacity 0.2s linear; }
  /* no travel and no swarm: every card change is a plain fade */
  .stage, .waitstep, .waitnotes, .waitnotes .turn { transition: none; }
  .bet.quick, .bet.acted, .bet.leave, .bet.leave.fast, .bet.wait-in { transform: none; transition: opacity 0.2s linear; }
  .lava { transition: opacity 0.2s linear; }
}
</style>
</head>
<body class="opening">
<main class="screen" id="screen">
  <div class="stage" id="stage">
    <canvas id="orb" tabindex="0" role="button" aria-label="the atris orb. tap to think of one new idea for the business"></canvas>
  </div>
  <p class="line" id="line" aria-live="polite">tap to think</p>
  <article class="bet" id="bet" hidden></article>
  <p class="sr" id="said" aria-live="polite" aria-atomic="true"></p>
  <div class="foot" id="foot"><button type="button" class="quiet" id="needs" hidden></button><button type="button" class="quiet" id="working">the team</button></div>
</main>
<!-- the small orb, the way back to the big one, in a landmark of its own -->
<nav aria-label="the orb">
<div class="lava" id="lava" role="button" tabindex="-1" aria-label="the atris orb. tap to go back to the big orb">
  <div class="tx" style-vars="15%,8.4s,-2.1s"><div class="ty" style-vars="12%,10.1s,-5.1s"><div class="blob b1" spin-vars="36s,0deg"></div></div></div>
  <div class="tx" style-vars="18%,12.6s,-7.2s"><div class="ty" style-vars="15%,7.2s,-4.7s"><div class="blob b2 rev" spin-vars="48s,45deg"></div></div></div>
  <div class="tx" style-vars="12%,7.2s,-6.4s"><div class="ty" style-vars="18%,10.1s,-9.9s"><div class="blob b3" spin-vars="57.6s,90deg"></div></div></div>
  <div class="core" id="lava-core"></div>
  <div class="dim" id="lava-dim"></div>
</div>
</nav>
<script type="application/json" id="first-look">${firstJson(first)}</script>
<script nonce="${nonce}">
(function () {
  var token = new URLSearchParams(location.search).get('t') || '';
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // nothing paints until this script ends, so the first frame shown is whole
  document.body.classList.add('on');

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  // A look that never answers (the wifi dropped, the Mac fell asleep) gives
  // up after LOOK_WAIT_MS. A tap is never cut off: past ACT_WAIT_MS the page
  // only stops waiting on it (patient), because a slow tap may still be at
  // work on the Mac, and its real answer still lands when it comes.
  var ACT_WAIT_MS = 90000, LOOK_WAIT_MS = 15000;
  // signal: lets a look that waits too long be called off (askCard); a look
  // without one makes its own and gives up after LOOK_WAIT_MS
  function api(path, body, signal) {
    var opts = { headers: { 'x-gm-token': token } };
    if (signal) opts.signal = signal;
    if (body) {
      opts.method = 'POST';
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    var ctl = !body && !signal && typeof AbortController === 'function' ? new AbortController() : null;
    var giveUp = ctl ? setTimeout(function () { ctl.abort(); }, LOOK_WAIT_MS) : 0;
    if (ctl) opts.signal = ctl.signal;
    return fetch(path + (body ? '' : '?t=' + encodeURIComponent(token)), opts)
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }).then(function (j) { j.http = r.status; if (typeof j.needs_you === 'number') drawNeeds(j.needs_you); return j; }); })
      .then(function (j) { clearTimeout(giveUp); return j; }, function (err) { clearTimeout(giveUp); throw err; });
  }

  // The yeses still waiting past the card on screen: one small line, and a
  // tap opens the job deck with the ones that need the owner first.
  function drawNeeds(n) {
    var btn = document.getElementById('needs');
    btn.hidden = !n;
    btn.textContent = n ? (n === 1 ? '1 needs you' : n + ' need you') : '';
  }

  // ---- the one line under the orb: fades out, changes, fades in ------------------
  var line = (function () {
    var node = document.getElementById('line');
    var want = null, busy = false, fading = false;
    function next() {
      if (busy || want == null) return;
      var w = want; want = null;
      if (w.text === node.textContent && w.bad === node.classList.contains('bad')) return;
      busy = true;
      fading = true;
      node.classList.add('out');
      setTimeout(function () {
        node.textContent = w.text;
        node.classList.toggle('bad', w.bad);
        node.classList.remove('out');
        fading = false;
        // each line stays long enough to read before the next one
        setTimeout(function () { busy = false; next(); }, 650);
      }, reduced ? 200 : 280);
    }
    return {
      set: function (text, bad) { want = { text: text, bad: Boolean(bad) }; next(); },
      // the page just opened: no fade to wait out, so the next line comes at once
      clear: function () { if (busy) { line.set('', false); return; } want = null; node.textContent = ''; node.classList.remove('bad', 'out'); },
      // the card just left and the sphere is back: the line fades in with it, never there at once
      appear: function () {
        if (reduced || fading) return;
        node.classList.add('out');
        void node.offsetWidth;
        requestAnimationFrame(function () { if (!fading) node.classList.remove('out'); });
      },
    };
  })();

  // ---- the orb: StippleOrb (tone dark) and LetterOrb's tap, ported 1:1 -----------
  // StippleOrb: the pull runs per dot over 0.75s after a delay (outer dots
  // first), the bright point arrives from 0.3s to 1.0s, and the lava is born
  // at 1.05s. LetterOrb: the lava grows for GROW_MS from 30px toward the
  // farthest corner (at most MAX_SCALE), with the same ease and smooth curves.
  // Here the grown lava then settles small at the top and the card fades up.
  var orb = (function () {
    var canvas = document.getElementById('orb');
    var lava = document.getElementById('lava');
    var core = document.getElementById('lava-core');
    var dim = document.getElementById('lava-dim');
    var ctx = canvas.getContext('2d');
    var SPRING = 0.07, DAMP = 0.8;
    // StippleOrb's pointer: dots within RADIUS of it are pushed out by PUSH
    // and spring home; a ripple runs out at WAVE_SPEED from where it came in
    var RADIUS = 90, PUSH = 14;
    var WAVE_SPEED = 620, WAVE_WIDTH = 70, WAVE_LIFE = 1.6;
    var GROW_MS = 1050, MAX_SCALE = 3.2;
    var SETTLE_MS = 900;
    // a tap on a card: the card fades for LEAVE_MS while the small orb glides
    // to the centre for GLIDE_MS, then the sphere grows back out of it and
    // holds for BEAT_MS before the next reveal starts from it
    var LEAVE_MS = 400, GLIDE_MS = 520, BEAT_MS = 340, BRIDGE_MS = 340;
    // the fast reveal stays contained: the lava grows to BLOOM of the smaller
    // window side and never washes the page
    var FAST_GROW_MS = 460, FAST_SETTLE_MS = 440, BLOOM = 0.72;
    // the card under it starts fading up LAND of the way into the settle, as
    // the lava eases into its spot, so the two read as one motion
    var LAND = 0.6;
    // the owner acted on a card: one motion of about a second when the answer
    // is in. The card fades all the way while the small orb glides into the
    // sphere, the dots spiral in at ACT_PACE, and the next card grows out of
    // the point: the lava swells to ACT_BLOOM and is already drifting up as
    // it does, so its size and place never stop or snap on the way.
    var ACT_LEAVE_MS = 220, ACT_GLIDE_MS = 260, ACT_BEAT_MS = 100, ACT_PACE = 0.28, ACT_GROW_MS = 140, ACT_SETTLE_MS = 420, ACT_BLOOM = 0.56;
    var quick = false;
    // the swarm: while the next card is on its way the dots never stop. The
    // sphere turns at SWARM_SPIN and every dot wanders a slow loop of its
    // own, WANDER of the radius, springing after it. In and out of it the
    // motion eases over about a second, and it ends the moment a card lands.
    var IDLE_SPIN = 0.15, SWARM_SPIN = 0.5, WANDER = 0.1, SWARM_EASE = 0.04;
    var swarmK = 0, spin = IDLE_SPIN, clock = 0;
    // when a spiral starts, each dot keeps the speed it had and lets it fade
    // at CARRY a frame, so the dots turn inward without a stop
    var CARRY = 0.82;
    // what the dots did on the last frame, kept on the canvas so the motion can be
    // measured, and ms: how much of the dots' own clock that frame was, which is
    // at most 50ms however long the frame took
    var stats = { frame: 0, mode: 'idle', step: 0, mean: 0, ms: 0 };
    canvas.__orb = stats;
    // Two speeds, chosen by truth. A bet already waiting in the queue plays
    // the same curves at FAST of their length (tap to card in about two seconds, unhurried).
    // A bet still being made plays the full landing length, and the spiral
    // holds on the real progress until it passes.
    var FAST = 0.4;
    var pace = 1;
    var bridgeAt = 0;
    var REST = 56;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var count = window.innerWidth < 768 ? 5500 : 11000;
    var w = 0, h = 0, R = 0, cx = 0, cy = 0;
    var dots = [];
    // the dots are drawn by color and brightness, LEVELS of each, so a frame
    // sets the fill color about a hundred times instead of once a dot. Each
    // frame keeps every dot's place, size, and level in these, then draws
    // them level by level, dim first.
    var LEVELS = 64, STYLES = [];
    for (var q = 0; q < 2 * LEVELS; q++) STYLES.push((q < LEVELS ? 'rgba(251, 130, 36, ' : 'rgba(253, 196, 84, ') + ((q % LEVELS) / (LEVELS - 1)).toFixed(3) + ')');
    var px = null, py = null, pr = null, pb = null, order = null;
    var counts = new Int32Array(2 * LEVELS);
    // idle: the sphere drifts. pull: the dots spiral in by age. card: still.
    var mode = 'idle';
    var angle = 0;
    var age = -1, ageTo = 0, timed = false, fired = false;
    var raf = 0, lastT = 0;
    var onBorn = null;
    var base = 280, origin = { x: 0, y: 0 };
    // the light eases toward the pointer; at rest it comes from the upper left
    var light = { x: -0.5, y: -0.6, tx: -0.5, ty: -0.6 };
    var lz = Math.sqrt(1 - light.x * light.x - light.y * light.y);
    var pointer = { x: -9999, y: -9999, inside: false };
    var wave = { x: 0, y: 0, age: 99 };
    var ease = function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
    var smooth = function (a, b, v) { var t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

    // the lava blobs take their drift numbers from the markup
    Array.prototype.forEach.call(lava.querySelectorAll('[style-vars]'), function (n) {
      var v = n.getAttribute('style-vars').split(',');
      n.style.setProperty('--amp', v[0]); n.style.setProperty('--dur', v[1]); n.style.setProperty('--delay', v[2]);
    });
    Array.prototype.forEach.call(lava.querySelectorAll('[spin-vars]'), function (n) {
      var v = n.getAttribute('spin-vars').split(',');
      n.style.setProperty('--spin', v[0]); n.style.setProperty('--rot0', v[1]);
    });

    function measure() {
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      R = Math.min(w, h) * 0.42; cx = w / 2; cy = h / 2;
    }

    function seed() {
      // random points on a sphere (normalised gaussians), so it reads as stipple
      var gauss = function () { return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random()); };
      dots = [];
      px = new Float32Array(count); py = new Float32Array(count); pr = new Float32Array(count); pb = new Int16Array(count); order = new Int32Array(count);
      for (var i = 0; i < count; i++) {
        var gx = gauss(), gy = gauss(), gz = gauss();
        var n = Math.hypot(gx, gy, gz) || 1;
        dots.push({
          x: gx / n, y: gy / n, z: gz / n, sx: cx, sy: cy, vx: 0, vy: 0, r: 0.4 + Math.random() * 0.7, bx: 0, by: 0, dl: 0, kx: 0, ky: 0,
          // its own slow loop in the swarm
          f1: 0.5 + Math.random() * 0.8, f2: 0.5 + Math.random() * 0.8, p1: Math.random() * 6.283, p2: Math.random() * 6.283,
        });
      }
    }

    // StippleOrb startBoom: each dot remembers where it starts, and the outer
    // dots go first. The start is the sphere itself, so a page that opens
    // mid-thought still spirals from the whole orb.
    // fromHere: start from where the dots are now (a quick re-tap, mid re-form)
    function startPull(fromHere) {
      var cosA = Math.cos(angle), sinA = Math.sin(angle);
      for (var i = 0; i < dots.length; i++) {
        var d = dots[i];
        if (fromHere) { d.bx = d.sx; d.by = d.sy; } else { d.bx = cx + (d.x * cosA + d.z * sinA) * R; d.by = cy + d.y * R; d.vx = 0; d.vy = 0; }
        d.kx = 0; d.ky = 0;
        var len = Math.hypot(d.bx - cx, d.by - cy);
        d.dl = (1 - Math.min(1, len / R)) * 0.28 + Math.random() * 0.05;
      }
      age = 0; ageTo = 0; fired = false;
      mode = 'pull';
    }

    function frame(now) {
      // the first frame after a start counts as one 60fps frame
      var dt = lastT ? Math.min(0.05, (now - lastT) / 1000) : 1 / 60;
      lastT = now;
      // the springs, the damping, and every ease below are tuned per 60fps
      // frame; k is how many of those this frame was, so a slow phone and a
      // 120Hz screen run them in the same time. The spring runs in steps of
      // at most one 60fps frame, so a long frame follows the same path.
      var k = dt * 60, carry = Math.pow(CARRY, k);
      var subs = Math.max(1, Math.ceil(k - 0.001)), sk = k / subs, damp = Math.pow(DAMP, sk);
      ctx.clearRect(0, 0, w, h);
      var swarming = mode === 'swarm' && !reduced;
      var toward = 1 - Math.pow(1 - SWARM_EASE, dt * 60);
      swarmK += ((swarming ? 1 : 0) - swarmK) * toward;
      spin += ((swarming ? SWARM_SPIN : IDLE_SPIN) - spin) * toward;
      clock += dt;
      if (!reduced && (mode === 'idle' || mode === 'swarm')) angle += dt * spin;
      wave.age += dt;
      var follow = 1 - Math.pow(0.94, k);
      light.x += (light.tx - light.x) * follow;
      light.y += (light.ty - light.y) * follow;
      lz = Math.sqrt(Math.max(0, 1 - light.x * light.x - light.y * light.y));
      var r2 = RADIUS * RADIUS;
      var waveFront = wave.age * WAVE_SPEED;
      var waveOn = mode === 'idle' && wave.age < WAVE_LIFE && !reduced;
      var waveGain = waveOn ? 1 - wave.age / WAVE_LIFE : 0;
      if (mode === 'pull') {
        // ready: the age runs on the clock, as on the homepage. Waiting: it
        // follows the real progress and stops short of the point.
        if (timed) age += dt / pace;
        else age += (ageTo - age) * (1 - Math.pow(0.95, k));
      }
      var cosA = Math.cos(angle), sinA = Math.sin(angle);
      var most = 0, sum = 0, wander = WANDER * R * swarmK;
      counts.fill(0);
      for (var i = 0; i < dots.length; i++) {
        var d = dots[i];
        var fade = 1, shrink = 1;
        var x0 = d.sx, y0 = d.sy;
        var rx = d.x * cosA + d.z * sinA;
        var rz = -d.x * sinA + d.z * cosA;
        if (mode === 'idle' || mode === 'swarm') {
          var homeX = cx + rx * R, homeY = cy + d.y * R;
          if (wander > 0.05) {
            homeX += Math.sin(clock * d.f1 + d.p1) * wander;
            homeY += Math.sin(clock * d.f2 + d.p2) * wander;
          }
          if (waveOn) {
            var wx = homeX - wave.x, wy = homeY - wave.y;
            var wd = Math.sqrt(wx * wx + wy * wy) || 1;
            var off = (wd - waveFront) / WAVE_WIDTH;
            if (off > -1 && off < 1) {
              var bump = Math.cos(off * Math.PI * 0.5) * 22 * waveGain;
              homeX += (wx / wd) * bump;
              homeY += (wy / wd) * bump;
            }
          }
          if (pointer.inside && !reduced) {
            var dx = d.sx - pointer.x, dy = d.sy - pointer.y;
            var dist2 = dx * dx + dy * dy;
            if (dist2 < r2 && dist2 > 0.01) {
              var dist = Math.sqrt(dist2);
              var f = (1 - dist / RADIUS) * PUSH;
              d.vx += (dx / dist) * f * 0.2 * k;
              d.vy += (dy / dist) * f * 0.2 * k;
            }
          }
          for (var j = 0; j < subs; j++) {
            d.vx += (homeX - d.sx) * SPRING * sk;
            d.vy += (homeY - d.sy) * SPRING * sk;
            d.vx *= damp; d.vy *= damp;
            d.sx += d.vx * sk; d.sy += d.vy * sk;
          }
          if (reduced) { d.sx = cx + rx * R; d.sy = cy + d.y * R; }
        } else {
          var t = Math.min(1, Math.max(0, (age - d.dl) / 0.75));
          var e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
          var ox = (d.bx - cx) * (1 - e), oy = (d.by - cy) * (1 - e);
          var turn = e * 1.5;
          // the speed it had carries on and fades, then the spiral has it
          d.kx += d.vx * k; d.ky += d.vy * k; d.vx *= carry; d.vy *= carry;
          d.sx = cx + ox * Math.cos(turn) - oy * Math.sin(turn) + d.kx * (1 - e);
          d.sy = cy + ox * Math.sin(turn) + oy * Math.cos(turn) + d.ky * (1 - e);
          fade = 1 - Math.pow(Math.max(0, (e - 0.8) / 0.2), 1.5);
          shrink = 1 - 0.35 * e;
        }
        if (i < 64) { var stepped = Math.max(Math.abs(d.sx - x0), Math.abs(d.sy - y0)); if (stepped > most) most = stepped; sum += stepped; }
        // front dots are lit; the back half is a dim ghost. amber in shadow, cream where lit.
        var lit = rx * light.x + d.y * light.y + rz * lz;
        var front = rz > 0;
        var l = Math.max(0, lit);
        var a = (front ? 0.16 + Math.pow(l, 1.3) * 0.84 : 0.05 + l * 0.08) * fade;
        // a pointer at a corner lights past 1; those dots are the brightest level, never left out
        var level = Math.min(LEVELS - 1, Math.round(a * (LEVELS - 1)));
        if (level <= 0) { pb[i] = -1; continue; }
        pb[i] = (l > 0.93 ? LEVELS : 0) + level;
        counts[pb[i]] += 1;
        px[i] = d.sx; py[i] = d.sy; pr[i] = d.r * (front ? 0.6 + l * 0.7 : 0.6) * shrink;
      }
      // where each level's dots start in order, then every dot in its level's place
      for (var b = 0, at = 0; b < 2 * LEVELS; b++) { var n = counts[b]; counts[b] = at; at += n; }
      for (var i2 = 0; i2 < dots.length; i2++) { if (pb[i2] >= 0) { order[counts[pb[i2]]] = i2; counts[pb[i2]] += 1; } }
      // counts[b] is now where level b ends
      for (var b2 = 0, from = 0; b2 < 2 * LEVELS; b2++) {
        var to = counts[b2];
        if (to > from) {
          ctx.fillStyle = STYLES[b2];
          for (var o = from; o < to; o++) { var j = order[o]; ctx.beginPath(); ctx.arc(px[j], py[j], pr[j], 0, Math.PI * 2); ctx.fill(); }
        }
        from = to;
      }
      stats.frame += 1; stats.mode = mode; stats.step = most; stats.mean = sum / Math.min(64, dots.length || 1); stats.ms = dt * 1000;
      if (mode === 'pull') {
        // where the dots land: one bright point that swells until the lava is born
        var arrived = Math.min(1, Math.max(0, (age - 0.3) / 0.7));
        if (arrived > 0) point(arrived, timed ? 0.88 + 0.12 * Math.sin(age * 5) : 1);
        if (timed && !fired && age > 1.05) { fired = true; grow(); }
      } else if (bridgeAt) {
        // the melted lava's bright point fades as the sphere grows out of it
        var left = 1 - (now - bridgeAt) / BRIDGE_MS;
        if (left > 0) point(left, 1); else bridgeAt = 0;
      }
      // still once a card is up, and under reduced motion the sphere is drawn once and holds
      if (mode === 'card' || (reduced && (mode === 'idle' || mode === 'swarm'))) { raf = 0; return; }
      raf = requestAnimationFrame(frame);
    }

    // one bright point at the centre with its glow, at strength arrived
    function point(arrived, breath) {
      var coreR = (2 + 5 * arrived) * breath;
      var glowR = (10 + 46 * arrived) * breath;
      var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
      g.addColorStop(0, 'rgba(255, 232, 170, ' + (0.9 * arrived).toFixed(3) + ')');
      g.addColorStop(0.35, 'rgba(251, 150, 44, ' + (0.4 * arrived).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(251, 130, 36, 0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, glowR, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255, 244, 214, ' + arrived.toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, Math.PI * 2); ctx.fill();
    }

    function start() { if (!raf) { lastT = 0; raf = requestAnimationFrame(frame); } }
    function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }

    // at: the frame time this place is for, when it is a step of a motion, kept on
    // the lava so the motion can be measured on the clock it runs on
    function place(s, x, y, at) { lava.style.transform = 'translate(' + (x - base / 2) + 'px, ' + (y - base / 2) + 'px) scale(' + s + ')'; lava.__at = at; }
    function restPoint() {
      var top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-top')) || 0;
      return { x: document.documentElement.clientWidth / 2, y: window.scrollY + Math.max(16, top) + 8 + REST / 2 };
    }

    // LetterOrb grow, then the settle: the lava is born at the point, grows
    // toward the farthest corner as the page dims to its own dark, then
    // shrinks back to a small orb at the top. After that nothing moves.
    // A queued bet (the fast pace) blooms contained: the lava grows to BLOOM
    // of the smaller window side, the page never dims, and it settles.
    function grow() {
      // fixed while it grows past the screen, so the page never scrolls sideways
      window.scrollTo(0, 0);
      var rect = canvas.getBoundingClientRect();
      var contained = pace < 1;
      var growMs = quick ? ACT_GROW_MS : contained ? FAST_GROW_MS : (GROW_MS * pace);
      var settleMs = quick ? ACT_SETTLE_MS : contained ? FAST_SETTLE_MS : (SETTLE_MS * pace);
      // after an act the card comes up at the bloom's peak; any other card once the lava has settled
      planned('bloom', growMs);
      if (!quick) planned('settle', contained ? settleMs * LAND : settleMs);
      // the point the dots drew, where the sphere is on screen (smaller and higher on the calm line)
      var vx = rect.left + rect.width / 2, vy = rect.top + rect.height / 2;
      var bloom = quick ? ACT_BLOOM : BLOOM;
      var reach = contained
        ? bloom * Math.min(window.innerWidth, window.innerHeight) / 2
        : Math.hypot(Math.max(vx, window.innerWidth - vx), Math.max(vy, window.innerHeight - vy)) * 1.08;
      base = Math.round(Math.min(1000, Math.max(280, (2 * reach) / MAX_SCALE)));
      var sMax = (2 * reach) / base;
      var sMin = 30 / base;
      var rest = REST / base;
      lava.style.width = base + 'px';
      lava.style.height = base + 'px';
      origin = { x: vx, y: vy };
      lava.style.position = 'fixed';
      lava.style.opacity = '0';
      place(sMin, origin.x, origin.y);
      lava.style.visibility = 'visible';
      lava.classList.remove('still', 'alive', 'tap');
      void lava.offsetWidth;
      lava.classList.add('alive');
      if (contained) { rise(growMs, settleMs, sMin, sMax, rest); return; }
      var t0 = performance.now();
      var step = function (now) {
        var t = Math.min(1, (now - t0) / growMs);
        place(sMin + (sMax - sMin) * ease(t), origin.x, origin.y, now);
        lava.style.opacity = String(smooth(0.02, 0.22, t));
        core.style.opacity = String(1 - smooth(0.05, 0.4, t));
        dim.style.opacity = contained ? '0' : String(smooth(0.88, 1, t));
        if (t < 1) { requestAnimationFrame(step); return; }
        mode = 'card';
        stop();
        ctx.clearRect(0, 0, w, h);
        canvas.style.visibility = 'hidden';
        if (onBorn) onBorn('cover');
        var p = restPoint();
        var s0 = performance.now();
        var settle = function (n2) {
          var u = ease(Math.min(1, (n2 - s0) / settleMs));
          place(sMax + (rest - sMax) * u, origin.x + (p.x - origin.x) * u, origin.y + (p.y - origin.y) * u, n2);
          dim.style.opacity = contained ? '0' : String(1 - smooth(0.35, 0.85, u));
          if (u < 1) { requestAnimationFrame(settle); return; }
          settled();
        };
        requestAnimationFrame(settle);
      };
      requestAnimationFrame(step);
    }

    // A contained bloom is one motion. The lava is born at the point and
    // swells for growMs on a soft curve while it already drifts up, then
    // eases down into the small orb at the top over settleMs. Its size turns at the peak with no
    // stop, and its place moves on one curve the whole way, so nothing snaps.
    // The card fades up under it from the peak.
    function rise(growMs, settleMs, sMin, sMax, rest) {
      var total = growMs + settleMs, k = growMs / total;
      var p = restPoint();
      var covered = false, landed = false, landAt = k + LAND * (1 - k);
      var t0 = performance.now();
      var step = function (now) {
        var u = Math.min(1, (now - t0) / total);
        var s = u < k ? sMin + (sMax - sMin) * (0.5 - 0.5 * Math.cos(Math.PI * u / k)) : sMax + (rest - sMax) * ease((u - k) / (1 - k));
        var m = ease(u);
        place(s, origin.x + (p.x - origin.x) * m, origin.y + (p.y - origin.y) * m, now);
        lava.style.opacity = String(smooth(0, 0.1, u));
        core.style.opacity = String(1 - smooth(0.04, 0.5, u));
        dim.style.opacity = '0';
        if (!covered && u >= k) {
          covered = true;
          mode = 'card';
          stop();
          ctx.clearRect(0, 0, w, h);
          canvas.style.visibility = 'hidden';
          if (onBorn) onBorn('cover');
        }
        if (covered && !landed && u >= landAt) { landed = true; if (onBorn) onBorn('landing'); }
        if (u < 1) { requestAnimationFrame(step); return; }
        settled();
      };
      requestAnimationFrame(step);
    }

    // the small lava orb at the top, still, and itself the next tap
    function settled() {
      var p = restPoint();
      if (base < 280) base = 280;
      lava.style.width = base + 'px';
      lava.style.height = base + 'px';
      // at rest it scrolls with the card
      lava.style.position = 'absolute';
      place(REST / base, p.x, p.y);
      // its focus ring, 2px and 4px out on screen whatever the scale
      lava.style.setProperty('--ring', (2 * base / REST).toFixed(2) + 'px');
      lava.style.setProperty('--ring-off', (4 * base / REST).toFixed(2) + 'px');
      lava.style.visibility = 'visible';
      lava.style.opacity = '1';
      core.style.opacity = '0';
      dim.style.opacity = '0';
      lava.classList.add('still', 'tap');
      mode = 'card';
      stop();
      canvas.style.visibility = 'hidden';
      lava.tabIndex = 0;
      if (onBorn) { var cb = onBorn; onBorn = null; cb('settled'); }
    }

    // a tap on a card: the card fades in place while the small lava orb
    // glides down to where the sphere sits (to), shrinking to a bright point.
    // swap() takes the card off the page once it has faded. At the centre the
    // lava melts and the sphere grows back out of the point, holds for a
    // beat so it reads, then calls back. Reduced motion: no travel.
    // fast: the owner acted, so the glide is the short one
    function melt(cb, to, swap, fast) {
      var leaveMs = fast ? ACT_LEAVE_MS : LEAVE_MS, glideMs = fast ? ACT_GLIDE_MS : GLIDE_MS, beatMs = fast ? ACT_BEAT_MS : BEAT_MS;
      lava.classList.remove('tap', 'alive');
      lava.tabIndex = -1;
      var swapped = false;
      var takeOff = function () { if (!swapped) { swapped = true; swap(); } };
      var reform = function () {
        takeOff();
        canvas.style.visibility = 'visible';
        measure();
        lava.style.visibility = 'hidden';
        lava.style.opacity = '0';
        for (var i = 0; i < dots.length; i++) { dots[i].sx = cx; dots[i].sy = cy; dots[i].vx = 0; dots[i].vy = 0; }
        pointer.inside = false;
        age = -1; timed = false; fired = false;
        // after an act the next card is on its way, so the dots come out swarming and never stop
        mode = fast ? 'swarm' : 'idle';
        bridgeAt = reduced ? 0 : performance.now();
        start();
        if (!reduced) planned('beat', beatMs);
        setTimeout(cb, reduced ? 0 : beatMs);
      };
      if (reduced || lava.style.visibility !== 'visible') { reform(); return; }
      var r = lava.getBoundingClientRect();
      var from = { x: r.left + r.width / 2, y: r.top + r.height / 2, s: r.width / base };
      // fixed while it travels, so the card's scroll and the swap never move it
      lava.style.position = 'fixed';
      place(from.s, from.x, from.y);
      var sEnd = 30 / base;
      planned('glide', glideMs);
      var t0 = performance.now();
      var step = function (now) {
        var k = Math.min(1, (now - t0) / glideMs);
        var t = fast ? 0.5 - 0.5 * Math.cos(Math.PI * k) : ease(k);
        if (now - t0 >= leaveMs) takeOff();
        place(from.s + (sEnd - from.s) * t, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, now);
        core.style.opacity = String(smooth(0.3, 0.9, k));
        lava.style.opacity = String(1 - smooth(0.7, 1, k));
        if (k < 1) { requestAnimationFrame(step); return; }
        reform();
      };
      requestAnimationFrame(step);
    }

    measure();
    seed();

    // StippleOrb's pointer, ported with trackWindow on, as LetterOrb uses it.
    // Over the sphere the dots part around the pointer and spring back; the
    // light follows the pointer anywhere on the page; a ripple runs out from
    // where the pointer comes in. When it leaves, the dots settle home. On a
    // phone a press and drag pushes the dots, and a tap still thinks. Only
    // the idle sphere answers, and never under reduced motion.
    function local(e) {
      var r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    canvas.addEventListener('pointermove', function (e) {
      var p = local(e);
      pointer.x = p.x; pointer.y = p.y; pointer.inside = true;
    });
    canvas.addEventListener('pointerenter', function (e) {
      if (reduced || mode !== 'idle') return;
      var p = local(e);
      wave.x = p.x; wave.y = p.y; wave.age = 0;
    });
    canvas.addEventListener('pointerleave', function () { pointer.inside = false; });
    canvas.addEventListener('pointercancel', function () { pointer.inside = false; });
    function lightFrom(e) {
      var r = canvas.getBoundingClientRect();
      if (!r.width) return;
      var reach = Math.max(280, window.innerWidth * 0.4);
      light.tx = Math.max(-0.9, Math.min(0.9, (e.clientX - (r.left + r.width / 2)) / reach));
      light.ty = Math.max(-0.9, Math.min(0.9, (e.clientY - (r.top + r.height / 2)) / reach));
    }
    window.addEventListener('pointermove', lightFrom);

    // A zoom, a turned phone, or a resized window: a small orb at rest moves to
    // its place above the card, and the sphere takes its new size and pixel
    // density, every dot keeping its place on it, so nothing jumps or softens.
    // Off the page (a card is up) the sphere is measured when it comes back.
    window.addEventListener('resize', function () {
      if (lava.classList.contains('still') && lava.classList.contains('tap')) { var p = restPoint(); place(REST / base, p.x, p.y - window.scrollY); }
      var ratio = Math.min(window.devicePixelRatio || 1, 2);
      // a phone's bars sliding in and out send resizes too; only a real change redraws
      if (!canvas.clientWidth || (canvas.clientWidth === w && canvas.clientHeight === h && ratio === dpr)) return;
      var was = { cx: cx, cy: cy, R: R };
      dpr = ratio;
      measure();
      var k = was.R ? R / was.R : 1;
      for (var i = 0; i < dots.length; i++) {
        var d = dots[i];
        d.sx = cx + (d.sx - was.cx) * k; d.sy = cy + (d.sy - was.cy) * k;
        d.bx = cx + (d.bx - was.cx) * k; d.by = cy + (d.by - was.cy) * k;
      }
      if (mode !== 'card') start();
    });

    return {
      // the bet is ready: the homepage tap, on the clock
      // act: the owner acted on a card, so it is the one quick motion
      play: function (cb, fast, act) {
        onBorn = cb;
        quick = Boolean(act);
        if (reduced) { settled(); return; }
        pace = act ? ACT_PACE : fast ? FAST : 1;
        // after an act the dots spiral in from where the re-formed sphere is
        if (mode !== 'pull') startPull(fast || Boolean(act));
        // the lava is born at 1.05 on the spiral's own clock, which runs at pace
        planned('spiral', Math.max(0, 1.05 - age) * pace * 1000);
        timed = true;
        start();
      },
      // no bet yet: the spiral follows the real progress
      wait: function () {
        pace = 1;
        if (mode !== 'pull') { startPull(false); timed = false; }
        start();
      },
      progress: function (p) {
        if (!timed) ageTo = Math.max(ageTo, 0.62 * Math.min(1, p));
      },
      // generation failed: the dots relax back to the sphere
      relax: function () {
        age = -1; timed = false; fired = false;
        mode = 'idle';
        start();
      },
      // the next card is on its way: the sphere is on the page and its dots keep moving
      swarm: function () {
        if (mode === 'card') {
          canvas.style.visibility = 'visible';
          measure();
          for (var i = 0; i < dots.length; i++) { dots[i].sx = cx; dots[i].sy = cy; dots[i].vx = 0; dots[i].vy = 0; }
          lava.classList.remove('tap', 'still', 'alive');
          lava.style.visibility = 'hidden';
          lava.style.opacity = '0';
          lava.tabIndex = -1;
          age = -1; timed = false; fired = false;
          mode = 'swarm';
        }
        if (mode === 'idle') mode = 'swarm';
        start();
      },
      // nothing is on its way: back to the idle drift under the pointer
      calm: function () { if (mode === 'swarm') mode = 'idle'; start(); },
      melt: melt,
      leaveMs: reduced ? 200 : LEAVE_MS,
      // a bet is already up when the page loads: the settled orb, no motion
      settled: function () { stop(); onBorn = null; settled(); },
      // the first look found no card: the big orb starts
      begin: start,
      moving: function () { return mode === 'pull'; },
      // the page went to the background: no frames; back on screen, the sphere picks up
      pause: stop,
      resume: function () { if (mode !== 'card') start(); },
    };
  })();

  // ---- the card: one renderer, one way to act --------------------------------------
  // The page draws exactly the card the Mac served, with draw(card), and
  // nothing else draws a card. Its options and its box come only from that
  // card, and nothing from the card before survives a draw. Every tap posts
  // the card's id and the option's id, or the words typed in its box, to
  // /card; the Mac refuses anything else, and its answer is the next card.
  var bet = { shown: null, watching: null, tapAt: 0, plan: [], waited: 0, noting: false, clock: null };
  // while an act or a turn is under way the card takes no taps; the page
  // marks it on the body too, so anyone reading the page can tell
  var busyNow = false;
  Object.defineProperty(bet, 'busy', { get: function () { return busyNow; }, set: function (v) { busyNow = Boolean(v); document.body.toggleAttribute('data-busy', busyNow); } });
  // how long a line like "builder has it" stays under the orb before the next card
  var AFTER_MS = 1500;
  // a tapped option holds as chosen this long before the motion starts
  var HOLD_MS = 150;
  // what turns in place instead of the spiral: flipping the deck, more
  // models, and who a swap is for are the same card moving, not an answer
  var IN_PLACE = ['flip', 'more', 'scope'];
  // moving around the team pages turns in place too: a talk card, a swap
  // card, the deck, a way back, and the team after a swap are places to go,
  // not answers
  var AROUND = ['member', 'swap', 'deck', 'back', 'swap_to'];

  // Safari shows a pressed button only when the page listens for touches
  document.addEventListener('touchstart', function () {}, { passive: true });

  function buzz() { if (navigator.vibrate) { try { navigator.vibrate(10); } catch (e) { /* not on this device */ } } }

  // a failed fetch reads like a refusal, so nothing ever hangs
  function offline() { return { ok: false, http: 0, message: 'that did not reach the mac. try again.' }; }
  // A tap the page stopped waiting on is not a failure: no one can tell a
  // slow Mac from one that never heard it, so the page says what is true.
  // Only a network that failed before any answer says it did not get there.
  var STILL = 'the mac is still working on it. you will see the result here once it is done.';
  // the answer, or { slow } once ACT_WAIT_MS has passed; the real answer goes on.
  // An answer in time clears the wait, so a long session never piles up timers.
  function patient(answer) {
    var timer = 0;
    var slow = new Promise(function (resolve) { timer = setTimeout(function () { resolve({ ok: false, http: 0, slow: true, message: STILL }); }, ACT_WAIT_MS); });
    return Promise.race([answer, slow]).then(function (r) { clearTimeout(timer); return r; });
  }
  // Once the real answer to a tap on a card the page stopped waiting on
  // comes, it shows, if the owner is still on that card and nothing else is
  // moving; the look every few seconds brings the Mac's card in any case.
  function whenLate(answer, late, from) {
    answer.then(function (r) {
      if (!r.slow) return;
      late.then(function (l) {
        if (bet.busy || bet.noting || !sameCard(bet.shown, from) || !document.body.classList.contains('has-card')) return;
        if (l.ok && l.card && !sameCard(l.card, from)) { bet.busy = true; arrive(l.card); return; }
        if (l.ok && (l.home || !l.card)) { bet.busy = true; leave(function () { bet.busy = false; bet.shown = null; orb.calm(); line.set(l.home ? 'tap when you want another idea' : 'tap to think', false); }); return; }
        var note = box().querySelector('.act .note');
        if (note && note.textContent === STILL) note.textContent = l.ok ? '' : (l.message || 'that did not go through. try again.');
      });
    });
  }
  // the big orb stopped waiting on a slow answer: it says so, takes taps
  // again, and shows the card once the real answer brings one
  function stillOn(asked, show) {
    bet.busy = false;
    orb.relax();
    line.set(STILL, false);
    var idle = function () { return !bet.busy && !document.body.classList.contains('has-card'); };
    asked.then(function (r) {
      if (idle() && r.http === 200 && r.card) { bet.busy = true; line.set('', false); show(r.card); return; }
      if (idle()) line.set(r.http ? 'tap to think' : 'that did not go through. tap to try again.', !r.http);
    }, function () { if (idle()) line.set('that did not go through. tap to try again.', true); });
  }
  // a refusal because the card on screen is gone, with no card on the Mac to show instead
  function gone(r) { return Boolean(r && !r.ok && r.reason === 'gone' && !r.card); }

  function box() { return document.getElementById('bet'); }

  // ---- draw: the one place a card becomes the page -----------------------------------
  function draw(card) {
    var b = box();
    b.textContent = '';
    b.setAttribute('data-card', card.id);
    b.setAttribute('data-kind', card.kind);
    document.body.classList.toggle('wide', Boolean(card.table));
    // a deck card's place, with previous and next beside it at the top, where they never move between cards
    var flips = card.count ? card.options.filter(function (o) { return o.action === 'flip' && !o.cell; }) : [];
    if (card.count) {
      var head = b.appendChild(el('div', 'deckhead'));
      head.appendChild(el('span', 'count', card.count));
      var pager = flips.length ? head.appendChild(el('span', 'links pager')) : null;
      flips.forEach(function (o, i) { if (i) pager.appendChild(document.createTextNode(' · ')); pager.appendChild(optionButton(o)); });
    }
    if (card.label) b.appendChild(el('span', 'label ' + card.label.replace(/ /g, '-'), card.label));
    var title = b.appendChild(el('h1', null, card.title));
    // on the team, what just changed (a swap) is the first thing under the title, above a long table
    var news = card.kind === 'team' && card.line;
    if (news) b.appendChild(el('p', 'mission', card.line)).classList.add('news');
    // a reply of more than one line reads at the body size, in the same spot
    if (card.kind === 'reply') {
      var lines = document.createRange();
      lines.selectNodeContents(title);
      if (lines.getClientRects().length > 1) title.classList.add('said');
    }
    if (card.body) b.appendChild(el('p', 'why', card.body));
    var calm = isWait(card);
    // the calm line: what the writer is doing now, how long it has been, and the notes typed here
    if (calm) { b.appendChild(el('p', 'waitstep')); b.appendChild(el('span', 'waittime')); b.appendChild(el('div', 'waitnotes')); }
    // a reply keeps the title's spot; the turns so far sit quietly under it
    if (!calm && card.thread && card.thread.length) {
      var thread = b.appendChild(el('div', 'thread'));
      card.thread.forEach(function (t) { thread.appendChild(el('p', 'turn ' + (t.who === 'owner' ? 'you' : 'orb'), t.text)); });
    }
    // who it is and what they do; the rating and the model live on the team table.
    // a talk card's title is already the name, so its line is the role alone
    if (card.job && !card.table && !calm) b.appendChild(el('p', 'jobline', [card.job.member !== card.title && card.job.member, card.job.role].filter(Boolean).join(' · ')));
    var inCells = card.options.filter(function (o) { return o.cell; });
    if (card.table) {
      var grid = b.appendChild(drawTable(card, inCells));
      // whatever scrolls into view in the table lands beside the held names, never under them
      var held = grid.querySelector('tbody td.member');
      if (held && getComputedStyle(held).position === 'sticky') grid.style.scrollPaddingLeft = held.offsetWidth + 'px';
      moreRight(grid);
      grid.addEventListener('scroll', function () { moreRight(grid); }, { passive: true });
    }
    if (card.time) b.appendChild(el('span', 'time', card.time));
    if (card.line && !news) b.appendChild(el('p', 'mission', card.line));
    // the options in the card's own order; quiet ones next to each other share one line
    var rest = card.options.filter(function (o) { return !o.cell && flips.indexOf(o) < 0; });
    var quiet = function (o) { return !o.style || o.style === 'quiet'; };
    var act = el('div', 'act' + (rest.some(function (o) { return o.style === 'choice' || o.style === 'option'; }) ? ' answers' : ''));
    var links = null;
    var group = null;
    rest.forEach(function (o) {
      if (!quiet(o)) { links = null; act.appendChild(optionButton(o)); return; }
      // a group of quiet options shares one line, headed by its words
      if (links && (o.group || null) === group) links.appendChild(el('span', 'sep', ' · '));
      else {
        links = act.appendChild(el('div', 'links'));
        group = o.group || null;
        if (group) links.appendChild(document.createTextNode(group + ': '));
      }
      links.appendChild(optionButton(o));
    });
    // a quiet line under the options, empty until something does not go through
    // a status: a screen reader hears the line why the moment it appears
    act.appendChild(el('p', 'links note')).setAttribute('role', 'status');
    b.appendChild(act);
    breakLinks(act);
    if (card.input) b.appendChild(inputLine(card.input));
    if (calm) live(card, true);
    announce(card);
  }

  // A screen reader hears each new card once as it lands: its title and its
  // why. The region empties first, so a card with the same words is heard too.
  var heard = { id: null, at: 0 };
  function announce(card) {
    // the card is named by its own title in a screen reader's list
    box().setAttribute('aria-label', String(card.title || ''));
    // a button in a table cell says what it does, not only the word in the cell
    card.options.forEach(function (o) {
      var who = o.cell && o.binds && o.binds.member;
      var btn = who && box().querySelector('[data-option="' + o.id + '"]');
      if (!btn) return;
      if (o.action === 'member') btn.setAttribute('aria-label', 'talk to ' + who);
      if (o.action === 'swap') btn.setAttribute('aria-label', who + "'s model, " + o.label + '. tap to change it');
    });
    if (heard.id === card.id) return;
    heard.id = card.id;
    var said = document.getElementById('said');
    var title = String(card.title || '');
    var words = card.body ? title + (/[.?!]$/.test(title) ? ' ' : '. ') + card.body : title;
    said.textContent = '';
    clearTimeout(heard.at);
    heard.at = setTimeout(function () { said.textContent = words; }, 60);
  }

  // the fade on a table's right edge, while some of it is still off to the right
  function moreRight(grid) { grid.classList.toggle('more-right', grid.scrollLeft + grid.clientWidth < grid.scrollWidth - 1); }
  window.addEventListener('resize', function () { var g = box().querySelector('.grid'); if (g) moreRight(g); });
  // A row of small links that wraps never ends or starts a line with its dot:
  // a dot whose two links sit on different lines becomes the line break.
  function breakLinks(root) {
    var seps = root.querySelectorAll('.links .sep');
    Array.prototype.forEach.call(seps, function (s) { s.classList.remove('cut'); });
    var cut = Array.prototype.filter.call(seps, function (s) {
      var a = s.previousElementSibling, z = s.nextElementSibling;
      return a && z && z.getBoundingClientRect().top > a.getBoundingClientRect().top + 1;
    });
    cut.forEach(function (s) { s.classList.add('cut'); });
  }
  window.addEventListener('resize', function () { breakLinks(box()); });

  // a table: one row per line, a line between every cell; an option with a
  // cell is drawn in that cell, and a tap anywhere on its row opens the
  // row's first option
  function drawTable(card, inCells) {
    var t = card.table;
    var grid = el('div', 'grid');
    var table = grid.appendChild(el('table', 'k-' + card.kind));
    var head = el('tr');
    t.columns.forEach(function (c) { head.appendChild(el('th', c, c)).scope = 'col'; });
    table.appendChild(el('thead')).appendChild(head);
    var body = table.appendChild(el('tbody'));
    t.rows.forEach(function (row, i) {
      var mine = inCells.filter(function (o) { return o.cell.row === i; });
      var tr = body.appendChild(el('tr', mine.length ? 'row' : null));
      row.forEach(function (cell, j) {
        var col = t.columns[j];
        var td = tr.appendChild(el('td', col + (col === 'status' && t.status ? ' ' + String(t.status[i] || '').replace(/ /g, '-') : '')));
        td.setAttribute('data-col', col);
        var o = mine.filter(function (x) { return x.cell.column === col; })[0];
        if (o) {
          var btn = td.appendChild(optionButton(o, true));
          btn.addEventListener('click', function (e) { e.stopPropagation(); });
        } else td.textContent = cell;
      });
      if (mine.length) tr.addEventListener('click', function (e) { rowTap(tr, e); });
    });
    return grid;
  }

  // a tap on a row: the button in the cell that was tapped, so a tap beside
  // a model's words still opens its swap; else the row's first
  function rowTap(tr, e) {
    // a press that dragged to select words in the row is reading, not a tap
    var sel = window.getSelection && window.getSelection();
    if (sel && !sel.isCollapsed && tr.contains(sel.anchorNode)) return;
    var at = e.composedPath()[0], cell = at.closest && at.closest('td');
    var b = (cell && cell.querySelector('button')) || tr.querySelector('button');
    if (b) b.click();
  }

  // One option, as the card says: big or quiet, a second tap when it asks
  // for one, a box when it takes words. bare: no class of its own (in a cell).
  function optionButton(o, bare) {
    var cls = bare ? null : o.style === 'primary' ? 'pill' : o.style === 'choice' ? 'choice' : o.style === 'option' ? 'option' : null;
    var btn = el('button', cls);
    btn.type = 'button';
    btn.setAttribute('data-option', o.id);
    if (o.style === 'option' || (o.detail && o.style === 'choice')) {
      btn.appendChild(el('span', 't', o.label));
      if (o.detail) btn.appendChild(el('span', 'w', o.detail));
    } else btn.textContent = o.label;
    if (o.chosen) btn.classList.add('chosen');
    if (o.type) btn.classList.add('other');
    if (o.action === 'none') { btn.disabled = true; return btn; }
    if (o.confirm) {
      // the first tap arms this one button; the second sends; it goes quiet after five seconds.
      // A second tap within ARM_GAP_MS is the same fumbled double tap, so it never sends.
      var armed = false, armedAt = 0, quiet = null, ARM_GAP_MS = 400;
      // Esc steps back from an armed button before anything else
      btn.disarm = function () {
        if (!armed) return false;
        clearTimeout(quiet); armed = false; btn.textContent = o.label; btn.classList.remove('armed');
        return true;
      };
      btn.addEventListener('click', function () {
        if (bet.busy) return;
        if (armed && performance.now() - armedAt < ARM_GAP_MS) return;
        buzz();
        if (!armed) {
          armed = true; btn.textContent = o.confirm; btn.classList.add('armed'); armedAt = performance.now();
          quiet = setTimeout(function () { armed = false; btn.textContent = o.label; btn.classList.remove('armed'); }, 5000);
          return;
        }
        clearTimeout(quiet);
        armed = false;
        send(btn, { option_id: o.id, confirm: true }, o);
      });
      return btn;
    }
    btn.addEventListener('click', function () {
      if (bet.busy) return;
      buzz();
      if (o.type) { typeHere(btn, o.type.placeholder || o.label, o.type.max || 280, function (text, field) { send(field, { option_id: o.id, text: text }, o); }); return; }
      send(btn, { option_id: o.id }, o);
    });
    return btn;
  }

  // the card's box: a quiet line that turns into the field in its own spot.
  // On the calm line it is open from the start and stays open, without
  // taking the cursor, and the words are a note for the idea being written.
  function inputLine(input) {
    var wrap = el('div', 'links sayline');
    var open = wrap.appendChild(el('button', 'quiet', input.label || 'or say something'));
    open.type = 'button';
    open.addEventListener('click', function () {
      if (bet.busy) return;
      typeHere(open, input.placeholder || 'say something', input.max || 280, function (text, field) { send(field, { text: text }, null); });
    });
    if (box().getAttribute('data-kind') === 'wait') typeHere(open, input.placeholder || 'add a note for this idea', input.max || 280, function (text, field) { sendNote(field, text); }, true);
    return wrap;
  }

  // ---- answering in place: the eyes stay in one spot ---------------------------------
  // every row of the card dims but the one in use; no spot, none
  function dimOthers(spot) {
    box().querySelectorAll('.act > *, .act .links > button, .sayline, .grid, .deckhead').forEach(function (n) {
      n.classList.toggle('muted', Boolean(spot) && n !== spot && !n.contains(spot) && !spot.contains(n));
    });
  }

  // the spot holds as chosen and the card takes no taps; returns when it started
  function hold(spot) {
    dimOthers(spot);
    spot.classList.add('chosen');
    box().classList.add('holding');
    var input = spot.querySelector('input');
    if (input) { input.readOnly = true; input.blur(); }
    bet.busy = true;
    var at = tapped();
    planned('hold', HOLD_MS);
    return at;
  }

  function afterHold(heldAt) {
    var left = heldAt ? heldAt + HOLD_MS - performance.now() : 0;
    return new Promise(function (resolve) { setTimeout(resolve, Math.max(0, left)); });
  }

  // The tapped button becomes the field at its own size and spot, with the
  // cursor already in it, and the other options dim. Enter or send hands
  // the words to sent(text, field). Left empty, it turns back into the button.
  // stay: the calm line's box, open from the start without the cursor, and
  // open after every send.
  var FULL = 'that is as much as fits in the box.';
  function typeHere(btn, placeholder, maxLength, sent, stay) {
    var field = el('div', btn.classList.contains('choice') ? 'choice field' : 'field');
    // its exact height, to the subpixel, so nothing under it moves
    if (stay) field.classList.add('stay'); else field.style.height = btn.getBoundingClientRect().height + 'px';
    var input = el('input');
    input.type = 'text';
    input.maxLength = maxLength;
    input.placeholder = placeholder;
    input.enterKeyHint = 'send';
    input.setAttribute('aria-label', placeholder);
    var go = el('button', 'send', 'send');
    go.type = 'button';
    var submit = function () {
      var text = input.value.trim();
      if (text && !bet.busy && !bet.noting) sent(text, field);
    };
    // a press on send keeps the cursor in the field, so it never closes first
    go.addEventListener('mousedown', function (e) { e.preventDefault(); });
    go.addEventListener('click', function () { buzz(); submit(); });
    // a full box says so under the card, so a long paste is never cut off unseen
    input.addEventListener('input', function () {
      var note = box().querySelector('.act .note');
      if (!note) return;
      if (input.value.length >= maxLength) note.textContent = FULL;
      else if (note.textContent === FULL) note.textContent = '';
    });
    input.addEventListener('keydown', function (e) {
      // Enter while a word is still being composed (a Japanese, Chinese, or Korean keyboard) is the keyboard's
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); }
    });
    // the focus leaving the whole box, not moving inside it (Tab to send):
    // an empty box turns back into its button, and when the focus went
    // nowhere (Esc, a tap on the page) the button takes it back
    field.addEventListener('focusout', function () {
      setTimeout(function () {
        if (field.contains(document.activeElement)) return;
        if (stay || input.value.trim() || field.classList.contains('chosen') || !field.isConnected) return;
        var lost = focusFree();
        field.replaceWith(btn);
        dimOthers(null);
        if (lost) btn.focus({ preventScroll: true });
      }, 0);
    });
    field.appendChild(input);
    field.appendChild(go);
    btn.replaceWith(field);
    if (stay) return field;
    dimOthers(field);
    input.focus();
    return field;
  }

  // One id per send: made when these words are first sent from this card's
  // option or box, the same on every retry of them there, and new for any
  // other card, option, or words, so a send whose answer was lost is never
  // sent twice and the same words to someone else always go. getRandomValues
  // works on the plain http of the wifi link, where randomUUID does not.
  var sent = { key: null, id: null };
  function sendId(key) {
    if (sent.key !== key) {
      var n = new Uint32Array(2);
      crypto.getRandomValues(n);
      sent.key = key;
      sent.id = ('000000' + n[0].toString(36)).slice(-7) + ('000000' + n[1].toString(36)).slice(-7);
    }
    return sent.id;
  }

  // ---- acting: one post, then one motion to the next card ------------------------------
  // The option holds as chosen for HOLD_MS. Then the card fades while the
  // small orb glides into the sphere; once the answer is in, the dots
  // spiral in and the next card blooms where they land. An answer that is
  // late leaves the sphere in its idle drift until it lands. A line from the
  // Mac (who has it now) shows under the sphere while it waits. When it did
  // not go through, the same card comes back with the words still in its
  // box and one line why. Flipping the deck turns the card in place.
  function send(spot, body, option) {
    if (!bet.shown) return;
    var from = bet.shown;
    body.card_id = from.id;
    if (body.text) body.send = sendId([from.id, option ? option.id : 'the box', body.text].join(' | '));
    // a tap carries its own id too, so trying again on a tap the page stopped
    // waiting on gets the first one's answer and never does a yes or a swap twice
    if (!body.send && option) body.send = sendId([from.id, option.id].join(' | '));
    var heldAt = hold(spot);
    var answer = api('/act', body).catch(offline);
    var late = answer;
    answer = patient(answer);
    whenLate(answer, late, from);
    var around = option && AROUND.indexOf(option.action) >= 0;
    // the way out of the team when it was opened from the big orb goes back to the big orb
    var homeward = Boolean(around && option.action === 'back' && from.kind === 'team' && teamFromHome);
    if (option && (IN_PLACE.indexOf(option.action) >= 0 || around)) {
      document.body.setAttribute('data-in-place', '');
      Promise.all([answer, afterHold(heldAt)]).then(function (both) {
        var r = both[0];
        if (homeward && r.ok) { teamFromHome = false; r = { ok: true, card: null }; }
        // nothing is up on the Mac: the big orb, as from any card
        if (gone(r)) { document.body.removeAttribute('data-in-place'); leave(function () { bet.busy = false; bet.shown = null; orb.calm(); line.set('tap to think', false); }); return; }
        // a refusal that brings the card the Mac has now: that card, at once, never the stale one again
        var now = !r.ok && r.card && !sameCard(r.card, from) ? r.card : null;
        // nothing left to show, the calm line (it has its own way in), or a width the page
        // would jump to: the one motion through the sphere, as from the orb
        var through = r.ok ? (around && (r.home || !r.card || widthJumps(r.card))) || isWait(r.card) : Boolean(now && (isWait(now) || widthJumps(now)));
        if (through) { document.body.removeAttribute('data-in-place'); flow(Promise.resolve(r), from, body.text, option); return; }
        if (now) { turnTo(now, function () { unsent(now, r, body.text, null); }); return; }
        if (!r.ok || !r.card) { bet.busy = false; document.body.removeAttribute('data-in-place'); unsent(from, r, body.text, option); return; }
        turnTo(r.card);
      });
      return;
    }
    afterHold(heldAt).then(function () { flow(answer, from, body.text, option); });
  }

  // While the sphere waits on the Mac's answer its line says nothing, since
  // a tap there does nothing yet; past SLOW_MS it says the Mac is still at it.
  var SLOW_MS = 8000;
  function waitLine(answer) {
    // under a card the line is out of sight, so it empties at once and the next line is never held up by a fade no one sees
    if (document.body.classList.contains('has-card')) line.clear(); else line.set('', false);
    var slow = setTimeout(function () { line.set('still waiting on the mac', false); }, SLOW_MS);
    var done = function () { clearTimeout(slow); };
    answer.then(done, done);
  }

  function flow(answer, from, typed, option) {
    waitLine(answer);
    var landed = null;
    var sphere = false;
    var lineAt = 0, waitFrom = 0;
    var land = function () {
      // the sphere is ready before the answer is in: it waits from now
      if (sphere && !landed) waitFrom = performance.now();
      if (!landed || !sphere) return;
      if (waitFrom) bet.waited += performance.now() - waitFrom;
      var r = landed;
      landed = null;
      var wait = r.ack && lineAt ? Math.max(0, AFTER_MS - (performance.now() - lineAt)) : 0;
      if (wait) planned('line', wait);
      setTimeout(function () {
        // nothing more to show: the sphere stays, with its line, and its dots settle into the idle drift
        if (r.ok && (r.home || !r.card)) { bet.busy = false; bet.shown = null; orb.calm(); line.set(r.home ? 'tap when you want another idea' : 'tap to think', false); return; }
        // the Mac has no card up at all (it started again, or the card was
        // finished elsewhere): the old card is gone, so the big orb waits for a tap
        if (gone(r)) { bet.busy = false; bet.shown = null; orb.calm(); line.set('tap to think', false); return; }
        // the card the Mac has on screen now is the one that comes back; a
        // refusal comes back on it with one line why
        var then = r.card || from;
        if (!then) { bet.busy = false; orb.calm(); line.set('that did not go through. tap to try again.', true); return; }
        if (!r.ok) { spiralTo(then, function () { unsent(then, r, typed, then.id === (from && from.id) ? option : null); }); return; }
        spiralTo(then, null);
      }, wait);
    };
    answer.then(function (r) {
      landed = r;
      if (r.ok && r.ack) { lineAt = performance.now(); line.set(r.ack, false); }
      land();
    });
    leave(function () { sphere = true; land(); }, true);
  }

  // the card fades in place while the small orb glides down and becomes the
  // sphere; the card leaves the page once it has faded all the way. From the
  // calm line the sphere is already there: its words fade and it glides home.
  function leave(then, fast) {
    endOpening();
    if (waiting()) { leaveWait(then, fast); return; }
    var b = box();
    var to = sphereSpot();
    b.classList.remove('quick', 'acted', 'up');
    b.classList.add('leave');
    b.classList.toggle('fast', Boolean(fast));
    var swap = function () {
      b.style.minHeight = '';
      b.hidden = true;
      b.classList.remove('leave', 'fast', 'holding');
      document.body.classList.remove('has-card', 'wide');
      line.appear();
      window.scrollTo(0, 0);
    };
    // reduced motion: no travel; the card and the small orb fade, then the sphere is there
    if (reduced) {
      document.getElementById('lava').style.opacity = '0';
      planned('leave', 200);
      setTimeout(function () { swap(); stageFade(); orb.melt(then, to, function () {}, fast); }, 200);
      return;
    }
    orb.melt(then, to, swap, fast);
  }

  // under reduced motion the sphere never travels: it fades in where it now sits
  // and its line fades in with it
  function stageFade() {
    if (!reduced) return;
    [document.getElementById('stage'), document.getElementById('line')].forEach(function (n) {
      n.style.transition = 'none';
      n.style.opacity = '0';
      void n.offsetWidth;
      n.style.transition = 'opacity 0.2s linear';
      n.style.opacity = '';
    });
  }

  // Under reduced motion a card that comes while the sphere shows waits for
  // the sphere and its line to fade out, so they are never gone in one frame;
  // stageFade brings them back. True when there was a sphere to fade.
  function fadeSphere() {
    var stage = document.getElementById('stage');
    if (!reduced || !stage.offsetHeight || Number(getComputedStyle(stage).opacity) < 0.05) return false;
    [stage, document.getElementById('line')].forEach(function (n) { n.style.transition = 'opacity 0.2s linear'; n.style.opacity = '0'; });
    planned('out', 200);
    return true;
  }

  // from the sphere: the dots spiral in and the card grows out of the point.
  // The calm line is not a card that blooms: the sphere stays and its dots keep moving.
  function spiralTo(card, after) {
    line.set('', false);
    if (isWait(card)) { enterWait(card); if (after) after(); return; }
    // reduced motion: no spiral; the card fades in where it goes
    if (reduced) {
      var show = function () { orb.settled(); showCard(card, true); bet.busy = false; if (after) after(); };
      if (fadeSphere()) setTimeout(show, 200); else show();
      return;
    }
    orb.play(function (phase) {
      // the card blooms where the dots land; what comes with it (a line why, the words back in their box) comes with it
      if (phase === 'cover') { showCard(card, true, true, true); if (after) after(); }
      if (phase === 'settled') bet.busy = false;
    }, true, true);
  }

  // It did not go through: this card as it was, one line why under its
  // options, and typed words back in their box with the cursor in it.
  function unsent(card, r, typed, option) {
    if (bet.shown !== card || box().getAttribute('data-card') !== card.id) showCard(card, false);
    box().classList.remove('holding');
    var note = box().querySelector('.act .note');
    // the Mac's own refusals are plain words; anything else reads as one plain line
    if (note) note.textContent = (r && r.http === 409 && r.message) || (r && r.http === 0 && r.message) || 'that did not go through. try again.';
    if (!typed) return;
    // the calm line's box is open already: the words go back into it
    var openBox = !option && box().querySelector('.sayline .field.stay input');
    if (openBox) { openBox.value = typed; return; }
    // the words go back where they were typed, or to this card's own box when the card is a new one
    var spot = option ? box().querySelector('[data-option="' + option.id + '"]') : box().querySelector('.sayline .quiet');
    if (!spot) return;
    if (!option && !card.input) return;
    var field = typeHere(spot, (option && option.type && option.type.placeholder) || (card.input && card.input.placeholder) || 'say something', 280, function (text, f) { send(f, option ? { option_id: option.id, text: text } : { text: text }, option); });
    field.querySelector('input').value = typed;
  }

  // ---- showing a card ---------------------------------------------------------------------
  // The time from the tap to the card fully on screen, kept on the page so
  // the speed can be measured. data-reveal-ms is the clock. data-reveal-plan
  // is each step of the motion in order with the length it is set to take,
  // and data-reveal-waited-ms is how long the sphere waited on the Mac's
  // answer, so late frames on a busy machine are told apart from the motion.
  var REVEAL = ['data-reveal-ms', 'data-reveal-plan', 'data-reveal-waited-ms'];
  function tapped() {
    bet.tapAt = performance.now();
    bet.plan = [];
    bet.waited = 0;
    REVEAL.forEach(function (a) { document.body.removeAttribute(a); });
    return bet.tapAt;
  }
  function planned(name, ms) { if (bet.tapAt) bet.plan.push(name + ' ' + Math.round(ms)); }
  function measured() {
    if (bet.tapAt) {
      document.body.setAttribute('data-reveal-plan', bet.plan.join(', '));
      document.body.setAttribute('data-reveal-waited-ms', String(Math.round(bet.waited)));
      document.body.setAttribute('data-reveal-ms', String(Math.round(performance.now() - bet.tapAt)));
    }
    bet.tapAt = 0;
  }
  // how long a card's own fade up is set to take, read from its style
  function fadeMs(n) {
    var s = getComputedStyle(n);
    var i = Math.max(0, s.transitionProperty.split(', ').indexOf('opacity'));
    var at = function (list) { var v = list.split(', '); return (parseFloat(v[i % v.length]) || 0) * 1000; };
    return at(s.transitionDelay) + at(s.transitionDuration);
  }

  // fast: the quick fade from the big orb; act: the short one after an act
  function showCard(card, animate, fast, act) {
    if (isWait(card)) { enterWait(card, !animate); return; }
    var b = box();
    bet.shown = card;
    // where it starts from is set first: drawing measures the title, and a
    // measure is a frame the card would otherwise start from somewhere else
    b.classList.remove('leave', 'fast', 'holding', 'wait-in');
    b.classList.toggle('quick', Boolean(fast) && !act);
    b.classList.toggle('acted', Boolean(act));
    b.classList.toggle('up', !animate);
    // on the page before it is drawn, so a long title can tell it runs past one line
    document.body.classList.remove('waiting');
    document.body.classList.add('has-card');
    b.hidden = false;
    draw(card);
    if (card.watch) watchWait(); else stopWatch();
    if (!animate) { measured(); return; }
    // the fade ends the marks of the tap that brought this card, never those of a tap made since
    var startedAt = bet.tapAt;
    var done = function (e) { if (e.propertyName === 'opacity') { b.removeEventListener('transitionend', done); if (bet.tapAt === startedAt) measured(); } };
    b.addEventListener('transitionend', done);
    void b.offsetWidth;
    requestAnimationFrame(function () { b.classList.add('up'); planned('fade', fadeMs(b)); });
  }

  // ---- the calm line: the dots keep moving while the next idea is written -----------------
  // The sphere stays on the page, a little smaller and higher, and its dots
  // swarm. The card sits under it with what the writer is doing now, and its
  // box is open: words typed there are a note for the idea being written,
  // and the card stays. When the idea lands it grows out of the dots. A tap
  // on the dots goes back to the big orb, as the small orb does on a card.
  function isWait(card) { return Boolean(card && card.kind === 'wait'); }
  function waiting() { return document.body.classList.contains('waiting'); }
  // the calm line is one card while its words change, under any stamp
  function sameCard(a, b) { return Boolean(a && b && (a.id === b.id || (isWait(a) && isWait(b) && String(a.id).split('#')[0] === String(b.id).split('#')[0]))); }

  // the smaller sphere's place: at most 300px, and high enough that the card
  // under it has WAIT_ROOM. It is read from the sphere's own place in the
  // layout, which the calm line keeps and a transform never moves.
  var WAIT_ROOM = 250;
  function placeWait(animate) {
    var stage = document.getElementById('stage');
    var body = document.body;
    var hidden = !stage.offsetHeight;
    if (hidden) body.classList.add('has-card', 'waiting');
    var screenTop = document.getElementById('screen').getBoundingClientRect().top;
    var h = stage.offsetHeight || 1, top0 = screenTop + stage.offsetTop;
    if (hidden) body.classList.remove('waiting');
    // and on a short screen (a phone on its side) small enough that the sphere,
    // the card's room, and a margin above and below fit, so the footer never lands on the card
    var k = Math.min(1, 300 / h, 0.62 * Math.min(window.innerWidth, window.innerHeight) / h, Math.max(80, window.innerHeight - WAIT_ROOM - 48) / h);
    var top = Math.max(24, (window.innerHeight - (k * h + WAIT_ROOM)) / 2);
    var s = body.style;
    s.setProperty('--wait-k', k.toFixed(4));
    s.setProperty('--wait-dy', Math.round(top - top0) + 'px');
    s.setProperty('--wait-top', Math.round(top + k * h + 6 - screenTop) + 'px');
    if (animate) return;
    stage.style.transition = 'none';
    requestAnimationFrame(function () { requestAnimationFrame(function () { stage.style.transition = ''; }); });
  }

  // The phone keyboard opened (the part of the screen still showing shrank)
  // over the box being typed in: the box comes back into view. A box the
  // phone already brought into view is left where it is.
  if (window.visualViewport) window.visualViewport.addEventListener('resize', function () {
    var input = document.activeElement;
    if (!input || input.tagName !== 'INPUT' || !box().contains(input)) return;
    var vv = window.visualViewport, r = input.getBoundingClientRect();
    if (r.bottom > vv.offsetTop + vv.height - 8 || r.top < vv.offsetTop) input.scrollIntoView({ block: 'center', inline: 'nearest' });
  });

  // a turned phone: the calm line's sphere and card find their place again
  window.addEventListener('resize', function () { if (waiting()) placeWait(false); });

  // The calm line's card takes no room of its own. On a screen too short for
  // it (a phone on its side, a note and its answer open) the footer moves
  // into the card's own room under its words instead of sitting on them,
  // and the page scrolls to it; the sphere and the card never move.
  function fitWait() {
    var foot = document.getElementById('foot');
    var b = box();
    var need = waiting() && !b.hidden ? b.offsetTop + b.offsetHeight : 0;
    var over = need > document.getElementById('screen').clientHeight;
    foot.style.top = over ? Math.round(need - 64) + 'px' : '';
    foot.style.bottom = over ? 'auto' : '';
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(fitWait).observe(box());
  window.addEventListener('resize', fitWait);

  // atOnce: the page opened on it, so it is simply there
  function enterWait(card, atOnce) {
    var b = box();
    var was = waiting() && !b.hidden;
    bet.shown = card;
    if (atOnce) line.clear(); else line.set('', false);
    orb.swarm();
    if (!was) { placeWait(!atOnce && !reduced); stageFade(); }
    b.classList.remove('leave', 'fast', 'holding', 'quick', 'acted', 'up', 'wait-in');
    document.body.classList.add('has-card', 'waiting');
    document.getElementById('orb').setAttribute('aria-label', 'the atris orb, writing your next idea. tap to go back to the big orb');
    b.hidden = false;
    draw(card);
    watchWait();
    bet.busy = false;
    if (was || atOnce) { b.classList.add('up'); return; }
    b.classList.add('wait-in');
    void b.offsetWidth;
    requestAnimationFrame(function () { b.classList.add('up'); });
  }

  // The calm line's live words: what the writer is doing now, how long it
  // has been, and the newest note typed here with the answer to it. draw()
  // puts them on the card; while it shows they are kept fresh in place. Its
  // options and its box never change under one id, so the field, its words,
  // and the cursor in it are never touched.
  function live(card, atOnce) {
    var b = box();
    var step = b.querySelector('.waitstep');
    if (!isWait(card) || !step) return;
    bet.shown = card;
    b.setAttribute('data-card', card.id);
    var h = b.querySelector('h1');
    if (h.textContent !== card.title) h.textContent = card.title;
    var lines = Array.isArray(card.progress) ? card.progress : [];
    var newest = lines.length ? lines[lines.length - 1] : null;
    stepTo(step, newest && typeof newest.line === 'string' ? newest.line : '', atOnce);
    notesTo(b.querySelector('.waitnotes'), card.thread || [], atOnce);
    // the Mac's own count of how long it has been, carried on from when it came
    if (Number.isFinite(card.waited_ms)) waitClock = { key: String(card.id).split('#')[0], ms: card.waited_ms, at: Date.now() };
    tickWait();
  }

  // one line at a time, crossfaded in its own spot, so nothing under it moves
  function stepTo(node, text, atOnce) {
    if (node.getAttribute('data-text') === text) return;
    node.setAttribute('data-text', text);
    clearTimeout(node.fading);
    if (atOnce || reduced || !node.textContent) { node.textContent = text; node.classList.remove('out'); return; }
    node.classList.add('out');
    node.fading = setTimeout(function () { node.textContent = node.getAttribute('data-text'); node.classList.remove('out'); }, 260);
  }

  // the newest note and the answer to it; a new one fades in, and the room it
  // takes opens smoothly
  function notesTo(node, turns, atOnce) {
    var want = turns.slice(-2);
    var had = Array.prototype.map.call(node.children, function (n) { return n.textContent; });
    if (had.join('\\n') === want.map(function (t) { return t.text; }).join('\\n')) return;
    var from = node.offsetHeight;
    node.style.height = '';
    node.textContent = '';
    want.forEach(function (t, i) {
      var p = node.appendChild(el('p', 'turn ' + (t.who === 'owner' ? 'you' : 'orb'), t.text));
      if (!atOnce && !reduced && had[i] !== t.text) p.classList.add('fresh');
    });
    if (atOnce || reduced) return;
    var to = node.offsetHeight;
    if (from !== to) {
      node.style.height = from + 'px';
      void node.offsetHeight;
      node.style.height = to + 'px';
      clearTimeout(node.opening);
      node.opening = setTimeout(function () { node.style.height = ''; }, 340);
    }
    requestAnimationFrame(function () { requestAnimationFrame(function () { Array.prototype.forEach.call(node.querySelectorAll('.fresh'), function (p) { p.classList.remove('fresh'); }); }); });
  }

  // how long the idea has been written, in plain words: the Mac's own count
  // when the card has it, else from when it began on the Mac's clock when
  // that is sane, else from when the page first saw the calm line
  var seen = { key: null, at: 0 };
  var waitClock = { key: null, ms: 0, at: 0 };
  function sinceWords(ms) {
    var s = Math.round(ms / 1000);
    if (!(s >= 5) || s > 3600) return '';
    if (s < 60) return Math.max(5, Math.round(s / 5) * 5) + ' seconds so far';
    var m = Math.round(s / 60);
    return m === 1 ? 'about a minute so far' : 'about ' + m + ' minutes so far';
  }
  function tickWait() {
    var node = box().querySelector('.waittime');
    var card = bet.shown;
    if (!node || !isWait(card) || !waiting()) { clearInterval(bet.clock); bet.clock = null; return; }
    var key = String(card.id).split('#')[0];
    if (seen.key !== key) seen = { key: key, at: Date.now() };
    var began = typeof card.started_at === 'number' ? card.started_at : Date.parse(card.started_at || '');
    var ms = waitClock.key === key ? waitClock.ms + (Date.now() - waitClock.at) : Date.now() - began;
    if (!(ms >= 0 && ms < 3600000)) ms = Date.now() - seen.at;
    var words = sinceWords(ms);
    if (node.textContent !== words) node.textContent = words;
    if (!bet.clock) bet.clock = setInterval(tickWait, 1000);
  }

  // A note on the calm line: the words hold in the box for the moment it
  // takes, then the box clears and stays open, and the note and the answer
  // to it show above. Nothing moves on: the idea that comes in is the one
  // written with it. Words that did not reach the Mac stay in the box.
  function sendNote(field, text) {
    var from = bet.shown;
    var input = field.querySelector('input');
    var body = { card_id: from.id, text: text, send: sendId([from.id, 'the box', text].join(' | ')) };
    bet.noting = true;
    field.classList.add('chosen');
    input.readOnly = true;
    // a note that takes a while reads as on its way, in send's own spot
    var go = field.querySelector('.send');
    var slow = setTimeout(function () { go.textContent = 'sending'; go.classList.add('reading'); }, 600);
    var note = box().querySelector('.act .note');
    if (note) note.textContent = '';
    var told = api('/act', body).catch(offline);
    patient(told).then(function (r) {
      bet.noting = false;
      clearTimeout(slow); go.textContent = 'send'; go.classList.remove('reading');
      // a note the page stopped waiting on: its words stay, and once the Mac has it the box clears
      if (r.slow) told.then(function (l) { if (!l.ok || !waiting() || bet.noting) return; if (input.value.trim() === text) input.value = ''; var n = box().querySelector('.act .note'); if (n && n.textContent === STILL) n.textContent = ''; if (l.card && sameCard(l.card, bet.shown)) live(l.card); });
      field.classList.remove('chosen');
      input.readOnly = false;
      // the owner went back to the big orb meanwhile: the Mac has the note, and nothing here moves
      if (!waiting()) return;
      if (r.ok && r.card && sameCard(r.card, from)) { input.value = ''; input.blur(); live(r.card); return; }
      // the Mac moved on (the idea landed meanwhile): it comes in, and the words go back in its box
      if (r.card && !sameCard(r.card, from)) { landFromWait(r.card, r.ok ? null : function () { unsent(r.card, r, text, null); }); return; }
      if (note) note.textContent = (r && r.message) || 'that did not go through. try again.';
    });
  }

  // off the calm line, home or to an act's next card: its words fade, then
  // the sphere glides back to its own place and size
  function leaveWait(then, fast) {
    var b = box();
    stopWatch();
    if (!fast) orb.calm();
    b.classList.remove('wait-in');
    b.classList.add('leave', 'fast');
    // under reduced motion the sphere fades out with the words, then fades in at its own place
    fadeSphere();
    setTimeout(function () {
      b.hidden = true;
      b.classList.remove('leave', 'fast', 'holding', 'up');
      document.body.classList.remove('has-card', 'wide', 'waiting');
      stageFade();
      document.getElementById('orb').setAttribute('aria-label', 'the atris orb. tap to think of one new idea for the business');
      then();
    }, 220);
  }

  // The idea lands: the calm line's words fade while the dots spiral in
  // from wherever they are, and the card grows out of the point.
  function landFromWait(card, after) {
    var b = box();
    bet.busy = true;
    stopWatch();
    b.classList.remove('wait-in');
    b.classList.add('leave', 'fast');
    var off = function () {
      b.classList.remove('leave', 'fast');
      document.body.classList.remove('waiting');
      document.getElementById('orb').setAttribute('aria-label', 'the atris orb. tap to think of one new idea for the business');
    };
    if (reduced) {
      fadeSphere();
      setTimeout(function () { off(); orb.settled(); showCard(card, true); bet.busy = false; if (after) after(); }, 200);
      return;
    }
    orb.play(function (phase) {
      if (phase === 'cover') { off(); showCard(card, true, true, true); if (after) after(); }
      if (phase === 'settled') bet.busy = false;
    }, true, true);
  }

  // a card the Mac has now that is not the one on screen
  function arrive(card) {
    if (waiting()) { landFromWait(card); return; }
    if (isWait(card)) { leave(function () { enterWait(card); }, true); return; }
    turnTo(card);
  }

  // where the sphere sits once the card is gone, read before anything moves,
  // in page coordinates (the screen's once the page is back at the top)
  function sphereSpot() {
    var b = box();
    var y0 = window.scrollY, was = b.hidden, wide = document.body.classList.contains('wide');
    document.body.classList.remove('has-card', 'wide');
    b.hidden = true;
    var r = document.getElementById('orb').getBoundingClientRect();
    var spot = { x: r.left + r.width / 2, y: r.top + window.scrollY + r.height / 2 };
    document.body.classList.add('has-card');
    if (wide) document.body.classList.add('wide');
    b.hidden = was;
    if (window.scrollY !== y0) window.scrollTo(0, y0);
    return spot;
  }

  // Card to card in place: a still copy of the old card fades over the box
  // while the new card, drawn under it, fades in from DRIFT below over
  // TURN_IN_MS, starting 80ms in, so its title lands where the old title
  // was. The box eases to its new height. No layout jump.
  var TURN_IN_MS = 320, DRIFT = 4;
  // painted: what goes on the new card as it is drawn (a line why), so its height is measured with it
  function turnTo(card, painted) {
    var b = box();
    b.classList.remove('holding');
    var otherPlace = b.getAttribute('data-kind') !== card.kind;
    bet.shown = card;
    document.body.setAttribute('data-in-place', '');
    turnInPlace(b, function () { draw(card); if (painted) painted(); }, function () { bet.busy = false; document.body.removeAttribute('data-in-place'); measured(); if (card.watch) watchWait(); else stopWatch(); });
    // another page scrolled down: its top comes back on screen, as a spiral would bring it
    if (otherPlace && b.getBoundingClientRect().top < 0) window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
  }

  // a card with a table is drawn wider; on a screen wider than a plain card
  // the page would jump sideways under a turn
  function widthJumps(card) {
    var narrow = 34 * parseFloat(getComputedStyle(document.documentElement).fontSize);
    return window.innerWidth > narrow && Boolean(card.table) !== document.body.classList.contains('wide');
  }

  function turnInPlace(b, paint, after) {
    endOpening();
    if (reduced) {
      // under reduced motion the card fades out, changes, and fades back in,
      // and the footer steps aside while the card's height changes
      document.body.removeAttribute('data-in-place');
      b.style.minHeight = '';
      b.classList.remove('up');
      planned('turn', 400);
      setTimeout(function () { paint(); void b.offsetWidth; b.classList.add('up'); setTimeout(after, 200); }, 200);
      return;
    }
    var from = b.offsetHeight;
    b.style.height = from + 'px';
    b.style.minHeight = '';
    var ghost = b.cloneNode(true);
    ghost.removeAttribute('id');
    ghost.classList.remove('quick', 'acted', 'turning', 'turn-in');
    ghost.classList.add('up', 'ghost');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    var r = b.getBoundingClientRect(), p = b.offsetParent.getBoundingClientRect();
    ghost.style.top = (r.top - p.top) + 'px';
    ghost.style.left = (r.left - p.left) + 'px';
    ghost.style.width = r.width + 'px';
    b.after(ghost);
    b.classList.remove('quick', 'acted', 'turning');
    paint();
    b.style.height = 'auto';
    var to = b.offsetHeight;
    b.style.height = from + 'px';
    b.classList.add('turn-in');
    void b.offsetHeight;
    b.classList.add('turning');
    b.classList.remove('turn-in');
    b.style.height = to + 'px';
    ghost.classList.add('gone');
    var turnMs = 80 + TURN_IN_MS + 20;
    planned('turn', turnMs);
    setTimeout(function () {
      ghost.remove();
      b.classList.remove('turning');
      b.style.height = '';
      after();
    }, turnMs);
  }

  // While the calm line shows, look every WAIT_LOOK_MS: its live words are
  // kept fresh, even while the owner types, and once the Mac has the idea
  // ready it is asked for the way a tap does and grows out of the dots. It
  // waits while the owner types there (the box has the cursor or any words)
  // or a note is on its way, and on the big orb it waits for their tap.
  var WAIT_LOOK_MS = 1500;
  // One ask for the card at a time: a look while one is out shares its
  // answer, so asks never pile up while the Mac sleeps and land all at once.
  // An ask with no answer in ASK_WAIT_MS is called off and its slot freed,
  // so a Mac that wakes is asked fresh, never through a request lost to its sleep.
  var ASK_WAIT_MS = 4000;
  var asking = null, dropAsk = function () {};
  function askCard() {
    if (asking) return asking;
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var mine = null;
    var free = function () { clearTimeout(late); if (asking === mine) { asking = null; dropAsk = function () {}; } };
    var late = setTimeout(function () { free(); if (ctl) ctl.abort(); }, ASK_WAIT_MS);
    mine = asking = api('/card', null, ctl && ctl.signal).then(function (s) { free(); return s; }, function (e) { free(); throw e; });
    dropAsk = function () { free(); if (ctl) ctl.abort(); };
    return mine;
  }
  function typingOnCard() {
    var input = box().querySelector('.field input');
    return Boolean(input && (input === document.activeElement || input.value.trim()));
  }
  // A finger or the mouse is down on the page, or lifted a moment ago: a
  // card the Mac changed never swaps in under it, so a press always lands
  // on the card it began on. A finger that scrolls lets go (pointercancel).
  var pressed = { down: false, at: 0 }, PRESS_STILL_MS = 600;
  document.addEventListener('pointerdown', function () { pressed.down = true; }, true);
  ['pointerup', 'pointercancel'].forEach(function (type) { document.addEventListener(type, function () { pressed.down = false; pressed.at = performance.now(); }, true); });
  function pressing() { return pressed.down || performance.now() - pressed.at < PRESS_STILL_MS; }
  function stopWatch() { if (bet.watching) { clearInterval(bet.watching); bet.watching = null; } }
  function watchWait() {
    if (bet.watching) return;
    var quiet = function () { return !bet.busy && !bet.noting && document.body.classList.contains('has-card') && !typingOnCard() && !pressing(); };
    bet.watching = setInterval(function () {
      if (!bet.shown || !bet.shown.watch) { stopWatch(); return; }
      if (bet.busy || bet.noting || document.hidden) return;
      askCard().then(function (s) {
        if (s.http !== 200 || !s.card || !bet.shown || !bet.shown.watch || bet.busy || bet.noting) return;
        if (sameCard(s.card, bet.shown)) live(s.card);
        else if (quiet()) { bet.busy = true; arrive(s.card); return; }
        if (!quiet() || !(s.queue > 0) || bet.asking) return;
        bet.busy = true;
        // one ask at a time: a slow one frees the page, and the looks bring its card
        var ask = api('/act', { orb: true, card_id: bet.shown.id }).catch(offline);
        bet.asking = true;
        ask.then(function () { bet.asking = false; });
        patient(ask).then(function (r) {
          if (r.slow) { bet.busy = false; return; }
          if (r.ok && r.card && !sameCard(r.card, bet.shown)) { arrive(r.card); return; }
          bet.busy = false;
          if (r.ok && r.card) live(r.card);
        });
      }).catch(function () { /* the next look tries again */ });
    }, WAIT_LOOK_MS);
  }

  // ---- the orb ----------------------------------------------------------------------------
  // The big orb: the next card, with the spiral, as on page open. An idea
  // that landed behind the calm line is the next one, so it is never passed.
  function think() {
    if (bet.busy) return;
    // on the calm line the dots are the orb on the card: a tap goes back to the big one
    if (waiting()) { goHome(); return; }
    buzz();
    bet.busy = true;
    tapped();
    var failed = function () {
      bet.busy = false;
      orb.relax();
      line.set('that did not go through. tap to try again.', true);
    };
    var asked = api('/act', { orb: true, card_id: bet.shown ? bet.shown.id : null });
    waitLine(asked);
    patient(asked).then(function (r) {
      if (r.slow) { stillOn(asked, function (card) { if (isWait(card)) { enterWait(card); return; } orb.play(function (phase) { if (phase === 'settled') { bet.busy = false; showCard(card, true, true); } }, true); }); return; }
      if (r.http !== 200 || !r.card) { if (r.http === 200) { bet.busy = false; orb.relax(); line.set('tap to think', false); return; } failed(); return; }
      line.set('', false);
      // nothing ready yet: the calm line, with the sphere where it is and its dots moving
      if (isWait(r.card)) { enterWait(r.card); return; }
      // the big orb moves once the answer is in
      bet.waited = performance.now() - bet.tapAt;
      // the card fades up as the lava eases into its spot, or once it is there
      var up = false;
      var play = function () { orb.play(function (phase) { if (!up && (phase === 'landing' || phase === 'settled')) { up = true; showCard(r.card, true, true); } if (phase === 'settled') bet.busy = false; }, true); };
      if (fadeSphere()) setTimeout(play, 200); else play();
    }, failed);
  }

  // The small orb on a card goes back to the big dotted orb, from any card:
  // the card fades, the small orb glides down and the dots form again, idle
  // under the pointer. The card stays where it is on the Mac, so nothing is
  // passed until the big orb is tapped.
  function goHome() {
    if (bet.busy) return;
    buzz();
    bet.busy = true;
    stopWatch();
    // from the calm line the sphere is already there; its line comes once the card's words are gone
    if (waiting()) { leave(function () { line.set('tap to think', false); bet.busy = false; }); return; }
    // the line under the big orb is ready before the sphere is back
    line.set('tap to think', false);
    leave(function () { bet.busy = false; });
  }

  function tapSmallOrb() {
    if (document.body.classList.contains('has-card')) goHome(); else think();
  }

  // a press on the big orb that pushed its dots around (it moved more than
  // DRAG_PX before it lifted) is play, not a tap, so it thinks of nothing
  var pressAt = null, DRAG_PX = 10;
  document.getElementById('orb').addEventListener('pointerdown', function (e) { pressAt = { x: e.clientX, y: e.clientY }; });
  document.getElementById('orb').addEventListener('click', function (e) {
    if (pressAt && Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y) > DRAG_PX) e.stopImmediatePropagation();
    pressAt = null;
  }, true);

  var canvas = document.getElementById('orb');
  var lavaTap = document.getElementById('lava');
  [[canvas, think], [lavaTap, tapSmallOrb]].forEach(function (pair) {
    pair[0].addEventListener('click', pair[1]);
    pair[0].addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pair[1](); }
    });
  });

  // first look: a card already on screen shows settled, anything else is the sphere
  // the first card's fade in, ended the moment the card's own motion starts
  // (a quick flip or answer), so it never covers that motion's fades
  var openFades = [];
  function endOpening() { openFades.forEach(function (a) { a.cancel(); }); openFades = []; }

  // until it answers the page shows nothing; then the card and its small orb
  // fade in, or the big orb starts with its line, never one over the other.
  // The card the Mac served with the page opens it at once. Else the first
  // answer to come, from the one shared ask, opens the page; with none in
  // OPEN_WAIT_MS the big orb opens, so a look that stalls never leaves the
  // page blank. A page that opened without a good look takes the card from
  // the next good one (lateLook).
  var OPEN_WAIT_MS = 2500;
  var opened = false, openTimer = null, looked = false;
  function firstLook() {
    var held = null;
    try { held = JSON.parse(document.getElementById('first-look').textContent || 'null'); } catch (e) { held = null; }
    if (held && typeof held.needs_you === 'number') drawNeeds(held.needs_you);
    if (held) { openWith(Object.assign(held, { http: 200 })); return; }
    openTimer = setTimeout(function () { openWith(null); }, OPEN_WAIT_MS);
    askCard().then(openWith, function () { /* a refresh, or the wait, opens the page */ });
  }
  function openWith(s) {
    if (opened) return;
    opened = true;
    clearTimeout(openTimer);
    var open = function () { document.body.classList.remove('opening'); };
    var fadeIn = function (n) { if (n.animate) openFades.push(n.animate([{ opacity: 0 }, { opacity: 1 }], { duration: reduced ? 200 : 300, easing: 'ease-out' })); };
    if (!s || s.http !== 200) { orb.begin(); open(); return; }
    looked = true;
    if (s.card && isWait(s.card)) { enterWait(s.card, true); open(); return; }
    if (s.card) { line.clear(); orb.settled(); showCard(s.card, false); fadeIn(box()); fadeIn(document.getElementById('lava')); open(); return; }
    orb.begin();
    line.set(s.status === 'skipped' ? 'tap when you want another idea' : 'tap to think', false);
    open();
  }
  // the first good look, once the page opened on none: a card shows settled, anything else is the sphere's line
  function lateLook(s) {
    looked = true;
    if (s.card && isWait(s.card)) { enterWait(s.card, true); return; }
    if (s.card) { orb.settled(); showCard(s.card, false); return; }
    line.set(s.status === 'skipped' ? 'tap when you want another idea' : 'tap to think', false);
  }

  // ---- the footer: the team and the yeses waiting, both cards like any other ---------------
  // From any card, or the big orb: the Mac serves the team table or the job
  // deck as the next card, and its back option returns to where the owner was.
  // the team and the deck opened from the big orb close back to it; the card stays where it is on the Mac
  var teamFromHome = false;
  function openFrom(which) {
    if (bet.busy) return;
    // moving between the team pages keeps where the owner came from; opening them from anywhere else sets it
    var onTeam = document.body.classList.contains('has-card') && bet.shown && ['team', 'member', 'swap', 'deck'].indexOf(bet.shown.kind) >= 0;
    if (!onTeam) teamFromHome = !document.body.classList.contains('has-card');
    buzz();
    bet.busy = true;
    tapped();
    var answer = api('/act', { open: which, card_id: bet.shown ? bet.shown.id : null }).catch(offline);
    var late = answer;
    answer = patient(answer);
    // already on one of the team pages: the footer moves around them in place, as their way back does
    var from = bet.shown;
    if (document.body.classList.contains('has-card') && from && ['team', 'member', 'swap', 'deck'].indexOf(from.kind) >= 0) {
      whenLate(answer, late, from);
      document.body.setAttribute('data-in-place', '');
      answer.then(function (r) {
        if (r.ok && r.card && !widthJumps(r.card) && !isWait(r.card)) { turnTo(r.card); return; }
        document.body.removeAttribute('data-in-place');
        flow(Promise.resolve(r), from, null, null);
      });
      return;
    }
    if (!document.body.classList.contains('has-card')) {
      answer.then(function (r) {
        if (r.slow) { stillOn(late, function (card) { spiralTo(card, null); }); return; }
        if (!r.ok || !r.card) { bet.busy = false; line.set((r && r.message) || 'that did not go through. tap to try again.', true); return; }
        bet.waited = performance.now() - bet.tapAt;
        spiralTo(r.card, null);
      });
      return;
    }
    whenLate(answer, late, bet.shown);
    flow(answer, bet.shown, null, null);
  }
  document.getElementById('working').addEventListener('click', function () { openFrom('team'); });
  document.getElementById('needs').addEventListener('click', function () { openFrom('deck'); });

  // the option on the card that does this, if it has one
  function optionFor(action, step) {
    if (!bet.shown) return null;
    return bet.shown.options.filter(function (o) { return o.action === action && (step == null || (o.binds && o.binds.step === step)); })[0] || null;
  }
  function useOption(o) {
    var b = o && box().querySelector('[data-option="' + o.id + '"]');
    if (b && !bet.busy) b.click();
  }

  // Esc: words being typed are cancelled and the cursor leaves first; then
  // a card with a way back takes it. On a card with none it does nothing.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || e.isComposing || !bet.shown || !document.body.classList.contains('has-card')) return;
    var field = document.activeElement;
    if (field && field.tagName === 'INPUT') {
      e.preventDefault();
      field.value = '';
      field.blur();
      return;
    }
    var armedBtn = box().querySelector('.armed');
    if (armedBtn && armedBtn.disarm && armedBtn.disarm()) { e.preventDefault(); return; }
    var back = optionFor('back');
    if (back) { e.preventDefault(); useOption(back); }
  }, true);

  // Where the focus goes. A new card: when the focus left with the old card
  // (or sits on the orb), it goes to the new card's first action, never its
  // typing box, so a keyboard or a screen reader carries on from there. Back
  // on the big orb, a focus that was lost goes to the orb itself.
  function focusFree() {
    var a = document.activeElement;
    return !a || a === document.body || !a.isConnected || a.id === 'orb' || a.id === 'lava';
  }
  function landFocus() {
    if (!document.body.classList.contains('has-card') || !focusFree()) return;
    var first = box().querySelector('button:not([disabled]):not(.send)');
    if (first) first.focus({ preventScroll: true });
  }
  new MutationObserver(function () {
    var orbNode = document.getElementById('orb');
    if (document.body.classList.contains('has-card') || orbNode.style.visibility === 'hidden' || !focusFree() || document.activeElement === orbNode) return;
    orbNode.focus({ preventScroll: true });
  }).observe(document.getElementById('orb'), { attributes: true, attributeFilter: ['style'] });

  // The phone's back button (or swipe): a card keeps one step of the
  // browser's history. Back on a card with a way back takes it, as Esc does;
  // back on any other card goes to the big orb, as the small orb does; back
  // on the big orb leaves the page, as it always did. While a motion is
  // under way nothing moves and the step stays for the next press. Chrome
  // skips a step a page adds before the first tap, so it waits for one.
  function holdBack() {
    if (!document.body.classList.contains('has-card') || (history.state && history.state.orb)) return;
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
    history.pushState({ orb: 1 }, '');
  }
  new MutationObserver(function () { holdBack(); landFocus(); }).observe(box(), { attributes: true, attributeFilter: ['data-card'] });
  ['pointerdown', 'keydown'].forEach(function (type) { document.addEventListener(type, holdBack, true); });
  window.addEventListener('popstate', function () {
    if (history.state && history.state.orb) return;
    if (!document.body.classList.contains('has-card') || !bet.shown) { history.back(); return; }
    if (bet.busy || bet.noting) { holdBack(); return; }
    var field = document.activeElement;
    if (field && field.tagName === 'INPUT') { field.value = ''; field.blur(); holdBack(); return; }
    var back = optionFor('back');
    if (back) { holdBack(); useOption(back); return; }
    goHome();
  });

  // the arrows and a sideways swipe flip the job deck, unless the owner is typing
  document.addEventListener('keydown', function (e) {
    var step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    var field = document.activeElement;
    if (!step || e.isComposing || (field && field.tagName === 'INPUT')) return;
    var o = optionFor('flip', step);
    if (!o) return;
    e.preventDefault();
    useOption(o);
  });
  var swipe = null;
  // a drag inside the wide table scrolls it, and one in a box moves the cursor: neither flips
  function swipeFrom(e) {
    var t = e.composedPath()[0], grid = t.closest && t.closest('.grid');
    if ((grid && grid.scrollWidth > grid.clientWidth + 1) || (t.closest && t.closest('.field'))) return null;
    return { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }
  box().addEventListener('touchstart', function (e) { swipe = swipeFrom(e); }, { passive: true });
  box().addEventListener('touchend', function (e) {
    if (!swipe) return;
    var dx = e.changedTouches[0].clientX - swipe.x, dy = e.changedTouches[0].clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) useOption(optionFor('flip', dx < 0 ? 1 : -1));
  });

  // the footer: how many members are really working, or the team when none are
  function drawWorking(n) {
    var btn = document.getElementById('working');
    btn.textContent = n ? n + ' working' : 'the team';
  }

  // Every few seconds: the footer counts, and the card on screen. When the
  // Mac's card has changed (a new id: its options are not the ones shown),
  // it turns in place, or grows out of the dots on the calm line, unless the
  // owner is typing or a motion is under way.
  var deadLink = false;
  function refresh() {
    if (document.hidden) return Promise.resolve();
    return askCard().then(function (s) {
      // the first answer to come, from here or the first look, opens the page
      openWith(s);
      // only a refused link is a dead one; a Mac that errs or is starting again says nothing
      if (s.http !== 200 && s.http !== 403) { unanswered(); return; }
      answered();
      if (s.http === 403) deadLink = true;
      if (s.http !== 200) { line.set('this link stopped working. open a new one from the mac.', true); return; }
      drawWorking(s.team_working || 0);
      if (deadLink) { deadLink = false; if (!bet.busy && !document.body.classList.contains('has-card')) line.set('tap to think', false); }
      if (!looked && !bet.busy && !bet.shown && !document.body.classList.contains('has-card')) { lateLook(s); return; }
      if (pressing()) return;
      if (s.card && bet.shown && !sameCard(s.card, bet.shown) && !bet.busy && !bet.noting && !typingOnCard() && document.body.classList.contains('has-card')) {
        bet.busy = true;
        arrive(s.card);
      }
    }).catch(function () { unanswered(); /* the next refresh tries again */ });
  }

  // The Mac stopped answering (asleep, or its server quit): two looks in a
  // row that get nothing, about ten seconds, and one quiet line says so, in
  // the card when one is up, else under the big orb. While it is down the
  // page asks every DOWN_LOOK_MS instead of every LOOK_MS, and the first
  // good look takes the line away.
  var LOOK_MS = 5000, DOWN_LOOK_MS = 15000, QUIET = 'the mac is not answering. still trying.';
  var missed = 0;
  function quietNote() { return document.body.classList.contains('has-card') ? box().querySelector('.act .note') : null; }
  function unanswered() {
    missed += 1;
    if (missed !== 2) return;
    var note = quietNote();
    if (note) { if (!note.textContent) note.textContent = QUIET; }
    else if (!bet.busy) line.set(QUIET, true);
  }
  function answered() {
    if (missed < 2) { missed = 0; return; }
    missed = 0;
    var note = quietNote();
    if (note && note.textContent === QUIET) note.textContent = '';
    if (!document.body.classList.contains('has-card') && !bet.busy && document.getElementById('line').textContent === QUIET) line.set('tap to think', false);
  }
  function lookAgain() { setTimeout(function () { refresh().then(lookAgain, lookAgain); }, missed >= 2 ? DOWN_LOOK_MS : LOOK_MS); }
  // the phone was locked, the tab was away, or the wifi came back: a look
  // still waiting on the old link is called off and a fresh one goes at
  // once, so a tap never lands on a card the Mac has passed. In the
  // background the page does no work: the orb draws nothing and no look
  // goes to the Mac (refresh and the calm line's watch wait while hidden).
  var lookFresh = function () { dropAsk(); refresh(); };
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { orb.pause(); return; }
    orb.resume();
    lookFresh();
  });
  window.addEventListener('pageshow', function (e) { if (e.persisted) lookFresh(); });
  window.addEventListener('online', lookFresh);

  firstLook();
  refresh();
  lookAgain();
})();
</script>
</body>
</html>
`;
}

module.exports = { phonePage };
