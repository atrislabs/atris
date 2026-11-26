// Page rules about the look of the page: motion, glows, glass, gradients, fonts and texture.

const { cssRules, declsFor, visibleText, pseudoText, isHidden, classList, matchesSelector, compileSelector, splitTop, sheetFor, resolveVars } = require('../page-scan');
const { SAID, ICON_PX, DOT_PX, GLOW_PX, hasClassWord, kids, descendants, words, clip, ancestor, inside, lookDecls, stripJsComments, targets, pxValue, DYNAMIC_SEL, shadows, hardEdged, glowShadow, glowShadows, clearColour, fillOf, backdrop } = require('./shared');

// A minute of motion is about how long a reader stays on one screen; a repeat count that runs past it loops for them.
// Set by hand.
const LOOP_SECONDS = 60;

// What every rule here can see.
const SEEN = 'found in the page source, its style sheets and its scripts as written: an effect a script builds another way is not seen';

// --- the menu rule's reader ---------------------------------------------------------
// The rule says yes only on what the file says. It reads each rule the way the browser picks a winner
// (!important, then weight, then order) inside each state the file names. It never borrows a value from
// another element.

// The open and closed states of a menu, read through so a rule written for one state still names the menu:
// :popover-open, :open, the open and closed attributes of the common menu kits ([data-state], [data-open],
// [data-closed], [data-starting-style], [data-ending-style], [data-enter], [data-leave], [open], [hidden],
// [aria-expanded]) and the state class words (.open, .is-shown). Set by hand: a state written another way
// is not read. The rule's why says so.
const STATE_WORD = '(?:is-)?(?:on|open|active|visible|shown|show|in|seen|revealed)';
const OPEN_STATE = new RegExp(`:(?:popover-open|open)(?![\\w-])|\\[\\s*(?:data-state|data-open|data-closed|data-starting-style|data-ending-style|data-enter|data-leave|open|hidden|aria-expanded)\\s*(?:[~|^$*]?=\\s*(?:"[^"]*"|'[^']*'|[^\\]\\s]*)\\s*)?\\]|\\.${STATE_WORD}(?![\\w-])`, 'g');
const STATE_CLASS = new RegExp(`^${STATE_WORD}$`);
const NOT_STYLE = /^(?:keyframes|font-face|import|counter-style)$/;
// The weight of an inline style: above any selector.
const INLINE = 1e9;
// Where the last compound of a selector starts: the part that names the element the rule styles.
function subjectAt(sel) {
  let depth = 0, at = 0;
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (c === '\\') i++;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && (c === ' ' || c === '>' || c === '+' || c === '~')) at = i + 1;
  }
  return at;
}
// One comma part of a selector with its states taken out. keys are the states it names: ! marks one inside
// :not() and ^ marks one on a wrapper or sibling instead of the element itself. A compound left empty
// becomes *: `.open > .menu` reads as `* > .menu`. bare says the last compound was nothing but a state
// (.active, *.active, :is(.open)).
function readPart(sel) {
  const at = subjectAt(sel);
  const keys = [];
  const strip = (text, mark) => text
    .replace(/:not\(\s*((?:[^()]|\([^()]*\))*)\)/g, (all, inner) => { if (inner.replace(OPEN_STATE, '').trim() !== '') return all; keys.push(`${mark}!${inner.replace(/[\s"']/g, '')}`); return '\u0000'; })
    .replace(OPEN_STATE, (t) => { keys.push(mark + t.replace(/[\s"']/g, '')); return '\u0000'; });
  const tidy = (t) => t.replace(/(^|[\s>+~(,])\u0000+/g, '$1*').replace(/\u0000/g, '');
  const head = tidy(strip(sel.slice(0, at), '^'));
  const headDrops = keys.length;
  const subj = strip(sel.slice(at), '');
  const bare = keys.length > headDrops && tidy(subj).replace(/:(?:is|where|matches)\(\s*\*(?:\s*,\s*\*)*\s*\)/g, '').replace(/\*/g, '') === '';
  const uniq = [...new Set(keys)].sort();
  // a selector that ends on a combinator is broken: the browser drops it
  return { head, headDrops, written: sel.slice(at), base: head + tidy(subj), drops: keys.length, bare, broken: /[>+~]$/.test(sel), keys: uniq, id: uniq.join(' ') };
}
const PARTS = new WeakMap();
const partsOf = (rule) => { let p = PARTS.get(rule); if (!p) { p = splitTop(rule.selector, ',').map(({ text }) => readPart(text.trim())); PARTS.set(rule, p); } return p; };
// The weight a part lands on el with once its states are read through, or -1 when it does not land.
// A part that names only a state ([data-state=active], .nav .active) says nothing about which element it
// is for: it lands only on an element written in that state. :popover-open lands only on one with the
// popover attribute.
function lands(el, part) {
  if (part.broken) return -1;
  let sel = part.base, drops = part.drops;
  if (part.bare) {
    const left = 'popover' in el.attrs ? part.written.replace(/:popover-open(?![\w-])/g, '') : part.written;
    sel = part.head + (left || '*');
    drops = part.headDrops + (left === part.written ? 0 : 1);
  }
  const c = compileSelector(sel);
  return c && !c.pseudo && matchesSelector(el, c) ? c.spec + 100 * drops : -1;
}
// Prefixed spellings read as the plain property.
const plain = (prop) => prop.replace(/^-webkit-(?=transform|transition|animation)/, '');
// Every declaration written for el in any open or closed state, with what the browser needs to pick a
// winner: the states it is written for (keys), its weight, its place in the source, whether it is a
// first-frame style and the @media it sits in. The inline style outweighs every rule.
function writtenFor(el, page) {
  const out = [];
  sheetFor(page).rules.forEach((r, order) => {
    if (!r.decls.length || NOT_STYLE.test(r.at || '')) return;
    const hits = new Map();
    for (const part of partsOf(r)) { const spec = lands(el, part); if (spec >= 0 && !(hits.has(part.id) && hits.get(part.id).spec >= spec)) hits.set(part.id, { keys: part.keys, spec }); }
    if (!hits.size) return;
    const media = [].concat(r.media || []).map(String);
    for (const { keys, spec } of hits.values()) r.decls.forEach((d, i) => out.push({ ...d, prop: plain(d.prop), important: !!d.important, keys, spec, seq: order * 1e4 + i, starting: !!r.starting, media }));
  });
  if (el.attrs.style) (cssRules(`x{${el.attrs.style}}`, el.line)[0] || { decls: [] }).decls.forEach((d, i) => out.push({ ...d, prop: plain(d.prop), important: !!d.important, keys: [], spec: INLINE, seq: INLINE + i, starting: false, media: [] }));
  return out;
}
// Which of two declarations of one element the browser keeps.
const beats = (a, b) => (a.important !== b.important ? a.important : a.spec !== b.spec ? a.spec > b.spec : a.seq > b.seq);
// A custom property as el inherits it: from the nearest wrapper that sets it. On a page written without
// an <html> tag the plain :root rules stand in for it. No value is borrowed from elsewhere on the page.
function inheritedVar(el, page) {
  let root;
  return (name) => {
    let rooted = false;
    for (let a = el.parent; a && a.tag !== '#root'; a = a.parent) {
      if (a.tag === 'html') rooted = true;
      const d = declsFor(a, page).list.filter((x) => x.prop === name).pop();
      if (d) return /^initial$/i.test(d.value.trim()) ? undefined : d.value;
    }
    if (rooted) return undefined;
    if (!root) { root = {}; for (const r of sheetFor(page).rules) if (!r.media && !r.starting && !NOT_STYLE.test(r.at || '') && splitTop(r.selector, ',').some(({ text }) => /^(?::root|html)$/i.test(text.trim()))) for (const d of r.decls) if (d.prop.startsWith('--')) root[d.prop] = d.value; }
    return root[name];
  };
}
// The states the file names for el, each with the declarations that win in it. A state holds its own
// rules and every rule written for fewer states: the rules with no state at all apply in each one.
// fill puts in each var() as el sees it in that state.
function statesOf(el, page, decls) {
  const made = new Map();
  const add = (keys, starting, media) => { const id = `${keys.join(' ')}|${starting}|${media.join('|')}`; if (!made.has(id)) made.set(id, { keys, starting, media, state: `${keys.join(' ')}|${starting}` }); };
  add([], false, []);
  for (const d of decls) add(d.keys, d.starting, d.media);
  const up = inheritedVar(el, page);
  return [...made.values()].map((st) => {
    const map = {};
    for (const d of decls) {
      if ((d.starting && !st.starting) || !d.keys.every((k) => st.keys.includes(k)) || !d.media.every((m) => st.media.includes(m))) continue;
      if (!map[d.prop] || !beats(map[d.prop], d)) map[d.prop] = d;
    }
    const look = (name) => (map[name] ? (/^initial$/i.test(map[name].value.trim()) ? undefined : map[name].value) : up(name));
    return { ...st, map, fill: (v) => resolveVars(v, look) };
  });
}
// The longhand or the shorthand, whichever the browser keeps: animation-name against animation.
const kept = (map, a, b) => (!map[a] ? map[b] : !map[b] ? map[a] : beats(map[b], map[a]) ? map[b] : map[a]);
// A style that only holds on paper: nothing opens there.
const printOnly = (media) => media.some((q) => splitTop(q, ',').every(({ text }) => /\bprint\b/i.test(text) && !/\bscreen\b|\ball\b|^\s*not\b/i.test(text)));
// Two sets of @media that can hold together as far as the file says: one sits inside the other.
const together = (a, b) => a.every((m) => b.includes(m)) || b.every((m) => a.includes(m));
// Whether a rule could come to style el whatever state or place it is in: its last compound names el's
// tag. Each id or class in it is one el carries, a state word, or one nothing on the page carries yet
// (only a script can add that and it could add it to this element). Attribute tests and pseudo-classes
// are read through. A rule for a ::before or ::after is about another box.
function mayStyle(el, sel, carried) {
  const subj = sel.slice(subjectAt(sel));
  if (/(?<!\\)::|(?<![\\:]):(?:before|after|first-line|first-letter)(?![\w-])/.test(subj)) return false;
  const c = compileSelector(subj) || compileSelector(subj.replace(/(?<![\\:]):[\w-]+(?:\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))?/g, '') || '*');
  if (!c) return true;
  const { tag, id, classes } = c.parts[c.parts.length - 1].c;
  if (tag && tag !== '*' && tag !== el.tag) return false;
  if (id && id !== el.attrs.id && carried.ids.has(id)) return false;
  const own = new Set(classList(el));
  return classes.every((k) => own.has(k) || STATE_CLASS.test(k) || !carried.classes.has(k));
}
// The origin a tailwind origin class stands for: origin-top-right, origin-[10%_20%], data-[side=bottom]:origin-top.
const classOrigin = (cls) => { const m = /(?:^|:)!?origin-(.+)$/.exec(cls); return !m ? null : /^\[.*\]$/.test(m[1]) ? m[1].slice(1, -1).replace(/_/g, ' ') : /^\(/.test(m[1]) ? `var${m[1]}` : m[1].replace(/-/g, ' '); };
// The origin an arbitrary property class sets: [transform-origin:top_left].
const classProp = (cls) => { const m = /(?:^|:)\[(?:-webkit-)?transform-origin:(.+)\]$/.exec(cls); return m ? m[1].replace(/_/g, ' ') : null; };
// A scale that is not 1: scale(.95), scaleY(0), scale3d(), or the scale property, in numbers or percent.
const factor = (t) => { const m = /^(-?\d*\.?\d+)(%)?$/.exec(t); return m ? +m[1] / (m[2] ? 100 : 1) : null; };
const notOne = (list) => list.length > 0 && list.every((n) => n != null) && list.some((n) => n !== 1);
function scaled(prop, value) {
  const v = value.trim().toLowerCase();
  if (prop === 'scale') return notOne(v.split(/\s+/).filter(Boolean).map(factor));
  if (!/^(?:-webkit-)?transform$/.test(prop)) return false;
  return [...v.matchAll(/\bscale(?:3d|x|y)?\(([^()]*)\)/g)].some((m) => notOne(m[1].split(/[\s,]+/).filter(Boolean).map(factor)));
}
// A transition that moves a scale: one naming transform, scale or all, or one that names no property at all.
const EASING = /^(?:ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end|allow-discrete|normal)$/;
function movesScale(d) {
  const v = d.value.toLowerCase();
  if (/^(?:-webkit-)?transition-property$/.test(d.prop)) return /(?:^|[\s,])(?:all|transform|-webkit-transform|scale)(?=[\s,]|$)/.test(v);
  if (!/^(?:-webkit-)?transition$/.test(d.prop)) return false;
  return splitTop(v, ',').some(({ text }) => {
    const names = text.replace(/[\w-]+\([^()]*\)/g, ' ').trim().split(/\s+/).filter((x) => x && !/^-?\d*\.?\d+m?s$/.test(x) && !EASING.test(x));
    return names.length ? names.some((x) => /^(?:all|transform|-webkit-transform|scale)$/.test(x)) : !!text.trim();
  });
}
// An origin at the middle: center or 50% on both axes, or a keyword that puts the default back.
const centred = (v) => { const t = v.trim().toLowerCase().split(/\s+/); return /^(?:initial|unset|revert|revert-layer)$/.test(t[0]) || (t.length <= 3 && t.slice(0, 2).every((x) => x === 'center' || x === '50%') && (t.length < 3 || /^0(?:px)?$/.test(t[2]))); };

module.exports = [
  {
    id: 'page-looping-motion', group: 'look',
    line: 'Nothing on the page loops forever.',
    why: `an animation that never stops pulls the eye from the words: infinite, a repeat count that keeps it moving for a minute or more, an svg animation that repeats or restarts itself, a marquee, or a script that keeps changing a style on a timer or every frame. ${SEEN}`,
    fix: 'remove the loop, or run the motion once',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      const seconds = (t) => { const x = /^(\d*\.?\d+)(ms|s)$/i.exec(t || ''); return x ? (+x[1] / (x[2].toLowerCase() === 'ms' ? 1000 : 1)) : null; };
      const forever = (d) => splitTop(d.value, ',').some(({ text }) => {
        const toks = text.trim().toLowerCase().split(/\s+(?![^(]*\))/);
        if (toks.some((tok) => tok === 'infinite' || /^calc\(\s*infinity\s*\)$/.test(tok))) return true;
        const count = toks.find((tok) => /^\d*\.?\d+(?:e\+?\d+)?$/.test(tok));
        if (!count) return false;
        const own = toks.map(seconds).find((x) => x != null);
        // a count set alone runs for the duration the element gets from any rule
        const ruleDur = d.rule && d.rule.decls.find((x) => /animation-duration$/.test(x.prop));
        const cascadeDur = () => Math.max(0, ...targets(d, page).map((el) => { const m = declsFor(el, page).map; return seconds((m['animation-duration'] || { value: '' }).value.trim()) || 0; }));
        const dur = d.prop.endsWith('iteration-count') ? seconds(ruleDur && ruleDur.value.trim()) || cascadeDur() : own;
        return +count * (dur || 1) >= LOOP_SECONDS;
      });
      for (const d of lookDecls(page)) {
        if (/^(?:-\w+-)?animation(?:-iteration-count)?$/.test(d.prop) && forever(d)) { hit(d.line, `${d.prop}: ${d.value}`); return; }
      }
      const begins = new Map(page.all.filter((el) => el.attrs.id && el.attrs.begin).map((el) => [el.attrs.id, el.attrs.begin]));
      for (const el of page.all) {
        if (el.tag === 'marquee' && !/^\d+$/.test(el.attrs.loop || '')) { hit(el.line, '<marquee>'); return; }
        // a video that plays itself on a loop, or a lottie player set to loop and play
        if ((el.tag === 'video' && 'loop' in el.attrs && 'autoplay' in el.attrs) || (/lottie-player$/.test(el.tag) && 'loop' in el.attrs && 'autoplay' in el.attrs)) { hit(el.line, `<${el.tag} autoplay loop>`); return; }
        if (!/^(?:animate(?:transform|motion|color)?|set)$/.test(el.tag)) continue;
        const runs = parseFloat(el.attrs.repeatcount) * (seconds(el.attrs.dur) || 1);
        if (/indefinite/i.test(el.attrs.repeatcount || '') || /indefinite/i.test(el.attrs.repeatdur || '') || runs >= LOOP_SECONDS || (seconds(el.attrs.repeatdur) || 0) >= LOOP_SECONDS) { hit(el.line, `<${el.tag} repeatCount="${el.attrs.repeatcount || el.attrs.repeatdur}">`); return; }
        // two animations that start each other when they end
        const refs = [...(el.attrs.begin || '').matchAll(/([\w-]+)\.end\b/g)].map((m) => m[1]);
        if (refs.some((r) => r === el.attrs.id || (el.attrs.id && new RegExp(`\\b${el.attrs.id}\\.end\\b`).test(begins.get(r) || '')))) { hit(el.line, `<${el.tag} begin="${el.attrs.begin}">`); return; }
      }
      for (const sc of page.scripts) {
        const code = stripJsComments(sc.text);
        const at = (i) => sc.line + (code.slice(0, i).match(/\n/g) || []).length;
        let m = /iterations\s*[:=]\s*(?:Infinity|Number\.(?:POSITIVE_INFINITY|MAX_VALUE|MAX_SAFE_INTEGER)|\d*\.?\d+\s*\/\s*0(?![.\d])|\d*\.?\d+e\+?\d+)|\brepeat\s*:\s*-1\b|\byoyo\s*:\s*true[^}]*repeat\s*:\s*-1/.exec(code);
        if (m) { hit(at(m.index), m[0]); return; }
        // a lottie animation loops unless told not to
        m = /\bloadAnimation\s*\(\s*\{[^}]*\}/.exec(code);
        if (m && !/\bloop\s*:\s*(?:false|\d)/.test(m[0]) && !/\bautoplay\s*:\s*false/.test(m[0])) { hit(at(m.index), 'lottie loadAnimation that loops'); return; }
        // a class toggled each time a transition or animation ends starts the next one: a ping-pong loop
        m = /(?:addEventListener\(\s*["'`](?:transitionend|animationend|animationiteration)["'`]|\bon(?:transitionend|animationend)\s*=)[^;]{0,200}?(?:classList\.toggle|\.style\.)/.exec(code);
        if (m) { hit(at(m.index), 'a transition that restarts itself when it ends'); return; }
        // a timer or a frame loop that keeps changing how something looks
        const styles = /classList|className|\.style\b|\.animate\(|setAttribute\(\s*["'](?:class|style)/;
        const fns = [...code.matchAll(/function\s+([\w$]+)\s*\([^)]*\)\s*\{|(?:const|let|var)\s+([\w$]+)\s*=\s*(?:(?:\([^)]*\)|[\w$]+)\s*=>\s*\{?|function\b[^(]*\([^)]*\)\s*\{)/g)].map((f) => ({ name: f[1] || f[2], at: f.index, body: code.slice(f.index, f.index + 2000) }));
        for (const iv of code.matchAll(/setInterval\(\s*([\w$]+)?/g)) {
          const fn = iv[1] && fns.find((f) => f.name === iv[1]);
          const body = fn ? fn.body.slice(0, 600) : code.slice(iv.index, iv.index + 400);
          // a timer that clears itself (a countdown that stops at zero) ends
          if (styles.test(body) && !/clearInterval\(/.test(body)) { hit(at(iv.index), 'setInterval that changes a style'); return; }
        }
        for (const f of fns) {
          const esc = f.name.replace(/\$/g, '\\$');
          // a frame loop that asks for the next frame only while some progress is below its end (if (p < 1)) is a one-off move
          const call = new RegExp(`(if\\s*\\(([^()]|\\([^()]*\\))*\\)\\s*)?requestAnimationFrame\\(\\s*${esc}\\s*\\)`).exec(f.body);
          if (call && !(call[1] && /[<>]/.test(call[1]))) { hit(at(f.at), `requestAnimationFrame(${f.name}) loop`); return; }
          if (new RegExp(`setTimeout\\(\\s*${esc}\\b`).test(f.body) && styles.test(f.body.slice(0, 600))) { hit(at(f.at), `setTimeout(${f.name}) loop`); return; }
        }
      }
    },
  },

  {
    id: 'page-scroll-fade', group: 'look',
    line: 'Sections do not fade or slide in on scroll.',
    why: `content that appears on scroll hides the words until the reader moves: a scroll trigger (an observer, a scroll handler, a scroll timeline or a reveal library) together with content that starts hidden or is faded in by the script. ${SEEN}`,
    fix: 'show the content from the start',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      const look = lookDecls(page);
      const lineAt = (sc, code, i) => sc.line + (code.slice(0, i).match(/\n/g) || []).length;
      // content that starts hidden: opacity 0, hidden, clipped away or faded by a filter, on something with words in it
      const hides = (d) => (d.prop === 'opacity' && /^0(?:\.0+)?$/.test(d.value.trim())) || (d.prop === 'visibility' && /^hidden$/.test(d.value.trim())) ||
        (d.prop === 'clip-path' && /inset\([^)]*100%|circle\(\s*0/.test(d.value)) || (d.prop === 'filter' && /opacity\(\s*0(?:\.0+)?%?\s*\)/.test(d.value));
      const startsHidden = look.some((d) => !d.script && d.selector !== null && d.at !== 'keyframes' && !DYNAMIC_SEL.test(d.selector || '') && hides(d) &&
        targets(d, page).some((el) => visibleText(el, page) || el.tag === 'section'));
      for (const sc of page.scripts) {
        const code = stripJsComments(sc.text);
        // a reveal library: the whole point of these calls is content appearing on scroll
        const lib = /\bScrollReveal\s*\(|\bnew\s+WOW\b|\bAOS\.init\b|\bsal\s*\(|\bScrollTrigger\b|\bscrollReveal\b/.exec(code);
        if (lib) { hit(lineAt(sc, code, lib.index), lib[0]); return; }
        const trigger = /IntersectionObserver|addEventListener\(\s*['"`]scroll['"`]|\bonscroll\s*=|\bwhileInView\b|\buseInView\b/.exec(code);
        if (!trigger) continue;
        // the script fades or slides something: a style it sets, a visibility it turns on, or an animation it runs
        // a custom property the script sets that a style uses for opacity or a move (opacity: var(--o, 0))
        const fadeVars = look.filter((d) => /^(?:opacity|transform|translate|filter|clip-path)$/.test(d.prop) && d.raw).flatMap((d) => [...d.raw.matchAll(/var\(\s*(--[\w-]+)/g)].map((x) => x[1]));
        const setsVar = [...code.matchAll(/setProperty\(\s*["'`](--[\w-]+)["'`]/g)].some((x) => fadeVars.includes(x[1]));
        const fades = (/\.style\.(?:opacity|transform)\s*=\s*[^;]*(?:opacity|translate|['"`]?[01](?:\.\d+)?['"`]?)|opacity\s*:\s*[01]\b|whileInView|\.style\.visibility\s*=|setProperty\(\s*["'](?:opacity|transform|translate|visibility)["']|\.animate\(\s*[[{][^\]}]*(?:opacity|translate|transform)/.test(code) || setsVar) && !/scale[XY]?\(/.test(code.slice(trigger.index));
        // a class or data attribute the script adds that a style rule turns visible: the reveal state of hidden content
        const added = [...code.matchAll(/classList\.(?:add|toggle|replace)\(\s*(["'`])([\w-]+)\1|className\s*\+?=\s*(["'`])\s*([\w-]+)/g)].map((m) => `\\.${m[2] || m[4]}(?![\\w-])`);
        const attrs = [...code.matchAll(/dataset\.([\w$]+)\s*=(?!=)|(?:setAttribute|toggleAttribute)\(\s*["'](data-[\w-]+)["']/g)].map((m) => `\\[${m[2] || `data-${m[1].replace(/[A-Z]/g, (x) => `-${x.toLowerCase()}`)}`}(?![\\w-])`);
        // a style that shows what was hidden: opacity above 0, no move, an open clip, no filter
        const shows = (d) => (d.prop === 'opacity' && !/^0(?:\.0+)?$/.test(d.value.trim())) || (/^(?:transform|translate|filter)$/.test(d.prop) && /none|^0(?:px)?(?:\s+0(?:px)?)*$/.test(d.value.trim())) || (d.prop === 'clip-path' && !/100%|circle\(\s*0/.test(d.value)) || (d.prop === 'visibility' && /visible/.test(d.value));
        const changes = [...added, ...attrs].some((sel) => look.some((d) => d.selector && new RegExp(sel).test(d.selector) && shows(d)));
        // or a class the script takes off whose rule hid the content (a .hidden class removed)
        const removed = [...code.matchAll(/classList\.remove\(\s*(["'`])([\w-]+)\1/g)].some((m) => look.some((d) => d.selector && new RegExp(`\\.${m[2]}(?![\\w-])`).test(d.selector) && hides(d)));
        // the observed element itself is styled by the script (a style write, an animation, or a class named
        // for being shown, like on, visible or in-view): the reveal pattern. other classes and data attributes
        // count only when a style rule reveals with them. loading an image from data-src, marking it
        // loaded, or marking a section read is not a fade
        const observed = /IntersectionObserver/.test(trigger[0]);
        const onTarget = observed && /\.target\s*\.\s*(?:style\b|animate\(|(?:classList\.(?:add|toggle|replace)\(\s*|className\s*\+?=\s*)["'`]\s*(?:is-)?(?:on|open|active|visible|shown|show|in|seen|revealed|in-?view|animated?|appear(?:ed)?|fade-?in)["'`\s])/.test(code);
        // a style a scroll handler sets counts only on content: content that starts hidden, or blocks of words
        // the script picks out by selector (a back-to-top link is not content)
        const picked = [...code.matchAll(/querySelector(?:All)?\(\s*(["'`])([^"'`]+)\1/g)].some((x) => { const c = compileSelector(x[2]); return c && page.all.some((el) => matchesSelector(el, c) && !['a', 'button'].includes(el.tag) && (el.tag === 'section' || words(visibleText(el, page)).length >= 3)); });
        if ((fades && (observed || startsHidden || picked)) || onTarget || ((changes || removed) && (observed || startsHidden))) { hit(lineAt(sc, code, trigger.index), trigger[0]); return; }
      }
      const attrTrigger = page.all.find((el) => el.attrs.onscroll);
      if (attrTrigger && startsHidden) { hit(attrTrigger.line, `onscroll="${attrTrigger.attrs.onscroll.slice(0, 40)}"`); return; }
      for (const el of page.all) {
        const a = Object.keys(el.attrs).find((k) => /^data-(?:aos|sal|animate-on-scroll|scroll-reveal|sr)$/.test(k));
        if (a) { hit(el.line, a); return; }
      }
      // a scroll-driven timeline on something with words in it; a progress bar has none
      const named = new Set(look.filter((d) => /^(?:view|scroll)-timeline(?:-name)?$/.test(d.prop)).map((d) => d.value.trim().split(/\s+/)[0]));
      for (const d of look) {
        if (!/animation-timeline/.test(d.prop)) continue;
        const v = d.value.trim();
        if (!/\b(?:view|scroll)\(/.test(v) && !named.has(v)) continue;
        const els = targets(d, page);
        if (els.length && els.every((el) => !visibleText(el, page))) continue;
        hit(d.line, `${d.prop}: ${d.value}`);
        return;
      }
      const hasClick = page.scripts.some((sc) => /addEventListener\(\s*['"]click['"]|onclick/.test(sc.text)) || page.all.some((el) => el.attrs.onclick);
      for (const d of look) {
        if (d.prop === 'opacity' && /^0(?:\.0+)?$/.test(d.value) && d.selector && !hasClick && /\.(?:[\w-]*-)?(?:reveal|fade-?in|fade-?up|fade-?in-?up|slide-?in|slide-?up|in-?view|inview|aos|on-?scroll|scroll-?in|appear-?on-?scroll|wow)(?:-[\w-]*)?(?![\w-])|\[data-(?:animate|reveal|aos)/i.test(d.selector)) {
          hit(d.line, `${d.selector} { opacity: 0 }`);
          return;
        }
      }
    },
  },

  {
    id: 'page-glow', group: 'look',
    line: 'No blurred blobs or glows behind content.',
    why: `a glow or blurred blob behind content: a blur filter on something that is not a picture or a small blur over words (any picture blurred 30px or more is a blob), a soft radial-gradient wash, a soft coloured halo, or an svg blur or radial blob. a small dot pattern, a hard-edged circle (a donut chart, a radio dot) and a soft grey drop shadow are fine. ${SEEN}`,
    fix: 'remove it and let the plain background show',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      // a picture blurred a little is a photo; a blur of GLOW_PX or more turns any picture into a soft blob
      const contentImage = (el, radius) => ['img', 'video', 'picture', 'canvas'].includes(el.tag) && radius < GLOW_PX;
      // currentColor in a shadow is the colour the element is set in
      const colourOf = (el) => { for (let a = el; a && a.tag !== '#root'; a = a.parent) { const c = declsFor(a, page).map.color; if (c) return c.value.trim(); } return 'black'; };
      for (const d of lookDecls(page)) {
        let v = d.value;
        if (/^(?:box|text)-shadow$/.test(d.prop) && /currentcolor/i.test(v)) {
          const own = d.rule && d.rule.decls.find((x) => x.prop === 'color');
          const els = targets(d, page);
          const c = own ? own.value.trim() : els.length ? colourOf(els[0]) : null;
          if (c) v = v.replace(/currentcolor/ig, c);
        }
        if (/^(?:-webkit-)?filter$/.test(d.prop)) {
          const b = /blur\(\s*(calc\([^)]*\)|[\d.]+)(px|rem|em)?/i.exec(v);
          const radius = b ? (/^calc/i.test(b[1]) ? 99 : pxValue(`${b[1]}${b[2] || 'px'}`)) : 0;
          if (radius > 0) {
            const els = targets(d, page);
            // a content image, or a small blur over words (a spoiler), is not a glow
            const benign = els.length && els.every((el) => contentImage(el, radius) || (radius < GLOW_PX && visibleText(el, page)));
            const imgSel = radius < GLOW_PX && !els.length && !d.el && /(?:^|[\s>+~])(?:img|video|picture|canvas)(?:[.#:\[]|$)/i.test((d.selector || '').split(',').pop());
            if (!benign && !imgSel) { hit(d.line, `${d.prop}: ${v}`); return; }
          }
          const ds = [...v.matchAll(/drop-shadow\(((?:[^()]|\([^()]*\))*)\)/gi)].map((x) => shadows(x[1])[0]).filter(Boolean);
          if (ds.length && glowShadows(ds)) { hit(d.line, `${d.prop}: ${v}`); return; }
          const u = /url\(\s*#([\w-]+)\s*\)/.exec(v);
          if (u && page.all.some((el) => el.attrs.id === u[1] && descendants(el).some((x) => x.tag === 'fegaussianblur' && parseFloat(x.attrs.stddeviation) >= GLOW_PX / 2))) { hit(d.line, `${d.prop}: ${v}`); return; }
          // an svg filter written inside a data url
          const inline = v.search(/data:image\/svg\+xml/i);
          const std = inline >= 0 && /feGaussianBlur[^>]*stdDeviation\s*=\s*\\?["']?([\d.]+)/i.exec(decodeURIComponent(v.slice(inline).replace(/%(?![0-9a-f]{2})/gi, '%25')));
          if (std && +std[1] > 0 && !targets(d, page).every((el) => contentImage(el, 2 * +std[1]))) { hit(d.line, `${d.prop}: a blur filter in a data url`); return; }
        }
        if (/^(?:background(?:-image)?|(?:-webkit-)?mask(?:-image)?)$/.test(d.prop) && /radial-gradient\(/i.test(v)) {
          // a repeating dot pattern: small tiles or a gradient of a few pixels
          const size = /\/\s*(\d+)px/.exec(v) || /(\d+)px/.exec((d.rule ? (d.rule.decls.find((x) => x.prop === 'background-size') || {}).value : '') || '');
          const tiny = /radial-gradient\([^)]*?\b[0-4](?:\.\d+)?px\b/i.test(v) && !/\b(?:[5-9]|\d{2,})%/.test(v.replace(/\d+px/g, ''));
          if (!(size && +size[1] <= ICON_PX) && !tiny && !hardEdged(v)) { hit(d.line, `${d.prop}: ${v}`); return; }
        }
        if (/^(?:box|text)-shadow$/.test(d.prop) && glowShadows(shadows(v))) { hit(d.line, `${d.prop}: ${v}`); return; }
      }
      // an svg blob filled with a radial gradient that fades out
      for (const el of page.all) {
        if (el.tag !== 'radialgradient' || !descendants(el).some((st) => st.tag === 'stop' && (/^0(?:\.0*)?$/.test(st.attrs['stop-opacity'] || '') || /transparent/.test(st.attrs['stop-color'] || '') || clearColour(st.attrs['stop-color'] || '')))) continue;
        const id = el.attrs.id;
        const user = id && page.all.find((x) => ['circle', 'ellipse', 'rect', 'path', 'use'].includes(x.tag) && (x.attrs.fill || '').includes(`#${id}`));
        if (user) { hit(user.line, `<${user.tag} fill="${user.attrs.fill}">`); return; }
      }
      // svg filters: a wide blur anywhere; any blur, as in css, on a shape that uses it (a blur next to an
      // offset is a drop shadow); a coloured drop shadow centred on its shape (its stdDeviation is half a css blur)
      const usedOnShape = (id) => id && page.all.some((x) => ['circle', 'ellipse', 'rect', 'path', 'polygon', 'g', 'image', 'use'].includes(x.tag) && new RegExp(`url\\(\\s*["']?#${id}["']?\\s*\\)`).test(x.attrs.filter || (declsFor(x, page).map.filter || { value: '' }).value));
      for (const el of page.all) {
        const filter = ancestor(el, (a) => a.tag === 'filter');
        const std = parseFloat(el.attrs.stddeviation);
        if (el.tag === 'fegaussianblur' && (std >= GLOW_PX / 2 || (std > 0 && filter && usedOnShape(filter.attrs.id) && !descendants(filter).some((x) => x.tag === 'feoffset')))) { hit(el.line, `<feGaussianBlur stdDeviation="${el.attrs.stddeviation}">`); return; }
        if (el.tag === 'fedropshadow' && std > 0 && glowShadow({ x: parseFloat(el.attrs.dx) || 0, y: parseFloat(el.attrs.dy) || 0, blur: 2 * std, spread: 0, colour: el.attrs['flood-color'] || 'black' })) { hit(el.line, `<feDropShadow stdDeviation="${el.attrs.stddeviation}">`); return; }
      }
    },
  },

  {
    id: 'page-glass', group: 'look',
    line: 'No frosted glass effects.',
    why: `a blurred see-through panel. ${SEEN}`,
    fix: 'use a solid background',
    said: SAID.never,
    check(ctx, hit) {
      for (const d of lookDecls(ctx.page)) {
        if (!/^(?:-webkit-)?backdrop-filter$/.test(d.prop)) continue;
        const b = /blur\(\s*(calc\([^)]*\)|[\d.]+)/i.exec(d.value);
        if (b && (/^calc/i.test(b[1]) || parseFloat(b[1]) > 0)) { hit(d.line, `${d.prop}: ${d.value}`); return; }
      }
    },
  },

  {
    id: 'page-gradient-text', group: 'look',
    line: 'No gradient-filled text.',
    why: `gradient text: a background clipped to the text, an svg or canvas text filled with a gradient, a copy of the words laid over them under a gradient mask, or text blended over a gradient. ${SEEN}`,
    fix: 'set the text in one solid colour',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      for (const d of lookDecls(page)) {
        if (/^(?:-webkit-)?background-clip$/.test(d.prop) && /\btext\b/i.test(d.value)) { hit(d.line, `${d.prop}: ${d.value}`); return; }
        // the clip keyword written inside the background shorthand
        if (/^(?:-webkit-)?background$/.test(d.prop) && /gradient\(/i.test(d.value) && splitTop(d.value, ',').some(({ text }) => /(?:^|\s)text(?:\s|$)/i.test(text.replace(/\([^()]*(?:\([^()]*\))*[^()]*\)/g, '')))) { hit(d.line, `${d.prop}: ${d.value}`); return; }
        if (d.prop === 'fill' && /url\(\s*["']?#/i.test(d.value) && targets(d, page).some((el) => ['text', 'tspan', 'textpath'].includes(el.tag))) { hit(d.line, `${d.prop}: ${d.value}`); return; }
      }
      for (const el of page.all) {
        if (!['text', 'tspan', 'textpath'].includes(el.tag)) continue;
        for (let a = el; a && a.tag !== 'svg' && a.tag !== '#root'; a = a.parent) {
          const f = a.attrs.fill || (declsFor(a, page).map.fill || { value: '' }).value;
          if (/url\(\s*["']?#/.test(f)) { hit(el.line, `<${el.tag}> filled with ${f}`); return; }
          if (a.attrs.fill || declsFor(a, page).map.fill) break;
        }
      }
      // a copy of the words laid over them by a ::before or ::after in another colour, faded in by a gradient
      // mask, makes the headline read as a gradient
      for (const el of page.all) {
        const own = visibleText(el, page);
        for (const w of ['before', 'after']) {
          const pm = declsFor(el, page).pseudo[w];
          const t = pseudoText(el, page, w).trim();
          const mask = (pm['mask-image'] || pm['-webkit-mask-image'] || pm.mask || pm['-webkit-mask'] || { value: '' }).value;
          if (t && own.replace(t, '').trim() === t && /absolute/.test((pm.position || { value: '' }).value) && /gradient\(/.test(mask)) { hit((pm['mask-image'] || pm['-webkit-mask-image'] || pm.mask || pm['-webkit-mask']).line, `${w} copy of "${clip(t)}" under a gradient mask`); return; }
        }
      }
      // text drawn on a canvas with a gradient fill
      for (const sc of page.scripts) {
        const code = stripJsComments(sc.text);
        const grads = [...code.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*[\w$.]*create(?:Linear|Radial|Conic)Gradient\(/g)].map((x) => x[1]);
        const m = grads.length && /\b(?:fill|stroke)Text\(/.test(code) && new RegExp(`(?:fill|stroke)Style\\s*=\\s*(?:${grads.map((g) => g.replace(/\$/g, '\\$')).join('|')})\\b`).exec(code);
        if (m) { hit(sc.line + (code.slice(0, m.index).match(/\n/g) || []).length, 'text drawn on a canvas with a gradient fill'); return; }
      }
      // light text blended over a gradient shows the gradient through the letters
      for (const el of page.all) {
        const m = declsFor(el, page).map;
        if (!m['mix-blend-mode'] || !/lighten|screen|multiply|darken|difference|exclusion/.test(m['mix-blend-mode'].value) || !visibleText(el, page)) continue;
        if (ancestor(el, (a) => /gradient\(/i.test(fillOf(declsFor(a, page).map)))) { hit(m['mix-blend-mode'].line, `mix-blend-mode: ${m['mix-blend-mode'].value} over a gradient`); return; }
      }
    },
  },

  {
    id: 'page-banned-font', group: 'look',
    line: 'Never use Instrument Serif, Playfair Display, Inter or Roboto.',
    why: `a banned font, named in css, an svg or font attribute, a font file, a font link or a script that loads fonts. a font renamed through a link that hides its name cannot be seen. ${SEEN}`,
    fix: 'use a font from the design library',
    said: SAID.fonts,
    check(ctx, hit) {
      const { page } = ctx;
      // inter-word and inter-character are text-justify keywords, not the font
      const FONT = /instrument[\s+_-]*serif|playfair(?:[\s+_-]*display)?|\binter(?!-(?:word|character|ideograph|cluster)\b)(?=$|[^a-z]|variable|display|tight)|roboto/i;
      const CAMEL = /\bInter(?=[A-Z])|InstrumentSerif|PlayfairDisplay|Roboto/;
      // css escapes read as the browser reads them: Int\65 r is Inter, R\oboto is Roboto
      const unescape = (s) => s.replace(/\\([0-9a-f]{1,6})\s?/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } }).replace(/\\(.)/g, '$1');
      // var() names and image urls are not font names
      const strip = (s) => unescape(s).replace(/\binterstate\b/ig, '').replace(/var\(\s*--[\w-]+/g, 'var(').replace(/url\(\s*(["']?)(?![^)]*\.(?:woff2?|ttf|otf|eot)\b)[^)]*\)/gi, 'url()');
      const named = (v) => FONT.test(strip(v)) || CAMEL.test(strip(v));
      // a stylesheet address names its fonts in the url itself
      const namedUrl = (v) => FONT.test(unescape(v).replace(/\binterstate\b/ig, '')) || CAMEL.test(v);
      const decode = (u) => { try { return decodeURIComponent(u.replace(/%(?![0-9a-f]{2})/gi, '%25')).replace(/\+/g, ' '); } catch { return u; } };
      for (const d of lookDecls(page)) {
        if (!(/^font(?:-family)?$/.test(d.prop) || d.prop === 'src' || d.prop.startsWith('--'))) continue;
        if (named(d.value)) { hit(d.line, `${d.prop}: ${d.value}`); return; }
      }
      for (const s of page.styles) {
        // an @import after any other rule is ignored by the browser
        const rules = cssRules(s.text, s.line);
        const first = rules.findIndex((r) => r.at !== 'import');
        for (const r of first < 0 ? rules : rules.slice(0, first)) if (namedUrl(decode(r.selector))) { hit(r.line, r.selector); return; }
      }
      for (const el of page.all) {
        const href = el.tag === 'link' ? el.attrs.href || '' : '';
        if (href && /stylesheet|preload|font/i.test(el.attrs.rel || '') && named(decode(href.replace(/^[a-z]+:\/\/[^/]+/i, '')))) { hit(el.line, href); return; }
        const attr = el.attrs['font-family'] || (el.tag === 'font' ? el.attrs.face : '');
        if (attr && named(attr)) { hit(el.line, attr); return; }
      }
      for (const sc of page.scripts) {
        // a name kept in a string constant is read where the constant is used: const face = 'Roboto'
        const consts = new Map([...stripJsComments(sc.text).matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*(["'`])([^"'`\n]*)\2/g)].map((x) => [x[1], x[3]]));
        const code = stripJsComments(sc.text).replace(/(["'`])\s*\+\s*([\w$]+)\b|\b([\w$]+)\s*\+\s*(["'`])|=\s*([\w$]+)\s*;/g, (all, q1, a, b, q2, c) => { const k = a || b || c; return consts.has(k) ? all.replace(k, `'${consts.get(k)}'`) : all; });
        const m = /(?:families\s*:|fontFamily\s*[:=]|font-family\s*:|new\s+FontFace\s*\(|fonts\.(?:googleapis|bunny)|fontsource|\.woff2?\b)[^\n]{0,200}/i.exec(code);
        if (m && named(decode(m[0]))) { hit(sc.line + (code.slice(0, m.index).match(/\n/g) || []).length, m[0]); return; }
        // a font list may run over several lines (a tailwind config): read on to the end of its block
        for (const f of code.matchAll(/(?:fontFamily\s*[:=]|new\s+FontFace\s*\()\s*(?:\{(?:[^{}]|\{[^{}]*\})*\}|\[[^\]]*\]|[^\n]{0,200})/gi)) if (named(decode(f[0]))) { hit(sc.line + (code.slice(0, f.index).match(/\n/g) || []).length, f[0]); return; }
      }
    },
  },

  {
    id: 'page-noise', group: 'look',
    line: 'No dithering or grain texture.',
    why: `a noise or grain texture over the page: feTurbulence (also inside a data url or a script), random pixels drawn on a canvas, a tiny checker pattern, pixelated scaling of a decorative layer, or a noise, grain or dither image or empty layer. a texture baked into an encoded png cannot be seen. ${SEEN}`,
    fix: 'remove the texture',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      // svg inside a data url, decoded so its filter can be read
      const unpack = (v) => String(v || '').replace(/data:image\/svg\+xml(?:;[\w-]+=[\w-]+)*;base64,([A-Za-z0-9+/=]+)/g, (_, b) => { try { return Buffer.from(b, 'base64').toString('utf8'); } catch { return ''; } }).replace(/data:image\/svg\+xml(?:;utf8)?,([^)"']+)/g, (_, b) => { try { return decodeURIComponent(b); } catch { return b; } });
      const fileOf = (el) => el.attrs.src || el.attrs.href || el.attrs['xlink:href'] || el.attrs.data || '';
      for (const el of page.all) {
        if (el.tag === 'feturbulence') { hit(el.line, '<feTurbulence>'); return; }
        if (/feTurbulence/i.test(unpack(fileOf(el)))) { hit(el.line, `<${el.tag}> with feTurbulence`); return; }
      }
      // a layer drawn over the page: fixed or absolute and stretched, or hidden from readers
      const overlay = (el) => {
        const m = declsFor(el, page).map;
        const v = (p) => (m[p] ? m[p].value : '');
        return /fixed|absolute/.test(v('position')) && (/^0/.test(v('inset')) || /100%|100v[wh]/.test(v('width') + v('height')));
      };
      // an overlay is decorative when it lets clicks through, sits behind, or is faded or blended in;
      // a full screen canvas that is the page itself (a game board) is content
      const passive = (el) => { const m = declsFor(el, page).map; const v = (p) => (m[p] ? m[p].value : ''); return /none/.test(v('pointer-events')) || parseFloat(v('z-index')) < 0 || (v('opacity') !== '' && parseFloat(v('opacity')) < 1) || !!v('mix-blend-mode'); };
      const decorative = (el) => el.attrs['aria-hidden'] === 'true' || (el.tag === 'img' && el.attrs.alt === '') || ((el.tag === 'canvas' || el.tag === 'img') && overlay(el) && passive(el) && !el.attrs['aria-label']) || (!['img', 'canvas', 'svg', 'video'].includes(el.tag) && el.attrs.role !== 'img' && !el.attrs['aria-label'] && !visibleText(el, page));
      for (const d of lookDecls(page)) {
        if (/feTurbulence/i.test(unpack(d.value))) { hit(d.line, `${d.prop}: feTurbulence`); return; }
        if (d.prop === 'image-rendering' && /pixelated|crisp-edges/.test(d.value)) {
          const els = targets(d, page);
          if (els.length ? els.some(decorative) : !/(?:^|[\s>])(?:img|canvas)(?:[.#:\[]|$)/.test(d.selector || '')) { hit(d.line, `${d.prop}: ${d.value}`); return; }
        }
        // a picture shown with role img or an aria-label (a photo of a grain elevator) is content, not a texture
        if (/^background(?:-image)?$|^mask(?:-image)?$|^content$/.test(d.prop) && /url\([^)]*(?:noise|grain|dither)[^)]*\)/i.test(d.value) && !(targets(d, page).length && targets(d, page).every((el) => el.attrs.role === 'img' || el.attrs['aria-label']))) { hit(d.line, `${d.prop}: ${d.value}`); return; }
        // a checker or dot pattern of a few pixels is a dither
        if (/^background(?:-image)?$/.test(d.prop) && /repeating-conic-gradient\(/i.test(d.value)) {
          const size = /\/\s*(\d+(?:\.\d+)?)px/.exec(d.value) || /(\d+(?:\.\d+)?)px/.exec((d.rule ? (d.rule.decls.find((x) => x.prop === 'background-size') || {}).value : '') || '');
          if (size && +size[1] <= DOT_PX) { hit(d.line, `${d.prop}: ${d.value}`); return; }
        }
      }
      for (const sc of page.scripts) {
        const code = stripJsComments(sc.text);
        // random pixels: random values written into image data, or a field of one pixel dots at random
        // places. the random source is Math.random, crypto, or a hand-written generator (a function that
        // multiplies by a big constant or shifts and xors); it must sit in the same loop as the pixel write
        const prng = [...code.matchAll(/(?:function\s+([\w$]+)|(?:const|let|var)\s+([\w$]+)\s*=)[^;{]*?(?:=>|\{)[^;]{0,160}?(?:\*\s*\d{6,}|\^=?\s*[\w$()]+\s*(?:<<|>>>?)\s*\d+)/g)].map((x) => (x[1] || x[2]).replace(/\$/g, '\\$'));
        const RANDOM = new RegExp(`Math\\.random|crypto\\.getRandomValues${prng.length ? `|\\b(?:${prng.join('|')})\\(` : ''}`);
        const near = (re) => { for (const x of code.matchAll(re)) { const win = code.slice(Math.max(0, x.index - 200), x.index + x[0].length + 60); if (RANDOM.test(win)) return x; } return null; };
        const m = /feTurbulence/i.exec(code) || /getRandomValues\(\s*[\w$.]*\.data\b/.exec(code) || near(/\.data\[[^\]]+\]\s*=(?!=)|\.data\.set\(/g) || near(/fillRect\([^;]*?,\s*[12]\s*,\s*[12]\s*\)/g);
        if (m) { hit(sc.line + (code.slice(0, m.index).match(/\n/g) || []).length, /feTurbulence/i.test(m[0]) ? 'feTurbulence built by a script' : 'random pixels drawn on a canvas'); return; }
      }
      for (const el of page.all) {
        if (isHidden(el, page) && el.attrs['aria-hidden'] !== 'true') continue;
        const cls = hasClassWord(el, ['noise', 'grain', 'grainy', 'dither', 'dithered']) && !visibleText(el, page) && !kids(el, page).length;
        const file = /(?:noise|grain|dither)[^/]*\.(?:png|svg|webp|gif|jpe?g)/i.test(fileOf(el)) && decorative(el) && !['a', 'link'].includes(el.tag);
        if (cls || file) { hit(el.line, el.attrs.class || el.attrs.src); return; }
      }
    },
  },

  {
    id: 'page-menu-centre', group: 'look',
    line: 'No menu that grows out of its own middle instead of its button.',
    why: `a menu that grows from its own middle seems to come from nowhere instead of from the button you pressed. the rule says so only when the file states three things. one: it is a popup menu, by role menu, a listbox that opens (a popover, a state written for it or a field that points at it with aria-controls) or a popover tied to its button that is not a hint. two: it changes scale on the way in, by keyframes it runs or by an @starting-style or an open or closed state with a transition, read as the style that wins. three: no transform-origin that could reach it is off the centre. whether the origin is the right corner is for a person to judge. when it cannot tell it stays silent. not seen: a scale from a utility class with no rule on the page; a state other than :popover-open, :open, data-state, data-open, data-closed, data-starting-style, data-ending-style, data-enter, data-leave, open, hidden, aria-expanded or a class like open or show (a :hover menu is one); a scale that needs two of those states at once; a rule that names only a state, unless the menu is written in it; a variable set outside the menu and its wrappers or only in a state of a wrapper; a scale and its transition under different @media; a print-only style; the earlier of two keyframes with one name; @layer order and @container. it is silent for the whole page when a script or a click handler names transform-origin or a style sheet could not be read. any origin written for the menu counts as chosen, with no check that it wins: in any state or place, in its keyframes, through a variable or inherit, by an origin class other than origin-center, or for a class or id nothing on the page carries. ${SEEN}`,
    fix: 'set transform-origin on the menu to the side its button is on, like top left for a menu that drops down to the right',
    said: SAID.menuCentre,
    check(ctx, hit) {
      const { page } = ctx;
      // a style sheet the check could not read may set the origin: the rule does not guess
      if (page.unreadSheet) return;
      const sheet = sheetFor(page);
      const ANCHORED = /^(?:position-anchor|position-area|inset-area)$/;
      const INSET = /^(?:inset|top|right|bottom|left|inset-(?:block|inline)(?:-start|-end)?)$/;
      const NAMES_ORIGIN = /transformOrigin|transform-origin/;
      const chosen = (v) => /\bvar\(/.test(v) || !centred(v);
      const nameOf = (el) => `<${el.tag}${el.attrs.id ? ` id="${el.attrs.id}"` : classList(el).length ? ` class="${classList(el)[0]}"` : ''}>`;
      // read once and only when the page has something that may be a menu
      let silent = null, frames = null, carried = null, originRules = null;
      const faults = new Map();
      for (const el of page.all) {
        // the cheap test first: a page with no menu reads no style rule here
        const role = (el.attrs.role || '').toLowerCase().split(/\s+/);
        const menu = role.includes('menu'), listbox = role.includes('listbox'), popover = 'popover' in el.attrs;
        if (!menu && !listbox && !popover) continue;
        // an origin a script or a click handler sets could land on any menu: the rule does not guess which
        // one. a data block (json, an import map) runs nothing
        if (silent == null) {
          silent = page.scripts.some((sc) => !/json|^importmap$|^speculationrules$/i.test(((sc.el && sc.el.attrs.type) || '').trim()) && NAMES_ORIGIN.test(stripJsComments(sc.text))) ||
            page.all.some((x) => Object.keys(x.attrs).some((k) => k.startsWith('on') && NAMES_ORIGIN.test(x.attrs[k])));
        }
        if (silent) return;
        const decls = writtenFor(el, page);
        if (!menu) {
          // a popover counts when it is tied to its button and is not a hint. a listbox counts when the
          // file says it opens: a list that is always on the page is not a popup
          const anchored = popover && !/^hint$/i.test(el.attrs.popover.trim()) && (!!el.attrs.anchor || decls.some((d) => ANCHORED.test(d.prop) || (INSET.test(d.prop) && /\banchor\(/.test(d.value))));
          const opens = popover || decls.some((d) => d.keys.length || d.starting) ||
            (!!el.attrs.id && page.all.some((o) => [o.attrs['aria-controls'], o.attrs['aria-owns']].some((v) => (v || '').split(/\s+/).includes(el.attrs.id))));
          if (!(listbox && opens) && !anchored) continue;
        }
        const states = statesOf(el, page, decls);
        const shown = states.filter((st) => !printOnly(st.media));
        frames = frames || new Map(sheet.rules.filter((r) => r.at === 'keyframes').map((r) => [r.selector, r.frames]));
        // it scales on the way in: a keyframes step it runs in some state, or a scale that wins in one state
        // and not in another with a transition between the two. a transform-origin inside those keyframes is kept
        let found = null;
        const origins = [];
        for (const st of states) {
          const anim = kept(st.map, 'animation', 'animation-name');
          const names = anim ? splitTop(st.fill(anim.value), ',').flatMap(({ text }) => text.trim().split(/\s+/).map((x) => x.replace(/^["']|["']$/g, ''))) : [];
          for (const name of names) for (const f of frames.get(name) || []) for (const x of f.decls) {
            if (plain(x.prop) === 'transform-origin') origins.push(x);
            // an !important transform or scale on the menu outranks the keyframes: the step never shows
            else if (!found && !printOnly(st.media) && !(st.map[plain(x.prop)] || {}).important && scaled(plain(x.prop), st.fill(x.value))) found = x;
          }
        }
        if (!found) {
          const value = (st, p) => (st.map[p] ? st.fill(st.map[p].value).trim().toLowerCase().replace(/\s+/g, ' ') : '');
          const moves = (st) => { const d = kept(st.map, 'transition', 'transition-property'); return !!d && movesScale({ prop: d.prop, value: st.fill(d.value) }); };
          for (const x of shown) for (const p of ['transform', 'scale']) {
            const d = x.map[p];
            if (found || !d || !scaled(p, x.fill(d.value))) continue;
            // the scale differs in another state the file names and a transition in one of the two moves it
            if (shown.some((y) => y.state !== x.state && together(x.media, y.media) && value(y, p) !== value(x, p) && (moves(x) || moves(y)))) found = d;
          }
        }
        if (!found) continue;
        // a transform-origin written anywhere that could reach it is the builder's choice: its inline style,
        // a rule that could come to style it in any state or place, or an origin class
        carried = carried || { classes: new Set(page.all.flatMap(classList)), ids: new Set(page.all.map((x) => x.attrs.id).filter(Boolean)) };
        originRules = originRules || sheet.rules.filter((r) => !NOT_STYLE.test(r.at || '') && r.decls.some((d) => plain(d.prop) === 'transform-origin'));
        for (const d of decls) if (d.spec === INLINE && d.prop === 'transform-origin') origins.push(d);
        for (const r of originRules) if (splitTop(r.selector, ',').some(({ text }) => mayStyle(el, text.trim(), carried))) origins.push(...r.decls.filter((d) => plain(d.prop) === 'transform-origin'));
        const classes = classList(el).map((c) => ({ c, value: classOrigin(c) || classProp(c) })).filter((x) => x.value != null);
        if (origins.some((d) => chosen(d.value)) || classes.some((x) => chosen(x.value))) continue;
        const set = origins.length ? `transform-origin: ${origins[0].value} (line ${origins[0].line}, its own middle)` : classes.length ? `${classes[0].c} (its own middle)` : 'no transform-origin';
        if (!faults.has(el.line)) faults.set(el.line, []);
        faults.get(el.line).push({ el, found, set });
      }
      // one finding per line of the page: it names the menu there and says how many more share the line
      for (const [line, list] of faults) {
        const { el, found, set } = list[0];
        hit(line, `${set} on ${nameOf(el)}${list.length > 1 ? ` and ${list.length - 1} more on this line, which scale` : ', which scales'} in at line ${found.line}: ${found.prop}: ${found.value}`);
      }
    },
  },
];
