// What every page rule reads: the page as a reader meets it (text blocks, the top to bottom flow,
// every style declaration) and small helpers for sizes, colours, frames, bars and icons.

const { cssRules, declsFor, visibleText, pseudoText, markerText, isHidden, classList, utilityDecls, sheetFor, matchesSelector, compileSelector, resolveVars, varLookup, splitTop, INLINE } = require('../page-scan');

const SAID = {
  never: 'never want this (owner, 2026-11-26)',
  subtitle: 'no subtitle text. no explanatory text (owner, 2026-11-25); never want this (owner, 2026-11-26)',
  explain: 'no explanatory text (owner, 2026-11-25); never want this (owner, 2026-11-26)',
  caps: 'no all-caps (design taste); never want this (owner, 2026-11-26)',
  bars: 'never use decorative left-edge highlight bars on cards or calendar items (rulebook); never want this (owner, 2026-11-26)',
  numbers: 'put verified numbers first, keeping each figure exact (rulebook); never want this (owner, 2026-11-26)',
  fonts: 'banned fonts list (owner, 2026-11-26)',
};

const HEADING = /^h[1-6]$/;
const TABLE_PARTS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col']);
const ICON_TAGS = new Set(['svg', 'img', 'i', 'picture']);

// Sizes and counts the rules measure against. Each line says what the number stands for and where it
// comes from. "Set by hand" means a builder picked it and the attack and bench pages hold it, nothing more.
// The browser's default sizes (the html default style sheet): body text 16px, h1 at 2em, h2 at 1.5em,
// and the smaller keyword, which sets text at about five sixths of the text around it.
const BODY_PX = 16;
const H1_PX = 32;
const H2_PX = 24;
const SMALLER = 5 / 6;
// A line without a heading tag reads as a heading at this size. Set by hand above the h1 size: at 32px the
// short step lines on bench page 02 read as headings and their notes as labels above them.
const HEADING_PX = 40;
// A label is a few words, a title one line. Set by hand: an 11 word byline above the heading on bench
// page 11 is not a label.
const LABEL_WORDS = 6;
const TITLE_WORDS = 12;
// Running prose: a paragraph of two sentences or this many words. Set by hand.
const PROSE_WORDS = 20;
// An icon is no bigger than the largest of the usual icon sizes (16, 24, 32, 48 and 64px).
const ICON_PX = 64;
// A dot between words, or one cell of a dither pattern, is no wider than this. Set by hand: half a line of body text.
const DOT_PX = 8;
// A bar down an edge is 2 to 8px wide: 1px is a hairline rule, and wider reads as a column. Set by hand.
const BAR_PX = { min: 2, max: 8 };
// A bar sits on the edge when it is within this of it, and a shadow is centred when it is this close. Set by hand.
const EDGE_PX = 4;
const CENTRED_PX = 2;
// A blur this wide turns a shape or a picture into a soft blob; a smaller one on a photo or over words is
// a photo or a spoiler. Set by hand. An svg stdDeviation is half a css blur.
const GLOW_PX = 30;
// A tint this faint reads as grey: chroma times opacity under 24 of 255, about a tenth of full colour, with
// the matching cut in the other colour spaces. Set by hand.
const FAINT = { rgb: 24, hslSaturation: 12, hslDark: 8, hslLight: 96, oklch: 0.03, lab: 6, lch: 6 };
// A grey darker than this (of 255) draws a bar; a lighter one is a divider. Set by hand between css silver
// (192) and gray (128).
const BAR_LIGHT = 150;
// A colour change across this share of a radial gradient or less is a drawn edge, not a soft wash. Set by hand.
const HARD_EDGE_PCT = 6;
// A sibling lifted more than one line of body text (16px at the usual 1.5 line height), or pinned this close
// to the top of its wrapper, is shown above the heading. Set by hand.
const LIFT_PX = 24;
const TOP_PX = 8;

let placeholderRe;
const PLACEHOLDER = () => placeholderRe || (placeholderRe = require('../slop-kinds').PLACEHOLDER_RE);

// --- small helpers --------------------------------------------------------------

function classWords(el) {
  const words = new Set();
  for (const c of classList(el)) {
    for (const w of c.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase().split(/[-_:/.]+/)) if (w) words.add(w);
  }
  return words;
}
const hasClassWord = (el, list) => { const w = classWords(el); return list.some((x) => w.has(x)); };

// The shown child elements, read once per parent and page, with each child's place among them, so
// stepping to a sibling costs the same on a list of ten items and a list of ten thousand.
const NOT_KIDS = new Set(['script', 'style', 'template', 'noscript', 'link', 'meta']);
function shownKids(el, page) {
  const cache = page ? (page._kids = page._kids || new WeakMap()) : null;
  const hit = cache && cache.get(el);
  if (hit && hit.of === el.children) return hit;
  const list = el.children.filter((c) => c.type === 'el' && !NOT_KIDS.has(c.tag) && !isHidden(c, page));
  const entry = { of: el.children, list, at: new Map(list.map((c, i) => [c, i])) };
  if (cache) cache.set(el, entry);
  return entry;
}
const kids = (el, page) => shownKids(el, page).list;
function nextEl(el, page) {
  const { list, at } = shownKids(el.parent, page);
  return at.has(el) ? list[at.get(el) + 1] || null : list[0] || null;
}
function prevEl(el, page) {
  const { list, at } = shownKids(el.parent, page);
  const i = at.has(el) ? at.get(el) : -1;
  return i > 0 ? list[i - 1] : null;
}
function descendants(el) {
  const out = [];
  const walk = (n) => { for (const c of n.children) if (c.type === 'el') { out.push(c); walk(c); } };
  walk(el);
  return out;
}
// Text only: visible text and nothing but inline phrasing inside.
function textOnly(el, page, { icons = false } = {}) {
  if (HEADING.test(el.tag) || !visibleText(el, page)) return false;
  return descendants(el).every((d) => INLINE.has(d.tag) || (icons && (ICON_TAGS.has(d.tag) || d.tag === 'path' || d.tag === 'circle' || d.tag === 'use')) || isHidden(d, page));
}
// A heading by tag or role, or a short text line set very large (a heading drawn with a div): HEADING_PX, or
// the h1 size when reading the page top to bottom for the line under a title.
function headingLike(el, page, min = HEADING_PX) {
  if (HEADING.test(el.tag) || el.attrs.role === 'heading') return true;
  if (!textOnly(el, page) || words(visibleText(el, page)).length > TITLE_WORDS || !/\p{L}{2}/u.test(visibleText(el, page))) return false;
  if (['blockquote', 'q', 'li', 'td', 'th', 'dd', 'dt', 'figcaption', 'label', 'a', 'button'].includes(el.tag) || inside(el, new Set(['blockquote', 'figure', 'a', 'button', 'li', 'table']))) return false;
  const m = declsFor(el, page).map;
  // below HEADING_PX a line with a number in it is more likely a stat than a title
  const size = m['font-size'] ? pxValue(m['font-size'].value) : null;
  return size != null && (size >= HEADING_PX || (size >= min && !/\d/.test(visibleText(el, page))));
}
const words = (s) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
const clip = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 80);
const lineIn = (node, index) => node.line + (node.text.slice(0, Math.max(0, index)).match(/\n/g) || []).length;
const ancestor = (el, test) => { for (let a = el && el.parent; a && a.tag !== '#root'; a = a.parent) if (test(a)) return a; return null; };
// el itself or one of its ancestors has one of the tags
const inside = (el, tags) => !!ancestor({ parent: el }, (a) => tags.has(a.tag));

// Code a reader skips: code, pre, kbd and samp, unless they are restyled in a prose font (a stack that
// falls back to serif or sans-serif, or a well known book face), whatever the code font is called.
function codeLike(el, page) {
  if (el.tag === 'q') return true; // words quoted in <q> are someone else's, or the product's own output
  if (!['code', 'pre', 'kbd', 'samp', 'tt'].includes(el.tag)) return false;
  const f = declsFor(el, page).map['font-family'];
  if (!f || /mono|courier|consolas|menlo|code|inherit/i.test(f.value)) return true;
  return !/(?:^|,)\s*["']?(?:serif|sans-serif|system-ui|ui-serif|ui-sans-serif|ui-rounded|cursive|fantasy|georgia|times(?: new roman)?|helvetica(?: neue)?|arial|verdana)["']?\s*(?:,|$)/i.test(f.value);
}
const NEVER_READ = new Set(['script', 'style', 'template', 'noscript', 'head', 'title']);

// One walk: blocks of running text a visitor reads. A block is an element that is not inline,
// with the text of its inline children joined as written (so a word split over tags reads whole),
// the text its ::before and ::after draw, svg text, and the words shown in form fields and
// submit buttons. Hidden elements and code are left out.
function readText(page) {
  if (page._text) return page._text;
  const blocks = [];
  const add = (el, text, nodes, extra = {}) => {
    const t = fold(text.replace(/\s+/g, ' ').trim());
    if (!t) return;
    const first = nodes.find((n) => n.text.trim());
    const line = first ? first.line + (first.text.match(/^\s*/)[0].match(/\n/g) || []).length : el.line;
    blocks.push({ el, text: t, nodes, line, ...extra });
  };
  const walk = (el) => {
    for (const c of el.children) {
      if (c.type !== 'el' || NEVER_READ.has(c.tag) || isHidden(c, page) || codeLike(c, page)) continue;
      if (c.tag === 'svg') {
        for (const t of descendants(c)) if (t.tag === 'text') add(t, visibleText(t, page), textNodes(t)); else if (t.tag === 'foreignobject') walk(t);
        continue;
      }
      if (c.tag === 'input' || c.tag === 'textarea') {
        if (c.attrs.placeholder) add(c, c.attrs.placeholder, [], { attr: true });
        if (c.tag === 'textarea') add(c, visibleText(c, page), textNodes(c), { field: true });
        if (/^(?:submit|button|reset)$/i.test(c.attrs.type || '') && c.attrs.value) add(c, c.attrs.value, [], { attr: true });
        continue;
      }
      if (!INLINE.has(c.tag) || displayOf(c, page) === 'block') add(c, inlineText(c, page), textNodes(c, true));
      walk(c);
    }
  };
  walk(page.root);
  // text that sits straight in the root of a fragment
  const rootText = page.root.children.filter((c) => c.type === 'text');
  if (rootText.some((c) => c.text.trim())) add(page.root, inlineText(page.root, page), rootText);
  page._text = { blocks };
  return page._text;
}
function textNodes(el, inlineOnly) {
  const out = [];
  const walk = (n) => { for (const c of n.children) { if (c.type === 'text') out.push(c); else if (!inlineOnly || INLINE.has(c.tag)) walk(c); } };
  walk(el);
  return out;
}
// The running text of a block: its text and inline children, not nested blocks, with the text
// each ::before and ::after draws. A footnote mark in a sup is left out.
function inlineText(el, page) {
  const parts = [];
  const walk = (n) => {
    if (n.tag !== '#root') parts.push(markerText(n, page), pseudoText(n, page, 'before'));
    // children of a flex or grid box are laid out as separate items
    const apart = n.tag !== '#root' && /flex|grid/.test(displayOf(n, page));
    n.children.forEach((c, i) => {
      if (c.type === 'text') { parts.push(c.text); return; }
      const prev = n.children[i - 1];
      // code inside a sentence is still a word of it. It reads as the word code: a sentence keeps its
      // length and the code's own text is never read as prose
      if (INLINE.has(c.tag) && codeLike(c, page) && !isHidden(c, page) && visibleText(c, page)) { parts.push(' code '); return; }
      if (INLINE.has(c.tag) && displayOf(c, page) !== 'block' && !codeLike(c, page) && !isHidden(c, page)) {
        // two parts kept apart on screen (a padded badge then its text) read as two words; when the page
        // loads styles we cannot read, parts styled apart by a class we never see are read as apart too,
        // except a mark of punctuation, which always sits on the word before it. a page with no such
        // styles cannot style a class it never defines. those parts read as one word
        const unseen = (x) => classList(x).some((k) => !utilityDecls(k).length && !sheetFor(page).compiled.some(({ c: sel }) => sel.parts.some((q) => q.c.classes.includes(k))));
        const styledApart = page.unreadSheet && prev && prev.type === 'el' && (prev.attrs.class || '') !== (c.attrs.class || '') && (unseen(prev) || unseen(c)) && !/^[.,;:!?)\]]/.test(visibleText(c, page));
        if (c.tag === 'br' || apart || (prev && prev.type === 'el' && (gapped(prev, page) || gapped(c, page))) || styledApart) parts.push(' ');
        if (c.tag === 'sup' && /^[\d*†‡,\s]+$/.test(visibleText(c, page))) return;
        walk(c);
        if (apart) parts.push(' ');
      } else parts.push(' ');
    });
    if (n.tag !== '#root') parts.push(pseudoText(n, page, 'after'));
  };
  walk(el);
  return parts.join('').replace(/\s+/g, ' ').trim();
}
// Two inline parts stand apart only when a margin, padding or frame sits between them; a colour or
// a highlight alone does not split a word.
function gapped(el, page) {
  const m = declsFor(el, page).map;
  const v = (p) => (m[p] ? m[p].value.trim().toLowerCase().split(/\s+/) : []);
  const side = (p) => { const x = v(p); return x.length > 1 ? [x[1], x[3] || x[1]] : x; };
  const any = (list) => list.some((t) => (pxValue(t) || 0) > 0);
  return any([...side('margin'), ...side('padding'), ...['margin-left', 'margin-right', 'margin-inline', 'margin-inline-start', 'margin-inline-end', 'padding-left', 'padding-right', 'padding-inline'].flatMap(v)]) || borderWidth((m.border || { value: '' }).value) > 0;
}
// English word rules read only text the page marks as English (en, eng, en-US, en_US), or does not mark.
function english(el) {
  for (let a = el; a; a = a.parent) if (a.attrs && a.attrs.lang) return /^eng?(?:[-_]|$)/i.test(a.attrs.lang);
  return true;
}
// A word that mixes Latin letters with a Cyrillic or Greek look-alike reads as the Latin word it shows.
const LOOKALIKE = { 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'ӏ': 'l', 'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'ο': 'o', 'α': 'a', 'ν': 'v', 'ρ': 'p', 'ε': 'e', 'ι': 'i', 'Ο': 'O', 'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ρ': 'P', 'Τ': 'T', 'Χ': 'X', 'Υ': 'Y' };
const LOOK_RE = new RegExp(`[${Object.keys(LOOKALIKE).join('')}]`, 'g');
const fold = (t) => (/[a-z]/i.test(t) && t.search(LOOK_RE) >= 0 ? t.replace(/[\p{L}]+/gu, (w) => (/[a-z]/i.test(w) ? w.replace(LOOK_RE, (c) => LOOKALIKE[c]) : w)) : t);
// The page as a reader meets it, top to bottom: headings, lines of text, content (tables, lists,
// forms and fields, figures, images, maps, data), actions (a lone link or button) and nav rows.
// Wrappers are looked through, so a line two divs away from its heading is still the next thing.
const FLOW_CONTENT = new Set(['table', 'ul', 'ol', 'dl', 'form', 'figure', 'img', 'picture', 'video', 'canvas', 'iframe', 'input', 'textarea', 'select', 'address', 'svg', 'object', 'embed', 'audio', 'map', 'meter', 'progress', 'details']);
const CONTENT_ROLE = /^(?:list|table|grid|treegrid|listbox|tree|radiogroup|feed|figure|img)$/;
function flow(page) {
  if (page._flow) return page._flow;
  const items = [];
  const SKIP = new Set(['hr', 'br', 'wbr', 'script', 'style', 'template', 'noscript', 'link', 'meta', 'head', 'title']);
  const textItem = (el, text, line, pieces) => {
    const t = squashText(text);
    if (!t) return;
    const links = descendants(el).filter((d) => d.tag === 'a' || d.tag === 'button');
    const linkText = links.map((l) => visibleText(l, page)).join(' ').replace(/\s+/g, '');
    let kind = 'text';
    if (['a', 'button'].includes(el.tag) || (links.length && linkText.length >= t.replace(/\s+/g, '').length - 2)) kind = links.length > 1 ? 'nav' : 'action';
    // a paragraph, not a stat made of label pieces: a p, its own running text, or one piece
    const shown = pieces || el.children.filter((c) => (c.type === 'text' ? c.text.trim() : !isHidden(c, page)));
    if (kind === 'text' && (el.tag === 'time' || (shown.length === 1 && shown[0].tag === 'time'))) kind = 'content'; // a date is data
    // a form label names its field: it is part of the form, not a line of text
    if (kind === 'text' && (el.tag === 'label' || shown.some((c) => c.tag === 'label') || descendants(el).some((d) => d.tag === 'label'))) kind = 'content';
    const paragraph = el.tag === 'p' || shown.some((c) => c.type === 'text' && /\p{L}{2}/u.test(c.text)) || shown.length <= 1;
    items.push({ kind, el, text: t, line, paragraph });
  };
  const walk = (el) => {
    let run = [], runEl = null;
    const flush = () => {
      if (run.length) textItem(runEl, run.map((r) => r.text).join(''), run[0].line, run.map((r) => r.node).filter((n) => n.type !== 'text' || n.text.trim()));
      run = [];
    };
    // a flex or grid box shows its items in their order, not the order they are written in
    const ordered = /flex|grid/.test(displayOf(el, page)) ? el.children.map((c, i) => ({ c, i, o: c.type === 'el' ? parseFloat((declsFor(c, page).map.order || { value: '0' }).value) || 0 : 0 })).sort((a, b) => a.o - b.o || a.i - b.i).map((x) => x.c) : el.children;
    for (const c of ordered) {
      if (c.type === 'text') { if (c.text.trim() || run.length) { run.push({ node: c, text: c.text, line: c.line + (c.text.match(/^\s*/)[0].match(/\n/g) || []).length }); runEl = el; } continue; }
      if (SKIP.has(c.tag) || isHidden(c, page)) continue;
      if (INLINE.has(c.tag) && !['a', 'button'].includes(c.tag) && displayOf(c, page) !== 'block') {
        const t = visibleText(c, page);
        if (t) { run.push({ node: c, text: ` ${t} `, line: c.line }); runEl = el; }
        continue;
      }
      flush();
      visit(c);
    }
    flush();
  };
  const visit = (el) => {
    if (HEADING.test(el.tag) || el.attrs.role === 'heading' || (headingLike(el, page, H1_PX))) {
      // the heading's own text, then any block inside it, a smaller line after a break, or a line drawn after it
      const headSize = pxValue((declsFor(el, page).map['font-size'] || { value: '' }).value);
      const smaller = (c) => c.tag === 'small' || (() => {
        const v = (declsFor(c, page).map['font-size'] || { value: '' }).value.trim();
        const rel = /^([\d.]+)(%|em)$/.exec(v);
        if (rel) return +rel[1] / (rel[2] === '%' ? 100 : 1) < SMALLER;
        const f = pxValue(v);
        return f != null && (headSize ? f < headSize * SMALLER : f < H2_PX);
      })();
      const afterBreak = (c) => { const i = el.children.indexOf(c); const before = el.children.slice(0, i).filter((x) => x.type === 'el' || x.text.trim()); return before.length && before[before.length - 1].tag === 'br'; };
      const blockKid = el.children.find((c) => c.type === 'el' && !isHidden(c, page) && visibleText(c, page) && (!INLINE.has(c.tag) || displayOf(c, page) === 'block' || (afterBreak(c) && smaller(c))));
      const headText = blockKid ? squashText(el.children.slice(0, el.children.indexOf(blockKid)).map((c) => (c.type === 'text' ? c.text : visibleText(c, page))).join(' ')) : visibleText(el, page);
      items.push({ kind: 'heading', el, text: headText || visibleText(el, page), line: el.line, big: !HEADING.test(el.tag) && el.attrs.role !== 'heading' });
      if (blockKid && headText) items.push({ kind: 'text', el: blockKid, text: visibleText(blockKid, page), line: blockKid.line, paragraph: true });
      const after = declsFor(el, page).pseudo.after;
      const ownLine = (after.display && /^(?:block|flex|grid)/.test(after.display.value)) || (/^\s*\n/.test(pseudoText(el, page, 'after')) && /pre/.test((after['white-space'] || { value: '' }).value));
      if (ownLine && pseudoText(el, page, 'after').trim()) items.push({ kind: 'text', el, text: pseudoText(el, page, 'after'), line: after.content ? after.content.line : el.line, paragraph: true });
      return;
    }
    if (el.tag === 'nav' || el.attrs.role === 'navigation') { items.push({ kind: 'nav', el, text: visibleText(el, page), line: el.line }); return; }
    if (FLOW_CONTENT.has(el.tag) || CONTENT_ROLE.test(el.attrs.role || '')) { items.push({ kind: 'content', el, text: visibleText(el, page), line: el.line }); return; }
    if (['a', 'button'].includes(el.tag)) { items.push({ kind: 'action', el, text: visibleText(el, page), line: el.line }); return; }
    const d = declsFor(el, page).map;
    if (textOnly(el, page, { icons: true })) { textItem(el, visibleText(el, page), el.line); return; }
    // a grid, or a row of side by side blocks, is content: a block of stats or tiles
    const row = d.display && /flex/.test(d.display.value) && !/column/.test((d['flex-direction'] || d['flex-flow'] || { value: '' }).value) && kids(el, page).length >= 2 && kids(el, page).every((k) => (!INLINE.has(k.tag) || /block|flex|grid/.test(displayOf(k, page))) && (visibleText(k, page) || descendants(k).some((x) => ['img', 'svg', 'picture', 'canvas'].includes(x.tag))));
    if (d.display && (/grid/.test(d.display.value) || row) && kids(el, page).length >= 2 && !descendants(el).some((x) => HEADING.test(x.tag))) { items.push({ kind: 'content', el, text: visibleText(el, page), line: el.line }); return; }
    walk(el);
  };
  walk(page.root);
  page._flow = items;
  return items;
}
const squashText = (s) => String(s || '').replace(/\s+/g, ' ').trim();
function displayOf(el, page) {
  const d = declsFor(el, page).map.display;
  return d ? d.value.trim().toLowerCase().split(/\s+/)[0] : (INLINE.has(el.tag) ? 'inline' : ['td', 'th'].includes(el.tag) ? 'table-cell' : 'block');
}

function lineOf(block, snippet) {
  const probe = snippet.trim().slice(0, 12);
  if (!probe) return block.line;
  for (const n of block.nodes) { const i = n.text.indexOf(probe); if (i >= 0) return lineIn(n, i); }
  return block.line;
}

// Every declaration on the page for the look rules: style sheets, inline styles and utility
// classes, each with the selector or element it came from.
function lookDecls(page) {
  if (page._look) return page._look;
  const sheet = sheetFor(page);
  const fill = (v) => resolveVars(v, (n) => sheet.vars[n]);
  const out = [];
  // a var() is read the way each element the rule lands on sees it: a variable set on a wrapper counts
  // even when :root sets it to something else. with no element to ask, the page-wide value is used
  const hosts = (sel) => page.all.filter((el) => splitTop(sel, ',').some((x) => { const c = compileSelector(x.text.replace(/::?(?:before|after|marker|first-line)\b/g, '')); return c && matchesSelector(el, c); }));
  // css escapes outside quoted strings read as the browser reads them: bl\75r( is blur(
  const unescape = (v) => (v.indexOf('\\') < 0 ? v : v.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\\([0-9a-f]{1,6})\s?|\\([^\n0-9a-f])/gi, (all, q, h, c) => (q || (h ? (() => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })() : c))));
  const push = (raw, extra) => {
    const d = { ...raw, value: unescape(raw.value) };
    const values = new Set();
    if (d.value.includes('var(')) for (const el of extra.el ? [extra.el] : extra.selector && extra.at !== 'keyframes' ? hosts(extra.selector) : []) values.add(resolveVars(d.value, varLookup(el, page)));
    if (!values.size) values.add(fill(d.value));
    for (const value of values) out.push({ ...d, value, raw: d.value, ...extra });
  };
  const rules = sheet.rules.slice();
  // style written inside a script string (a <style> built at run time) is read as a sheet
  for (const sc of page.scripts) {
    const code = stripJsComments(sc.text);
    for (const m of code.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*?\{[^{}]*:[^{}]*\}(?:(?!\1)[^\\]|\\.)*)\1/g)) {
      const at = sc.line + (code.slice(0, m.index).match(/\n/g) || []).length;
      for (const r of cssRules(m[2].replace(/\n/g, ' '), at)) rules.push(r);
    }
  }
  const animations = sheet.rules.filter((r) => !r.starting).flatMap((r) => r.decls).filter((d) => /^animation(?:-name|-fill-mode)?$/.test(d.prop)).map((d) => fill(d.value)).join(' ');
  for (const r of rules) {
    // a first-frame style from @starting-style is not how the page looks once it has drawn
    if (r.starting) continue;
    if (r.at === 'keyframes') {
      // the last step of a run-once animation that keeps its end state is how the page stays
      const name = r.selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!new RegExp(`(?:^|[\\s,])${name}\\b[^,]*\\b(?:forwards|both)\\b|\\b(?:forwards|both)\\b[^,]*\\b${name}(?:[\\s,]|$)`).test(animations) && !/\b(?:forwards|both)\b/.test(animations)) continue;
      const last = r.frames.filter((f) => /\b(?:to|100%)\b/.test(f.selector)).pop();
      if (last) for (const d of last.decls) push(d, { selector: `@keyframes ${r.selector}`, at: 'keyframes' });
      continue;
    }
    for (const d of r.decls) push(d, { selector: r.selector, at: r.at, rule: r });
  }
  const scriptLine = (sc, code, i) => sc.line + (code.slice(0, i).match(/\n/g) || []).length;
  for (const el of page.all) {
    if (el.attrs.style) for (const d of (cssRules(`x{${el.attrs.style}}`, el.line)[0] || { decls: [] }).decls) push(d, { el, selector: null });
    // a class name stands for a style only when a style source could not be read (see rawDecls)
    if (page.unreadSheet) for (const c of classList(el)) for (const u of utilityDecls(c)) push({ ...u, line: el.line }, { el, selector: null });
  }
  // styles and classes a script sets: el.style.x = '...', setProperty, classList.add, className
  for (const sc of page.scripts) {
    const code = joinStrings(stripJsComments(sc.text));
    for (const m of code.matchAll(/\.style\.([a-zA-Z]+)\s*=\s*(["'`])([^"'`]*)\2/g)) push({ prop: m[1].replace(/[A-Z]/g, (x) => `-${x.toLowerCase()}`).replace(/^(webkit|moz|ms)-/, '-$1-'), value: m[3], line: scriptLine(sc, code, m.index) }, { selector: null, script: true });
    for (const m of code.matchAll(/\.style\.setProperty\(\s*(["'])([\w-]+)\1\s*,\s*(["'`])([^"'`]*)\3/g)) push({ prop: m[2].toLowerCase(), value: m[4], line: scriptLine(sc, code, m.index) }, { selector: null, script: true });
    // style['backdrop-filter'] = '...', style.cssText = '...', Object.assign(el.style, { ... })
    for (const m of code.matchAll(/\.style\[\s*(["'])([\w-]+)\1\s*\]\s*=\s*(["'`])([^"'`]*)\3/g)) push({ prop: m[2].replace(/[A-Z]/g, (x) => `-${x.toLowerCase()}`), value: m[4], line: scriptLine(sc, code, m.index) }, { selector: null, script: true });
    for (const m of code.matchAll(/\.style\.cssText\s*\+?=\s*(["'`])([^"'`]*)\1/g)) for (const d of (cssRules(`x{${m[2]}}`)[0] || { decls: [] }).decls) push({ ...d, line: scriptLine(sc, code, m.index) }, { selector: null, script: true });
    for (const m of code.matchAll(/Object\.assign\(\s*[^,]*\.style\s*,\s*\{([^}]*)\}/g)) {
      for (const p of m[1].matchAll(/["']?([\w-]+)["']?\s*:\s*(["'`])([^"'`]*)\2/g)) push({ prop: p[1].replace(/[A-Z]/g, (x) => `-${x.toLowerCase()}`).replace(/^(webkit|moz|ms)-/, '-$1-'), value: p[3], line: scriptLine(sc, code, m.index) }, { selector: null, script: true });
    }
    for (const m of code.matchAll(/(?:classList\.(?:add|toggle|replace)\(([^)]*)\)|className\s*\+?=\s*(["'`])([^"'`]*)\2|setAttribute\(\s*["']class["']\s*,\s*(["'`])([^"'`]*)\4)/g)) {
      const names = (m[1] || m[3] || m[5] || '').match(/[\w:!\[\]\-/.%#()_]+/g) || [];
      if (page.unreadSheet) for (const c of names) for (const u of utilityDecls(c.replace(/^["'`]|["'`]$/g, ''))) push({ ...u, line: scriptLine(sc, code, m.index) }, { selector: null, script: true });
    }
  }
  page._look = out;
  return out;
}
// Script strings built from pieces read as the string they make: ['Instrument', 'Serif'].join('+') and
// 'Inst' + 'rument' become one quoted string.
const joinStrings = (code) => code
  .replace(/\[\s*((?:(["'`])[^"'`\n]*\2\s*,?\s*)+)\]\s*\.join\(\s*(["'`])([^"'`\n]*)\3\s*\)/g, (all, list, q, q2, sep) => `'${[...list.matchAll(/(["'`])([^"'`\n]*)\1/g)].map((x) => x[2]).join(sep)}'`)
  .replace(/(["'])([^"'\n]*)\1\s*\+\s*(["'])([^"'\n]*)\3/g, (all, a, x, b, y) => `'${x}${y}'`);
// Script text without its comments, so a comment that names a setting does not count as setting it.
const stripJsComments = (code) => code.replace(/\/\*[\s\S]*?\*\/|(^|[^:\\])\/\/[^\n]*/g, (m, pre) => (pre != null ? pre : '') + m.slice(pre ? pre.length : 0).replace(/[^\n]/g, ' '));
// One piece of a script read from i, with quoted strings skipped: from an opening brace to the one that
// closes it (a block), else one value up to the comma, semicolon, line end or closing bracket that ends it
// (an argument of a call, an arrow's expression). null when the script ends first: the caller then says
// it did not see it.
function scriptPart(code, i) {
  const open = code[i] === '{';
  for (let j = i, depth = 0; j < code.length; j++) {
    const c = code[j];
    if (c === '"' || c === "'" || c === '`') { for (j++; j < code.length && code[j] !== c; j++) if (code[j] === '\\') j++; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c) && --depth <= 0 && (open || depth < 0)) return code.slice(i, open ? j + 1 : j);
    else if (!open && depth === 0 && /[,;\n]/.test(c)) return code.slice(i, j);
  }
  return null;
}
// The named functions in a script, each with its body read to its end. body is null when it does not end.
const scriptFunctions = (code) => [...code.matchAll(/function\s+([\w$]+)\s*\([^)]*\)\s*(?=\{)|(?:const|let|var)\s+([\w$]+)\s*=\s*(?:(?:async\s+)?(?:\([^)]*\)|[\w$]+)\s*=>\s*|function\b[^(]*\([^)]*\)\s*(?=\{))/g)]
  .map((f) => ({ name: f[1] || f[2], at: f.index, body: scriptPart(code, f.index + f[0].length) }));
// The elements a style declaration lands on, or [] for a rule that matches nothing in the markup.
function targets(d, page) {
  if (d.el) return [d.el];
  if (!d.selector || d.at === 'keyframes' || d.script) return [];
  return page.all.filter((el) => splitTop(d.selector, ',').some((x) => { const c = compileSelector(x.text); return c && !c.pseudo && matchesSelector(el, c); }));
}

// A length in pixels on a desktop screen about 1280 by 800: rem and em at 16px, viewport units, and
// clamp(), min() and max() worked out.
const UNIT = { rem: 16, em: 16, vw: 12.8, vh: 8, vmin: 8, vmax: 12.8, svw: 12.8, lvw: 12.8, dvw: 12.8, svh: 8, lvh: 8, dvh: 8 };
function pxValue(s) {
  const fn = /^\s*(clamp|min|max)\((.*)\)\s*$/i.exec(String(s || ''));
  if (fn) {
    const a = splitTop(fn[2], ',').map((x) => pxValue(x.text));
    if (!a.length || a.some((x) => x == null)) return null;
    const f = fn[1].toLowerCase();
    return f === 'clamp' && a.length === 3 ? Math.max(a[0], Math.min(a[1], a[2])) : f === 'max' ? Math.max(...a) : Math.min(...a);
  }
  const m = /(-?\d*\.?\d+)(px|rem|em|s?[lvd]?v(?:w|h|min|max))?/.exec(s || '');
  if (!m) return null;
  const n = parseFloat(m[1]);
  return n * (UNIT[(m[2] || '').replace(/^[sld](?=v)/, '')] || 1);
}

// Colours: neutral when grey, black, white or fully clear; null when unknown (a variable).
const DYNAMIC_SEL = /:(?:hover|focus|active|checked|target|focus-within|focus-visible)\b|\.(?:is-)?(?:on|open|active|visible|shown|show|in|seen|revealed)\b/;
const NEUTRAL_WORDS = /^(?:black|white|gray|grey|transparent|silver|lightgray|lightgrey|darkgray|darkgrey|dimgray|dimgrey|gainsboro|whitesmoke|snow|ghostwhite|slategray|slategrey|lightslategray|darkslategray)$/;
// Colours: neutral when grey, black, white, fully clear, or so faint a tint (FAINT) that it reads as
// grey; null when unknown.
function colourNeutral(c) {
  let s = String(c || '').trim().toLowerCase();
  const mix = /^color-mix\([^,]*,\s*([^,]+?)(?:\s+\d+%)?\s*,/.exec(s);
  if (mix) s = mix[1].trim();
  if (/^var\(/.test(s) || s === 'currentcolor' || !s) return null;
  if (NEUTRAL_WORDS.test(s)) return true;
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  let r, g, b, a = 1;
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = h.split('').map((x) => x + x).join('');
    r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
    if (h.length === 8) a = parseInt(h.slice(6, 8), 16) / 255;
  } else if ((m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+)(%?))?/.exec(s))) {
    r = +m[1]; g = +m[2]; b = +m[3]; if (m[4] != null) a = m[5] ? +m[4] / 100 : +m[4];
  } else if ((m = /^hsla?\(\s*[\d.]+(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:[\s,/]+([\d.]+)(%?))?/.exec(s))) {
    const alpha = m[3] != null ? (m[4] ? +m[3] / 100 : +m[3]) : 1;
    return +m[1] * alpha < FAINT.hslSaturation || +m[2] < FAINT.hslDark || +m[2] > FAINT.hslLight;
  } else if ((m = /^oklch\(\s*[\d.%]+\s+([\d.]+)/.exec(s))) {
    return +m[1] < FAINT.oklch;
  } else if ((m = /^(ok)?lab\(\s*[\d.%]+\s+(-?[\d.]+)\s+(-?[\d.]+)/.exec(s))) {
    return Math.hypot(+m[2], +m[3]) < (m[1] ? FAINT.oklch : FAINT.lab);
  } else if ((m = /^lch\(\s*[\d.%]+\s+([\d.]+)/.exec(s))) {
    return +m[1] < FAINT.lch;
  } else if ((m = /^color\(\s*[\w-]+\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(s))) {
    return (Math.max(+m[1], +m[2], +m[3]) - Math.min(+m[1], +m[2], +m[3])) * 255 < FAINT.rgb;
  } else return /^[a-z]+$/.test(s) ? false : null;
  return (Math.max(r, g, b) - Math.min(r, g, b)) * a < FAINT.rgb;
}

// Shadows as { inset, x, y, blur, spread, colour }.
function shadows(value) {
  if (!value || /^none$/i.test(value.trim())) return [];
  return splitTop(value, ',').map(({ text: part }) => {
    const colourM = /(#[0-9a-f]{3,8}\b|(?:rgba?|hsla?|oklch|oklab|color-mix|var)\((?:[^()]|\([^()]*\))*\)|\b(?!inset\b)[a-z]{3,}\b)/i.exec(part);
    const rest = part.replace(colourM ? colourM[0] : '', ' ');
    const nums = (rest.match(/-?\d*\.?\d+(?:px|rem|em)?/g) || []).map(pxValue);
    return { inset: /\binset\b/i.test(part), x: nums[0] || 0, y: nums[1] || 0, blur: nums[2] || 0, spread: nums[3] || 0, colour: colourM ? colourM[0] : 'currentcolor' };
  });
}

// A radial gradient whose every change of colour is a hard edge (78% then 80%): a drawn circle or ring,
// not a soft wash. Each radial-gradient in the value must be hard-edged.
function hardEdged(v) {
  const grads = [...String(v).matchAll(/radial-gradient\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)/gi)];
  return grads.length > 0 && grads.every((g) => {
    const parts = splitTop(g[1], ',').map((x) => x.text.trim());
    if (parts.length && !/^(?:#|rgba?|hsla?|oklch|oklab|lab|lch|color|transparent|currentcolor|[a-z]+\s+[\d.]+%)/i.test(parts[0])) parts.shift();
    const stops = parts.map((p) => { const t = splitTop(p, ' ').map((x) => x.text).filter(Boolean); return { c: t[0], at: t.slice(1).map((x) => (/%$/.test(x) ? parseFloat(x) : null)) }; });
    if (stops.length < 2 || stops.some((st) => !st.at.length || st.at.some((x) => x == null))) return false;
    for (let i = 1; i < stops.length; i++) if (stops[i].c !== stops[i - 1].c && stops[i].at[0] - stops[i - 1].at[stops[i - 1].at.length - 1] > HARD_EDGE_PCT) return false;
    return true;
  });
}
// A glow, not a drop shadow: a wide soft edge (blur plus spread), a colour, centred on the box rather than cast below it.
const glowShadow = (s) => s.blur + Math.max(0, s.spread) >= GLOW_PX && s.spread > -s.blur / 2 && Math.abs(s.y) <= s.blur / 2 && colourNeutral(s.colour) === false;
// Coloured shadows centred on the box (a pixel or two off) add up to one halo: three of 24px glow like one of 72px.
const glowShadows = (list) => list.some(glowShadow) || list.filter((s) => !s.inset && Math.abs(s.x) <= CENTRED_PX && Math.abs(s.y) <= CENTRED_PX && colourNeutral(s.colour) === false).reduce((n, s) => n + s.blur + Math.max(0, s.spread), 0) >= GLOW_PX;

const sectionOf = (el) => ancestor(el, (a) => ['section', 'article', 'aside', 'figure'].includes(a.tag));
// A source named near a number: a cite element, a data-source with a value, or a line that opens
// with Source: in the number's block, the block around it, its section, or the line right after
// any of the blocks it sits in.
function hasSource(el, page) {
  const top = ['body', 'main', '#root', 'html'];
  const scopes = [el.parent, el.parent && el.parent.parent, sectionOf(el)].filter((x) => x && !top.includes(x.tag));
  const after = [];
  for (let a = el; a && a.parent && !top.includes(a.tag); a = a.parent) { const n = nextEl(a, page); if (n) after.push(n); }
  // a source a reader can see: a cite with words in it (a bare * names nothing), not the cite of a quote
  const named = (d) => (d.tag === 'cite' ? /\p{L}{2}/u.test(page ? visibleText(d, page) : d.children.map((c) => c.text || '').join('')) && !ancestor(d, (a) => ['blockquote', 'q'].includes(a.tag)) : (d.attrs['data-source'] || '').trim() && !(page && isHidden(d, page))) || (page && textOnly(d, page) && /^sources?\s*:/i.test(visibleText(d, page)));
  return [el, ...scopes].some((s) => named(s) || descendants(s).some(named)) || after.some(named);
}

// Border widths a css value names: lengths and the thin, medium and thick keywords.
const WIDTH_WORD = { thin: 1, medium: 3, thick: 5 };
function borderWidth(v) {
  if (!v || /\b(?:none|hidden)\b/.test(v)) return 0;
  const tokens = v.replace(/(?:rgba?|hsla?|oklch|oklab|color-mix|var)\([^)]*\)+/g, ' ').split(/\s+/);
  for (const t of tokens) {
    if (WIDTH_WORD[t] != null) return WIDTH_WORD[t];
    const m = /^(-?\d*\.?\d+)(px|rem|em)?$/.exec(t);
    if (m) return pxValue(t);
  }
  return /\b(?:solid|dashed|dotted|double|groove|ridge|inset|outset)\b/.test(v) ? 3 : 0;
}
const clearColour = (v) => /\btransparent\b|rgba?\([^)]*,\s*0(?:\.0+)?\s*\)|#[0-9a-f]{6}00\b/i.test(v);
const BORDER_STYLE = /\b(none|hidden|solid|dashed|dotted|double|groove|ridge|inset|outset)\b/;
const SIDE_OF = { top: ['top'], right: ['right'], bottom: ['bottom'], left: ['left'], inline: ['left', 'right'], block: ['top', 'bottom'], 'inline-start': ['left'], 'inline-end': ['right'], 'block-start': ['top'], 'block-end': ['bottom'] };
// Each side's border as the cascade leaves it: { w, style, colour, line }, from the shorthand, the
// per-side and logical forms and the width, style and colour lists, applied in source order.
function borderSides(m) {
  const sides = Object.fromEntries(['top', 'right', 'bottom', 'left'].map((k) => [k, { w: 0, style: 'none', colour: 'currentcolor', line: 0 }]));
  const four = (v) => { const t = v.replace(/\([^)]*\)/g, (x) => x.replace(/\s+/g, '')).split(/\s+/).filter(Boolean); return [t[0], t[1] || t[0], t[2] || t[0], t[3] || t[1] || t[0]]; };
  const put = (targets, part, val, line) => { for (const k of targets) { sides[k][part] = val; sides[k].line = line; } };
  const short = (targets, v, line) => { put(targets, 'w', borderWidth(v), line); put(targets, 'style', (BORDER_STYLE.exec(v) || [, 'none'])[1], line); put(targets, 'colour', borderColour(v), line); };
  const entries = Object.entries(m).filter(([p]) => /^border(?:-|$)/.test(p) && !/radius|image|collapse|spacing/.test(p)).sort((a, b) => (a[1].seq || 0) - (b[1].seq || 0));
  for (const [p, d] of entries) {
    const v = d.value.trim().toLowerCase();
    let x;
    if (p === 'border') short(Object.keys(sides), v, d.line);
    else if ((x = /^border-(top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end)$/.exec(p))) short(SIDE_OF[x[1]], v, d.line);
    else if ((x = /^border-(top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end)-(width|style|color)$/.exec(p))) {
      // border-inline-width: 4px 0 sets the start side then the end side
      const vals = /^(?:inline|block)$/.test(x[1]) ? four(v).slice(0, 2) : [v];
      if (vals.length === 2 && four(v)[1] !== four(v)[0] && v.trim().split(/\s+/).length === 2) SIDE_OF[x[1]].forEach((sd, k) => put([sd], x[2] === 'width' ? 'w' : x[2] === 'color' ? 'colour' : 'style', x[2] === 'width' ? borderWidth(vals[k]) : vals[k], d.line));
      else put(SIDE_OF[x[1]], x[2] === 'width' ? 'w' : x[2] === 'color' ? 'colour' : 'style', x[2] === 'width' ? borderWidth(v) : v, d.line);
    }
    else if ((x = /^border-(width|style|color)$/.exec(p))) four(v).forEach((val, i) => put([['top', 'right', 'bottom', 'left'][i]], x[1] === 'width' ? 'w' : x[1] === 'color' ? 'colour' : 'style', x[1] === 'width' ? borderWidth(val) : val, d.line));
  }
  return sides;
}

// The fill an element paints, or '' when it paints none.
function fillOf(m) {
  const v = (p) => (m[p] ? m[p].value.trim().toLowerCase() : '');
  const bg = v('background-color') || v('background') || v('background-image');
  if (!bg || /^(?:none|transparent|inherit|initial|unset|0)\b/.test(bg) || /^url\(/.test(bg) || clearColour(bg) && !/gradient/.test(bg)) return '';
  return bg;
}
// The background a reader sees behind an element: the nearest painted ancestor, white by default.
function backdrop(el, page) {
  for (let a = el && el.parent; a && a.tag !== '#root'; a = a.parent) { const f = fillOf(declsFor(a, page).map); if (f) return f; }
  return '#fff';
}
const sameColour = (a, b) => a.replace(/\s+/g, '') === b.replace(/\s+/g, '') || (/^(?:#fff(?:fff)?|white)$/.test(a) && /^(?:#fff(?:fff)?|white)$/.test(b));

// Boxed: a visible frame (a border, a ring or a shadow) or a fill that differs from what is behind
// it, together with padding or rounded corners. Read from the resolved declarations, whatever the tag.
function boxedParts(el, page) {
  // a read-only text box shows a block of content and can be a card; a field you type in is a control
  if (['html', 'body', 'button', 'input', 'select', 'img', 'svg', 'pre', 'code', 'hr', 'iframe', 'video', 'br'].includes(el.tag) || (el.tag === 'textarea' && !('readonly' in el.attrs))) return null;
  // a table counts only as a one-cell layout box; a data table and its parts are not cards
  if (TABLE_PARTS.has(el.tag) && !(el.tag === 'table' && descendants(el).filter((d) => d.tag === 'td' || d.tag === 'th').length === 1)) return null;
  const m = declsFor(el, page).map;
  const v = (p) => (m[p] ? m[p].value.trim().toLowerCase() : '');
  const display = displayOf(el, page);
  if (display === 'inline' || display === 'none' || display === 'contents') return null;
  const sides = ['top', 'right', 'bottom', 'left'];
  // a border image paints the frame even over a clear border colour
  const imaged = /gradient|url\(/.test(v('border-image') + v('border-image-source'));
  const shown = (val) => borderWidth(val) > 0 && (!clearColour(val) || imaged);
  // a frame on every side; a single rule on one side is a divider
  const each = borderSides(m);
  let border = shown(v('border')) || sides.every((sd) => shown(v(`border-${sd}`))) || sides.every((sd) => each[sd].w > 0 && !/none|hidden/.test(each[sd].style) && !clearColour(each[sd].colour)) || (v('outline') && shown(v('outline')));
  if (!border && v('border-style') && !/^none\b/.test(v('border-style'))) border = !clearColour(v('border-color')) && (!v('border-width') || borderWidth(v('border-width')) > 0);
  if (!border && el.tag === 'fieldset' && !/^(?:none|0)\b/.test(v('border'))) border = true; // drawn with a frame by default
  const dropShadow = [...v('filter').matchAll(/drop-shadow\(((?:[^()]|\([^()]*\))*)\)/g)].map((x) => shadows(x[1])[0]);
  const shadow = [...shadows(v('box-shadow')), ...dropShadow].some((sh) => sh && (sh.blur > 0 || sh.spread > 0) && !clearColour(sh.colour));
  const fill = fillOf(m);
  const painted = !!fill && !sameColour(fill, backdrop(el, page));
  // room inside the frame: any padding, or an outline held off the box by an offset
  const pad = Object.keys(m).some((p) => /^padding/.test(p) && /[1-9]/.test(v(p))) || el.tag === 'fieldset' || (!!v('outline') && (pxValue(v('outline-offset')) || 0) > 0);
  let radius = v('border-radius') && /[1-9]/.test(v('border-radius'));
  // a frame drawn by a ::before or ::after laid over the whole box
  const frame = ['before', 'after'].map((w) => declsFor(el, page).pseudo[w]).find((pm) => {
    const pv = (p) => (pm[p] ? pm[p].value.trim().toLowerCase() : '');
    const covers = /absolute|fixed/.test(pv('position')) && (/^0(?:px)?(?:\s+0(?:px)?)*$/.test(pv('inset')) || ['top', 'right', 'bottom', 'left'].every((sd) => /^0(?:px)?$/.test(pv(sd))));
    return pm.content && covers && (shown(pv('border')) || shadows(pv('box-shadow')).some((sh) => sh.blur > 0 || sh.spread > 0));
  });
  if (frame) { border = true; radius = radius || /[1-9]/.test(frame['border-radius'] ? frame['border-radius'].value : ''); }
  if (!((border || shadow || painted) && (pad || radius))) return null;
  return { border, shadow, painted, radius };
}
const boxed = (el, page) => !!boxedParts(el, page);

// A colour that draws a bar: anything but a light grey or a clear colour (a light rule divides
// columns; a dark or coloured stripe marks a block).
const GREYS = { lightgray: 211, lightgrey: 211, gainsboro: 220, whitesmoke: 245, silver: 192, white: 255, snow: 255, ghostwhite: 248, darkgray: 169, darkgrey: 169, gray: 128, grey: 128, dimgray: 105, dimgrey: 105, black: 0 };
function barColour(c) {
  const s = String(c || '').trim().toLowerCase();
  if (!s || /^(?:transparent|none)$/.test(s) || clearColour(s)) return false;
  if (GREYS[s] != null) return GREYS[s] < BAR_LIGHT;
  const n = colourNeutral(s);
  if (n !== true) return true;
  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  let light = 0;
  if (hex) { let h = hex[1]; if (h.length <= 4) h = h.split('').map((x) => x + x).join(''); light = parseInt(h.slice(0, 2), 16); }
  const rgb = /^rgba?\(\s*([\d.]+)/.exec(s);
  if (rgb) light = +rgb[1];
  return light < BAR_LIGHT;
}
// The colour named in a border value, or currentColor when none is named.
const borderColour = (v) => { const m = /(#[0-9a-f]{3,8}\b|(?:rgba?|hsla?|oklch|oklab|color-mix)\([^)]*\)+|\b(?!solid|dashed|dotted|double|groove|ridge|inset|outset|none|hidden|thin|medium|thick)[a-z]+\b)/i.exec(v || ''); return m ? m[1] : 'currentcolor'; };
const sideBar = (v) => borderWidth(v) >= BAR_PX.min && !/\b(?:none|hidden)\b/.test(v) && (barColour(borderColour(v)) || borderColour(v) === 'currentcolor');

// The stops of a linear-gradient: its direction and each { colour, at: [positions] }.
function gradientStops(v) {
  const g = /linear-gradient\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)/i.exec(v || '');
  if (!g) return null;
  const parts = splitTop(g[1], ',').map((x) => x.text.trim());
  const dir = /^(?:to\s|-?[\d.]+(?:deg|turn|rad))/.test(parts[0]) ? parts.shift() : 'to bottom';
  const stops = parts.map((p) => { const t = splitTop(p, ' ').map((x) => x.text).filter(Boolean); return { colour: t[0], at: t.slice(1) }; });
  return { dir, stops, text: g[0] };
}
// A gradient painted in one colour all through (a solid strip sized by background-size), as its colour.
function solidGradient(v) {
  const g = gradientStops(v);
  return g && g.stops.length && g.stops.every((s) => s.colour === g.stops[0].colour) ? [g.text, g.stops[0].colour] : null;
}
// A gradient that paints a hard 2 to 8px band of colour at the left edge: to right with the first colour
// stopping a few pixels in and the next colour starting there, or to left with the last colour starting
// a few pixels from the far end.
function gradientBar(v) {
  const g = gradientStops(v);
  if (!g || g.stops.length < 2) return null;
  const dir = g.dir.toLowerCase().replace(/\s+/g, ' ');
  const len = (x) => (x != null && /^-?\d*\.?\d+(?:px|rem|em)$|^0$/.test(x) ? pxValue(x) : null);
  const fromEnd = (x) => { const c = /^calc\(\s*100%\s*-\s*(\d*\.?\d+(?:px|rem|em))\s*\)$/.exec(x || ''); return c ? pxValue(c[1]) : null; };
  const band = (n) => n != null && n >= BAR_PX.min && n <= BAR_PX.max;
  if (/^(?:to right|90deg)$/.test(dir)) {
    const [a, b] = g.stops;
    const end = len(a.at[a.at.length - 1]);
    const start = len(b.at[0]);
    if (band(end) && start != null && start <= end && b.colour !== a.colour && barColour(a.colour)) return g.text;
  }
  if (/^(?:to left|270deg|-90deg)$/.test(dir)) {
    const a = g.stops[g.stops.length - 2], b = g.stops[g.stops.length - 1];
    const n = fromEnd(a.at[a.at.length - 1]);
    const start = b.at.length ? (fromEnd(b.at[0]) != null ? -fromEnd(b.at[0]) : len(b.at[0])) : null;
    if (band(n) && (start == null || start <= 0 || start <= -n) && b.colour !== a.colour && barColour(b.colour)) return g.text;
  }
  return null;
}
// A ::before or ::after drawn as a narrow bar down the left edge: placed at the left and as tall
// as the block, or the first item of a flex row, painted with a fill or its own left border.
const insetRightAt = (inset) => /^calc\(\s*100%\s*-\s*[\d.]+(?:px|rem|em)\s*\)$/.test(inset[1]) && (inset.length < 4 || /^0/.test(inset[3]));
function pseudoBar(pm, hostFlex) {
  const pv = (p) => (pm[p] ? pm[p].value.trim().toLowerCase() : '');
  if (!pm.content && !pm.background && !pm['background-color'] && !pm['background-image']) return false;
  const abs = /absolute|fixed/.test(pv('position'));
  const inset = splitTop(pv('inset'), ' ').map((x) => x.text).filter(Boolean);
  // at the left edge, or straddling it by a few pixels
  const edge = (x) => x !== '' && pxValue(x) != null && Math.abs(pxValue(x)) <= EDGE_PX && !/%/.test(x);
  const left = edge(pv('left')) || edge(pv('inset-inline-start')) || (inset.length >= 4 && edge(inset[3])) || (inset.length === 2 && edge(inset[1])) || (inset.length === 1 && edge(inset[0])) || (inset.length >= 2 && !!insetRightAt(inset));
  // as tall as the block, or most of it
  const tall = (pv('top') && pv('bottom')) || parseFloat((/(\d+(?:\.\d+)?)%/.exec(pv('height') + pv('block-size')) || [])[1]) >= 50 || /^0/.test(pv('inset-block')) || (inset.length >= 3 && /^0/.test(inset[0]) && /^0/.test(inset[2])) || (inset.length === 1 && /^0/.test(inset[0]));
  // the width set directly, by flex-basis, or left over between the left and right insets (inset: 0 calc(100% - 4px) 0 0)
  const insetRight = /^calc\(\s*100%\s*-\s*([\d.]+(?:px|rem|em))\s*\)$/.exec(inset.length >= 2 ? inset[1] : pv('right'));
  const basis = pv('flex-basis') || (splitTop(pv('flex'), ' ').map((x) => x.text).filter(Boolean)[2] || '');
  const w = pxValue(pv('width') || pv('inline-size') || (/^\d/.test(basis) && !/%/.test(basis) ? basis : '') || (insetRight ? insetRight[1] : ''));
  const fill = pv('background') || pv('background-color') || pv('background-image');
  const painted = (fill && barColour(fill.replace(/^.*?(#[0-9a-f]{3,8}|(?:rgba?|hsla?|oklch)\([^)]*\)|\b[a-z]+\b)\s*$/, '$1'))) || sideBar(pv('border-left'));
  const narrow = (w != null && w >= BAR_PX.min && w <= BAR_PX.max) || (sideBar(pv('border-left')) && (w == null || w <= BAR_PX.max));
  return painted && narrow && ((abs && left && tall) || (hostFlex && !abs));
}

// Style rules for elements that only a script builds: the selector matches nothing in the
// markup and each of its class names appears in a script.
function scriptOnly(page) {
  const code = page.scripts.map((x) => x.text).join('\n');
  if (!code) return [];
  return sheetFor(page).compiled.filter(({ c }) => {
    const last = c.parts[c.parts.length - 1].c;
    return last.classes.length && last.classes.every((k) => new RegExp(`(?<![\\w-])${k.replace(/[-]/g, '\\-')}(?![\\w-])`).test(code)) && !page.all.some((el) => matchesSelector(el, c));
  }).map((x) => ({ ...x, c: { ...x.c.parts[x.c.parts.length - 1].c, pseudo: x.c.pseudo } }));
}

// A sibling written after a heading but laid out above it: moved up by flex order or a reversed
// column, placed in an earlier grid area or row, lifted by a transform, or pinned to the top of a padded wrapper.
function shownAbove(h, page) {
  const p = h.parent;
  if (!p || p.tag === '#root') return null;
  const sibs = kids(p, page);
  const after = sibs.slice(sibs.indexOf(h) + 1).filter((x) => visibleText(x, page));
  if (!after.length) return null;
  const m = declsFor(p, page).map;
  const v = (el, prop) => ((el === p ? m : declsFor(el, page).map)[prop] || { value: '' }).value.trim().toLowerCase();
  const flexColumn = /flex/.test(v(p, 'display')) && /column/.test(v(p, 'flex-direction') + v(p, 'flex-flow'));
  if (flexColumn && /column-reverse/.test(v(p, 'flex-direction') + v(p, 'flex-flow'))) return after[0];
  const order = (el) => parseFloat(v(el, 'order')) || 0;
  if (flexColumn) { const up = after.find((x) => order(x) < order(h)); if (up) return up; }
  const areas = (v(p, 'grid-template-areas').match(/"[^"]*"|'[^']*'/g) || []).map((r) => r.slice(1, -1).trim().split(/\s+/));
  const row = (el) => areas.findIndex((r) => r.includes(v(el, 'grid-area')));
  if (areas.length && row(h) > 0) { const up = after.find((x) => row(x) >= 0 && row(x) < row(h)); if (up) return up; }
  // a grid row number set on each, or a sibling lifted above the heading by a transform
  const gridRow = (el) => parseInt(v(el, 'grid-row') || v(el, 'grid-row-start'), 10);
  if (/grid/.test(v(p, 'display')) && gridRow(h) > 0) { const up = after.find((x) => gridRow(x) > 0 && gridRow(x) < gridRow(h)); if (up) return up; }
  const lifted = after.find((x) => { const t = /translate(?:y)?\(\s*(?:[^,)]*,\s*)?(-[\d.]+(?:px|rem|em))/i.exec(v(x, 'transform') + ' ' + v(x, 'translate').replace(/^(\S+)\s+(\S+)$/, 'translate($1, $2)')); return t && pxValue(t[1]) <= -LIFT_PX; });
  if (lifted) return lifted;
  return after.find((x) => /absolute/.test(v(x, 'position')) && pxValue(v(x, 'top')) != null && pxValue(v(x, 'top')) <= TOP_PX && !v(x, 'bottom')) || null;
}

// An icon: an svg or i element, or an image no bigger than ICON_PX.
function smallIcon(el, page) {
  if (el.tag === 'svg' || el.tag === 'i') return true;
  if (el.tag !== 'img') return false;
  const m = declsFor(el, page).map;
  const size = [el.attrs.width, el.attrs.height, m.width && m.width.value, m.height && m.height.value].map(pxValue).filter((n) => n != null);
  return size.length > 0 && Math.max(...size) <= ICON_PX;
}

// The name an icon font draws from ligature text, like arrow_forward in Material Symbols.
function iconFontName(el, page) {
  const f = declsFor(el, page).map['font-family'];
  const named = (f && /material[\s-]*(?:icons|symbols)|icon/i.test(f.value)) || classList(el).some((c) => /^material-(?:icons|symbols)/.test(c));
  const t = visibleText(el, page);
  // a font of its own drawing one snake_case word: a ligature icon (arrow_forward), whatever the font is called
  if (!named) return f && /^[a-z][a-z0-9]*_[a-z0-9_]+$/.test(t) ? t : '';
  return /^[a-z][a-z0-9_]*$/.test(t) ? t : '';
}

// true for a button by its tag, role or drawing. 'name' for a link that is a button only by its class
// name (btn, button, cta): a guess, since the class may mean something else.
function isButton(el, page) {
  if (el.tag === 'button' || el.attrs.role === 'button') return true;
  if (el.tag === 'input' && /^(?:submit|button)$/i.test(el.attrs.type || '')) return true;
  if (el.tag !== 'a' && !('onclick' in el.attrs)) return false;
  // a link or a clickable element drawn as a button: padding or a set height, with a fill or a border
  const m = declsFor(el, page).map;
  const v = (p) => (m[p] ? m[p].value.trim().toLowerCase() : '');
  const pad = ['padding', 'padding-inline', 'padding-left', 'padding-right', 'padding-block', 'height', 'min-height'].some((p) => v(p) && pxValue(v(p)) > 0);
  const bg = v('background-color') || v('background') || v('background-image');
  const fill = bg && !/^(?:none|transparent|inherit|initial|unset)/.test(bg);
  const border = (v('border') && !/^(?:none|0)/.test(v('border'))) || (/^(?!none|hidden)[a-z]/.test(v('border-style')) && borderWidth(v('border-width') || 'medium') > 0);
  if (pad && (fill || border)) return true;
  return el.tag === 'a' && hasClassWord(el, ['btn', 'button', 'cta']) ? 'name' : false;
}

// Arrow characters: the arrow blocks, chevrons, angle marks and the typed -> and =>. A lone < or >
// before a number is a comparison (< 1 mile), not an arrow.
const ARROW = /[\u2190-\u21ff\u27f0-\u27ff\u2900-\u297f\u2b00-\u2b11\u2b60-\u2bb9\u{1F800}-\u{1F8FF}›»⟩〉〉❭❯❮❱➔➜➝➤➢➣➥➦➧➨➩➪➫➬➭➮➯➱⮕]|->|=>|<-|(?:^|\s)(?:>>?|<<?)(?=\s|$)(?!\s*\d)/u;
// Triangles (▶ ⏵) read as a play mark when they lead the label and as an arrow when they follow it.
const TRIANGLE = /[▶▸►⏵⏩◀◂◄⏴⏪]/;
// An arrow in a label; a pair of French quote marks around a word is not an arrow.
const hasArrow = (label) => { const t = label.replace(/«([^«»]*)»/g, '$1').replace(/‹([^‹›]*)›/g, '$1'); return ARROW.test(t) || TRIANGLE.test(t.replace(/^\s*[▶▸►⏵⏩◀◂◄⏴⏪]\uFE0F?/, '')); };
// A chevron drawn with css: borders on two sides of a small box, turned with rotate or a matrix.
function drawnChevron(pm) {
  const v = (p) => (pm[p] ? pm[p].value.toLowerCase() : '');
  if (!/rotate|matrix/.test(v('transform') + v('rotate'))) return false;
  const shown = borderSides(pm);
  return ['top', 'right', 'bottom', 'left'].filter((sd) => shown[sd].w >= 1 && shown[sd].style !== 'none' && !clearColour(shown[sd].colour)).length === 2;
}
// A small shape drawn with css after a label: a box cut into a triangle, a triangle drawn from borders
// (a box of no size with one coloured side and clear sides next to it), or an image painted, masked or
// put in as content. An image gives 'picture': what it shows cannot be read from the page.
function drawnShape(pm) {
  const v = (p) => (pm[p] ? pm[p].value.toLowerCase() : '');
  const sides = borderSides(pm);
  const coloured = ['top', 'right', 'bottom', 'left'].filter((sd) => sides[sd].w > 0 && !/none|hidden/.test(sides[sd].style) && !clearColour(sides[sd].colour));
  const clear = ['top', 'right', 'bottom', 'left'].filter((sd) => sides[sd].w > 0 && clearColour(sides[sd].colour));
  const triangle = coloured.length === 1 && clear.length >= 1 && ['width', 'height'].every((p) => !pm[p] || (pxValue(v(p)) || 0) <= 1);
  if (triangle || /polygon\(/.test(v('clip-path'))) return true;
  return /url\(/.test(v('mask') + v('mask-image') + v('-webkit-mask') + v('-webkit-mask-image') + v('background-image') + v('content') + (/url\(/.test(v('background')) ? v('background') : '')) ? 'picture' : false;
}
// An icon: an svg, img, i or picture, an icon-font glyph, a span or other inline tag with an icon
// class or nothing in it but a drawn chevron, or a custom icon element.
function iconLike(el, page) {
  if (ICON_TAGS.has(el.tag) || ['object', 'embed'].includes(el.tag) || /(?:^|-)icon(?:-|$)/.test(el.tag) || iconFontName(el, page)) return true;
  if (!INLINE.has(el.tag)) return false;
  const t = visibleText(el, page);
  if (t && !hasArrow(t)) return false;
  if (t) return true;
  const d = declsFor(el, page);
  if (drawnChevron(d.map) || drawnShape(d.map) || ['before', 'after'].some((w) => drawnChevron(d.pseudo[w]) || drawnShape(d.pseudo[w]))) return true;
  // an empty element named as an icon by its class or an icon attribute: 'name', a guess
  return hasClassWord(el, ['icon', 'arrow', 'chevron', 'caret', 'lucide', 'fa', 'bi', 'material', 'symbols']) || ['data-icon', 'data-lucide', 'icon'].some((a) => a in el.attrs) ? 'name' : false;
}
// A dot drawn with css: a round box of DOT_PX or less, filled or drawn by its border.
const drawnDot = (m) => { const px = (p) => (m[p] ? pxValue(m[p].value) : null); const ring = borderWidth((m.border || { value: '' }).value); return px('width') != null && px('width') + 2 * ring <= DOT_PX && px('height') != null && px('height') + 2 * ring <= DOT_PX && !!m['border-radius'] && (!!(m.background || m['background-color']) || ring > 0); };
const SPARKLE = /[✨✦✧✩✪✫✬✭✮✯✰✱✲✳✴✵✶✷✸✹✺✻✼✽❂❃❇❈❉❊❋⁂⁕⋆⟡✢✣✤✥💫⭐🌟🌠🪄]/u;
const DOT_CHARS = '·•‧∙●◦⋅・･⦁\u0387\u2e31\u2e33\ua78f\u16eb';
// An emoji at the start of a string: a pictograph, a keycap (1️⃣) or a flag; not ©, ® or an arrow.
// Card suits, a rating star and a play triangle are text symbols, data or a control, unless written with
// the emoji selector (♥️).
const emojiAt = (s) => /^(?:[0-9#*]\uFE0F?\u20E3|[\u{1F1E6}-\u{1F1FF}]{2}|(?![©®™‼⁉↔-↙↩↪⤴⤵]|[♠♣♥♦★▶◀](?!\uFE0F))\p{Extended_Pictographic})/u.test(s);
const EMOJI_RUN = /(?:[0-9#*]\uFE0F?\u20E3|\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\u{1F1E6}-\u{1F1FF}]|\p{Emoji_Modifier}|[\uFE0F\u200D])+/gu;
const NUMBER_TOKEN = /^(?:#\s?)?[~≈<>+−-]?[$€£]?\d[\d,.]*\s?(?:%|x|×|\+|k|m|b|bn|mm|ms|s|h|hrs?|min|pts?|days?|weeks?|wks?|mo|yrs?|billion|million|thousand|trillion)?\+?(?:\s?(?:\/|of)\s?[\d,]+)?$/i;
// Abbreviations that end in a period inside a sentence: titles, places, months and days.
// An abbreviation that is also a plain word (rep, sun, fig) counts only when written capitalised (Rep., Sun.).
const ABBR_RE = /(?:^|\s)(?:inc|ltd|co|corp|llc|jr|sr|dr|mr|mrs|ms|st|vs|etc|approx|dept|mt|ave|blvd|rd|ln|hwy|pkwy|ct|pl|cir|ter|sq|bldg|fl|rm|apt|ste|bros|assn|intl|univ|prof|gov|sen|sgt|capt|lt|fr|vol|ch|pp|ed|eds|ft|oz|lb|lbs|jan|feb|apr|jun|jul|aug|sep|sept|oct|nov|tue|tues|thu|thur|thurs|fri|a\.m|p\.m|e\.g|i\.e|cf|al|ca|sra|srta|sres|bzw|usw|ggf|inkl|evtl)\.$/i;
const ABBR = { test: (t) => ABBR_RE.test(t) || /(?:^|\s)(?:Rep|Sun|Sat|Col|Mar|Mon|Wed|Sec|Gen|Rev|Est|Dec|Hon|Fig)\.$/.test(t) };

module.exports = { SAID, HEADING, TABLE_PARTS, ICON_TAGS, BODY_PX, H1_PX, H2_PX, SMALLER, LABEL_WORDS, TITLE_WORDS, PROSE_WORDS, ICON_PX, DOT_PX, BAR_PX, GLOW_PX, PLACEHOLDER, classWords, hasClassWord, kids, nextEl, prevEl, descendants, textOnly, headingLike, words, clip, ancestor, inside, codeLike, readText, textNodes, english, flow, displayOf, lineOf, lookDecls, stripJsComments, joinStrings, scriptPart, scriptFunctions, targets, pxValue, DYNAMIC_SEL, colourNeutral, shadows, hardEdged, glowShadow, glowShadows, hasSource, borderWidth, clearColour, borderSides, fillOf, backdrop, boxedParts, boxed, barColour, sideBar, solidGradient, gradientBar, pseudoBar, scriptOnly, shownAbove, smallIcon, iconFontName, isButton, hasArrow, drawnChevron, drawnShape, iconLike, drawnDot, SPARKLE, DOT_CHARS, emojiAt, EMOJI_RUN, NUMBER_TOKEN, ABBR };
