// Page rules for `atris slop detect --kind screen` on html pages. Each rule is data plus a
// check that reads the page structure and the resolved style declarations (lib/page-scan.js),
// never class names alone, so a renamed class or a card drawn with a plain div is still seen.
// Every rule is a yes/no error. A project can switch one off in .atris/slop.rules.json
// ({ "off": ["page-glow"] }); a switched-off rule is reported in `off`, never dropped silently.

const fs = require('fs');
const path = require('path');
const { parsePage, cssRules, declsFor, visibleText, pseudoText, markerText, isHidden, classList, utilityDecls, sheetFor, matchesSelector, compileSelector, resolveVars, varLookup, splitTop, INLINE } = require('./page-scan');

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
const SKIP_TEXT = new Set(['code', 'pre', 'kbd', 'samp', 'script', 'style', 'template', 'noscript', 'head', 'title', 'svg']);
const TABLE_PARTS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col']);
const ICON_TAGS = new Set(['svg', 'img', 'i', 'picture']);

let capsOk;
const CAPS_OK = () => capsOk || (capsOk = require('./slop-kinds').CAPS_OK);
let placeholderRe;
const PLACEHOLDER = () => placeholderRe || (placeholderRe = require('./slop-kinds').PLACEHOLDER_RE);

// --- small helpers --------------------------------------------------------------

function classWords(el) {
  const words = new Set();
  for (const c of classList(el)) {
    for (const w of c.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase().split(/[-_:/.]+/)) if (w) words.add(w);
  }
  return words;
}
const hasClassWord = (el, list) => { const w = classWords(el); return list.some((x) => w.has(x)); };

function kids(el, page) {
  return el.children.filter((c) => c.type === 'el' && !['script', 'style', 'template', 'noscript', 'link', 'meta'].includes(c.tag) && !isHidden(c, page));
}
function nextEl(el, page) {
  const sibs = kids(el.parent, page);
  return sibs[sibs.indexOf(el) + 1] || null;
}
function prevEl(el, page) {
  const sibs = kids(el.parent, page);
  const i = sibs.indexOf(el);
  return i > 0 ? sibs[i - 1] : null;
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
// A heading by tag or role, or a short text line set very large (a heading drawn with a div).
function headingLike(el, page) {
  if (HEADING.test(el.tag) || el.attrs.role === 'heading') return true;
  if (!textOnly(el, page) || words(visibleText(el, page)).length > 12 || !/\p{L}{2}/u.test(visibleText(el, page))) return false;
  if (['blockquote', 'q', 'li', 'td', 'th', 'dd', 'dt', 'figcaption', 'label', 'a', 'button'].includes(el.tag) || inside(el, new Set(['blockquote', 'figure', 'a', 'button', 'li', 'table']))) return false;
  const m = declsFor(el, page).map;
  return !!m['font-size'] && pxValue(m['font-size'].value) >= 40;
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
      if (INLINE.has(c.tag) && displayOf(c, page) !== 'block' && !codeLike(c, page) && !isHidden(c, page)) {
        // two parts kept apart on screen (a padded badge then its text) read as two words; parts styled
        // apart by a class the page never shows us (a linked sheet that is missing) are read as apart too,
        // except a mark of punctuation, which always sits on the word before it
        const unseen = (x) => classList(x).some((k) => !utilityDecls(k).length && !sheetFor(page).compiled.some(({ c: sel }) => sel.parts.some((q) => q.c.classes.includes(k))));
        const styledApart = prev && prev.type === 'el' && (prev.attrs.class || '') !== (c.attrs.class || '') && (unseen(prev) || unseen(c)) && !/^[.,;:!?)\]]/.test(visibleText(c, page));
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
// English word rules read only text the page marks as English (en, en-US, en_US), or does not mark.
function english(el) {
  for (let a = el; a; a = a.parent) if (a.attrs && a.attrs.lang) return /^en(?:[-_]|$)/i.test(a.attrs.lang);
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
    const paragraph = el.tag === 'p' || shown.some((c) => c.type === 'text' && /\p{L}{2}/u.test(c.text)) || shown.length <= 1;
    items.push({ kind, el, text: t, line, paragraph });
  };
  const walk = (el) => {
    let run = [], runEl = null;
    const flush = () => {
      if (run.length) textItem(runEl, run.map((r) => r.text).join(''), run[0].line, run.map((r) => r.node).filter((n) => n.type !== 'text' || n.text.trim()));
      run = [];
    };
    for (const c of el.children) {
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
    if (HEADING.test(el.tag) || el.attrs.role === 'heading' || (headingLike(el, page))) {
      // the heading's own text, then any block inside it, a smaller line after a break, or a line drawn after it
      const headSize = pxValue((declsFor(el, page).map['font-size'] || { value: '' }).value);
      const smaller = (c) => c.tag === 'small' || (() => { const f = pxValue((declsFor(c, page).map['font-size'] || { value: '' }).value); return f != null && (headSize ? f < headSize * 0.7 : f < 24); })();
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
    if (d.display && /grid/.test(d.display.value) && kids(el, page).length >= 2 && !descendants(el).some((x) => HEADING.test(x.tag))) { items.push({ kind: 'content', el, text: visibleText(el, page), line: el.line }); return; }
    walk(el);
  };
  walk(page.root);
  page._flow = items;
  return items;
}
const squashText = (s) => String(s || '').replace(/\s+/g, ' ').trim();
function displayOf(el, page) {
  const d = declsFor(el, page).map.display;
  return d ? d.value.trim().toLowerCase().split(/\s+/)[0] : (INLINE.has(el.tag) ? 'inline' : 'block');
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
  const push = (d, extra) => {
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
  const animations = sheet.rules.flatMap((r) => r.decls).filter((d) => /^animation(?:-name|-fill-mode)?$/.test(d.prop)).map((d) => fill(d.value)).join(' ');
  for (const r of rules) {
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
    for (const c of classList(el)) for (const u of utilityDecls(c)) push({ ...u, line: el.line }, { el, selector: null });
  }
  // styles and classes a script sets: el.style.x = '...', setProperty, classList.add, className
  for (const sc of page.scripts) {
    const code = stripJsComments(sc.text);
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
      for (const c of names) for (const u of utilityDecls(c.replace(/^["'`]|["'`]$/g, ''))) push({ ...u, line: scriptLine(sc, code, m.index) }, { selector: null, script: true });
    }
  }
  page._look = out;
  return out;
}
// Script text without its comments, so a comment that names a setting does not count as setting it.
const stripJsComments = (code) => code.replace(/\/\*[\s\S]*?\*\/|(^|[^:\\])\/\/[^\n]*/g, (m, pre) => (pre != null ? pre : '') + m.slice(pre ? pre.length : 0).replace(/[^\n]/g, ' '));
// The elements a style declaration lands on, or [] for a rule that matches nothing in the markup.
function targets(d, page) {
  if (d.el) return [d.el];
  if (!d.selector || d.at === 'keyframes' || d.script) return [];
  return page.all.filter((el) => splitTop(d.selector, ',').some((x) => { const c = compileSelector(x.text); return c && !c.pseudo && matchesSelector(el, c); }));
}

function pxValue(s) {
  const m = /(-?\d*\.?\d+)(px|rem|em)?/.exec(s || '');
  if (!m) return null;
  const n = parseFloat(m[1]);
  return m[2] === 'rem' || m[2] === 'em' ? n * 16 : n;
}

// Colours: neutral when grey, black, white or fully clear; null when unknown (a variable).
const DYNAMIC_SEL = /:(?:hover|focus|active|checked|target|focus-within|focus-visible)\b|\.(?:is-)?(?:on|open|active|visible|shown|show|in|seen|revealed)\b/;
const NEUTRAL_WORDS = /^(?:black|white|gray|grey|transparent|silver|lightgray|lightgrey|darkgray|darkgrey|dimgray|dimgrey|gainsboro|whitesmoke|snow|ghostwhite|slategray|slategrey|lightslategray|darkslategray)$/;
// Colours: neutral when grey, black, white, fully clear, or so faint a tint (chroma times opacity
// under 24 of 255) that it reads as grey; null when unknown.
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
    return +m[1] * alpha < 12 || +m[2] < 8 || +m[2] > 96;
  } else if ((m = /^oklch\(\s*[\d.%]+\s+([\d.]+)/.exec(s))) {
    return +m[1] < 0.03;
  } else return /^[a-z]+$/.test(s) ? false : null;
  return (Math.max(r, g, b) - Math.min(r, g, b)) * a < 24;
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

// A glow, not a drop shadow: a wide soft edge (blur plus spread), a colour, centred on the box rather than cast below it.
const glowShadow = (s) => s.blur + Math.max(0, s.spread) >= 30 && s.spread > -s.blur / 2 && Math.abs(s.y) <= s.blur / 2 && colourNeutral(s.colour) === false;
// Coloured shadows centred on the box (a pixel or two off) add up to one halo: three of 24px glow like one of 72px.
const glowShadows = (list) => list.some(glowShadow) || list.filter((s) => !s.inset && Math.abs(s.x) <= 2 && Math.abs(s.y) <= 2 && colourNeutral(s.colour) === false).reduce((n, s) => n + s.blur + Math.max(0, s.spread), 0) >= 30;

const sectionOf = (el) => ancestor(el, (a) => ['section', 'article', 'aside', 'figure'].includes(a.tag));
// A source named near a number: a cite element, a data-source with a value, or a line that opens
// with Source: in the number's block, the block around it, or its section.
function hasSource(el, page) {
  const scopes = [el.parent, el.parent && el.parent.parent, sectionOf(el)].filter((x) => x && !['body', 'main', '#root', 'html'].includes(x.tag));
  // a source a reader can see: an empty or hidden cite names nothing
  const named = (d) => (d.tag === 'cite' ? !!(page ? visibleText(d, page) : d.children.length) : (d.attrs['data-source'] || '').trim() && !(page && isHidden(d, page))) || (page && textOnly(d, page) && /^(?:sources?|data|via)\s*:/i.test(visibleText(d, page)));
  return [el, ...scopes].some((s) => named(s) || descendants(s).some(named));
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
    else if ((x = /^border-(top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end)-(width|style|color)$/.exec(p))) put(SIDE_OF[x[1]], x[2] === 'width' ? 'w' : x[2] === 'color' ? 'colour' : 'style', x[2] === 'width' ? borderWidth(v) : v, d.line);
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
  if (['html', 'body', 'button', 'input', 'select', 'textarea', 'img', 'svg', 'pre', 'code', 'hr', 'iframe', 'video', 'br'].includes(el.tag) || TABLE_PARTS.has(el.tag)) return null;
  const m = declsFor(el, page).map;
  const v = (p) => (m[p] ? m[p].value.trim().toLowerCase() : '');
  const display = displayOf(el, page);
  if (display === 'inline' || display === 'none' || display === 'contents') return null;
  const sides = ['top', 'right', 'bottom', 'left'];
  const shown = (val) => borderWidth(val) > 0 && !clearColour(val);
  // a frame on every side; a single rule on one side is a divider
  const each = borderSides(m);
  let border = shown(v('border')) || sides.every((sd) => shown(v(`border-${sd}`))) || sides.every((sd) => each[sd].w > 0 && !/none|hidden/.test(each[sd].style) && !clearColour(each[sd].colour)) || (v('outline') && shown(v('outline')));
  if (!border && v('border-style') && !/^none\b/.test(v('border-style'))) border = !clearColour(v('border-color')) && (!v('border-width') || borderWidth(v('border-width')) > 0);
  if (!border && el.tag === 'fieldset' && !/^(?:none|0)\b/.test(v('border'))) border = true; // drawn with a frame by default
  const dropShadow = [...v('filter').matchAll(/drop-shadow\(((?:[^()]|\([^()]*\))*)\)/g)].map((x) => shadows(x[1])[0]);
  const shadow = [...shadows(v('box-shadow')), ...dropShadow].some((sh) => sh && (sh.blur > 0 || sh.spread > 0) && !clearColour(sh.colour));
  const fill = fillOf(m);
  const painted = !!fill && !sameColour(fill, backdrop(el, page));
  const pad = ['padding', 'padding-top', 'padding-left', 'padding-inline', 'padding-block'].some((p) => v(p) && /[1-9]/.test(v(p))) || el.tag === 'fieldset';
  const radius = v('border-radius') && /[1-9]/.test(v('border-radius'));
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
  if (GREYS[s] != null) return GREYS[s] < 150;
  const n = colourNeutral(s);
  if (n !== true) return true;
  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  let light = 0;
  if (hex) { let h = hex[1]; if (h.length <= 4) h = h.split('').map((x) => x + x).join(''); light = parseInt(h.slice(0, 2), 16); }
  const rgb = /^rgba?\(\s*([\d.]+)/.exec(s);
  if (rgb) light = +rgb[1];
  return light < 150;
}
// The colour named in a border value, or currentColor when none is named.
const borderColour = (v) => { const m = /(#[0-9a-f]{3,8}\b|(?:rgba?|hsla?|oklch|oklab|color-mix)\([^)]*\)+|\b(?!solid|dashed|dotted|double|groove|ridge|inset|outset|none|hidden|thin|medium|thick)[a-z]+\b)/i.exec(v || ''); return m ? m[1] : 'currentcolor'; };
const sideBar = (v) => borderWidth(v) >= 2 && !/\b(?:none|hidden)\b/.test(v) && (barColour(borderColour(v)) || borderColour(v) === 'currentcolor');

// A ::before or ::after drawn as a narrow bar down the left edge: placed at the left and as tall
// as the block, or the first item of a flex row, painted with a fill or its own left border.
function pseudoBar(pm, hostFlex) {
  const pv = (p) => (pm[p] ? pm[p].value.trim().toLowerCase() : '');
  if (!pm.content && !pm.background && !pm['background-color']) return false;
  const abs = /absolute|fixed/.test(pv('position'));
  const inset = pv('inset').split(/\s+/);
  // at the left edge, or straddling it by a few pixels
  const edge = (x) => x !== '' && pxValue(x) != null && Math.abs(pxValue(x)) <= 4 && !/%/.test(x);
  const left = edge(pv('left')) || edge(pv('inset-inline-start')) || (inset.length >= 4 && edge(inset[3])) || (inset.length === 1 && edge(inset[0]));
  // as tall as the block, or most of it
  const tall = (pv('top') && pv('bottom')) || parseFloat((/(\d+(?:\.\d+)?)%/.exec(pv('height') + pv('block-size')) || [])[1]) >= 50 || /^0/.test(pv('inset-block')) || (inset.length >= 3 && /^0/.test(inset[0]) && /^0/.test(inset[2])) || (inset.length === 1 && /^0/.test(inset[0]));
  const w = pxValue(pv('width') || pv('inline-size'));
  const fill = pv('background') || pv('background-color');
  const painted = (fill && barColour(fill.replace(/^.*?(#[0-9a-f]{3,8}|(?:rgba?|hsla?|oklch)\([^)]*\)|\b[a-z]+\b)\s*$/, '$1'))) || sideBar(pv('border-left'));
  const narrow = (w != null && w >= 2 && w <= 8) || (sideBar(pv('border-left')) && (w == null || w <= 8));
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
// column, placed in an earlier grid area, or pinned to the top of a padded wrapper.
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
  return after.find((x) => /absolute/.test(v(x, 'position')) && pxValue(v(x, 'top')) != null && pxValue(v(x, 'top')) <= 8 && !v(x, 'bottom')) || null;
}

// An icon: an svg or i element, or an image no bigger than 64px.
function smallIcon(el, page) {
  if (el.tag === 'svg' || el.tag === 'i') return true;
  if (el.tag !== 'img') return false;
  const m = declsFor(el, page).map;
  const size = [el.attrs.width, el.attrs.height, m.width && m.width.value, m.height && m.height.value].map(pxValue).filter((n) => n != null);
  return size.length > 0 && Math.max(...size) <= 64;
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

function isButton(el, page) {
  if (el.tag === 'button' || el.attrs.role === 'button') return true;
  if (el.tag === 'input' && /^(?:submit|button)$/i.test(el.attrs.type || '')) return true;
  if (el.tag !== 'a' && !('onclick' in el.attrs)) return false;
  if (el.tag === 'a' && hasClassWord(el, ['btn', 'button', 'cta'])) return true;
  // a link or a clickable element drawn as a button: padding or a set height, with a fill or a border
  const m = declsFor(el, page).map;
  const v = (p) => (m[p] ? m[p].value.trim().toLowerCase() : '');
  const pad = ['padding', 'padding-inline', 'padding-left', 'padding-right', 'padding-block', 'height', 'min-height'].some((p) => v(p) && pxValue(v(p)) > 0);
  const bg = v('background-color') || v('background') || v('background-image');
  const fill = bg && !/^(?:none|transparent|inherit|initial|unset)/.test(bg);
  const border = (v('border') && !/^(?:none|0)/.test(v('border'))) || (/^(?!none|hidden)[a-z]/.test(v('border-style')) && borderWidth(v('border-width') || 'medium') > 0);
  return !!(pad && (fill || border));
}

const ARROW = /[→↗↘➔➜➝⟶⇒›»⟩←↑↓⟵⇐⬅⬆⬇➡⮕❯❮❱➤➢➣➥➦➧➨➩➪➫➬➭➮➯➱⇨⇾⟹⟾⇢↦⭢⭠⮞⮜▶▸►◀◂◄]|->|=>|<-|(?:^|\s)(?:>>?|<<?)(?=\s|$)/;
// An arrow in a label; a pair of French quote marks around a word is not an arrow.
const hasArrow = (label) => ARROW.test(label.replace(/«([^«»]*)»/g, '$1').replace(/‹([^‹›]*)›/g, '$1'));
// A chevron drawn with css: borders on two sides of a small box, turned with rotate.
function drawnChevron(pm) {
  const v = (p) => (pm[p] ? pm[p].value.toLowerCase() : '');
  if (!/rotate/.test(v('transform') + v('rotate'))) return false;
  const shown = borderSides(pm);
  return ['top', 'right', 'bottom', 'left'].filter((sd) => shown[sd].w >= 1 && shown[sd].style !== 'none' && !clearColour(shown[sd].colour)).length === 2;
}
// A small shape drawn with css after a label: a box cut into a triangle, or an image painted or masked in.
function drawnShape(pm) {
  const v = (p) => (pm[p] ? pm[p].value.toLowerCase() : '');
  return /polygon\(/.test(v('clip-path')) || /url\(/.test(v('mask') + v('mask-image') + v('-webkit-mask') + v('-webkit-mask-image') + v('background-image') + (/url\(/.test(v('background')) ? v('background') : ''));
}
// An icon: an svg, img, i or picture, an icon-font glyph, a span or other inline tag with an icon
// class or nothing in it but a drawn chevron, or a custom icon element.
function iconLike(el, page) {
  if (ICON_TAGS.has(el.tag) || /(?:^|-)icon(?:-|$)/.test(el.tag) || iconFontName(el, page)) return true;
  if (!INLINE.has(el.tag)) return false;
  const t = visibleText(el, page);
  if (t && !hasArrow(t)) return false;
  if (t) return true;
  if (hasClassWord(el, ['icon', 'arrow', 'chevron', 'caret', 'lucide', 'fa', 'bi', 'material', 'symbols']) || ['data-icon', 'data-lucide', 'icon'].some((a) => a in el.attrs)) return true;
  const d = declsFor(el, page);
  return drawnChevron(d.map) || drawnShape(d.map) || ['before', 'after'].some((w) => drawnChevron(d.pseudo[w]) || drawnShape(d.pseudo[w]));
}
// A dot drawn with css: a round box of 8px or less with a fill.
const drawnDot = (m) => { const px = (p) => (m[p] ? pxValue(m[p].value) : null); return px('width') != null && px('width') <= 8 && px('height') != null && px('height') <= 8 && !!m['border-radius'] && !!(m.background || m['background-color']); };
const SPARKLE = /[✨✦✧✩✪✫✬✭✮✯✰✱✲✳✴✵✶✷✸✹✺✻✼✽❂❃❇❈❉❊❋⁂💫⭐🌟🌠🪄]/u;
const DOT_CHARS = '·•‧∙●◦⋅・･⦁\u0387\u2e31\u16eb';
// An emoji at the start of a string: a pictograph, a keycap (1️⃣) or a flag; not ©, ® or an arrow.
const emojiAt = (s) => /^(?:[0-9#*]\uFE0F?\u20E3|[\u{1F1E6}-\u{1F1FF}]{2}|(?![©®™‼⁉↔-↙↩↪⤴⤵])\p{Extended_Pictographic})/u.test(s);
const EMOJI_RUN = /(?:[0-9#*]\uFE0F?\u20E3|\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\u{1F1E6}-\u{1F1FF}]|\p{Emoji_Modifier}|[\uFE0F\u200D])+/gu;
const NUMBER_TOKEN = /^(?:#\s?)?[~≈<>+−-]?[$€£]?\d[\d,.]*\s?(?:%|x|×|\+|k|m|b|bn|mm|ms|s|h|hrs?|min|pts?|days?|weeks?|wks?|mo|yrs?|billion|million|thousand|trillion)?\+?(?:\s?(?:\/|of)\s?[\d,]+)?$/i;
// Abbreviations that end in a period inside a sentence: titles, places, months and days.
const ABBR = /(?:^|\s)(?:inc|ltd|co|corp|llc|jr|sr|dr|mr|mrs|ms|st|vs|etc|fig|approx|dept|est|mt|ave|blvd|rd|ln|hwy|apt|ste|prof|rev|hon|gen|gov|sen|rep|sgt|capt|lt|col|fr|vol|ch|sec|pp|ed|eds|ft|oz|lb|lbs|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|a\.m|p\.m|e\.g|i\.e|cf|al)\.$/i;

// --- the rules ------------------------------------------------------------------

const PAGE_RULES = [
  // words
  {
    id: 'page-subtitle', group: 'words',
    line: 'No line of supporting text right under a heading.',
    why: 'subtitle under a heading: the heading alone carries it, so cut the line. a heading followed by two or more paragraphs of prose (a paragraph of two sentences or twenty words, then another) is an article and passes',
    fix: 'delete the supporting line, or make it the content itself',
    said: SAID.subtitle,
    check(ctx, hit) {
      const { page } = ctx;
      const ROLE = ['sub', 'subtitle', 'subhead', 'subheading', 'lede', 'lead', 'tagline', 'kicker', 'desc', 'description', 'caption', 'intro', 'summary', 'why', 'meta', 'eyebrow'];
      const items = flow(page);
      const rank = (it) => (it.big ? 1 : +it.el.tag[1] || 2);
      const isParagraph = (it) => it && it.kind === 'text' && (it.el.tag === 'p' || it.el.tag === 'blockquote' || inside(it.el, new Set(['blockquote'])));
      for (let i = 0; i < items.length; i++) {
        const h = items[i];
        if (h.kind !== 'heading' || rank(h) > 3) continue;
        const next = items[i + 1], after = items[i + 2];
        if (!next) continue;
        // a lower heading right under the h1 that has nothing of its own under it
        if (next.kind === 'heading' && rank(h) === 1 && rank(next) > 1 && !next.big && (!after || ['action', 'nav'].includes(after.kind) || (after.kind === 'heading' && rank(after) <= rank(next)))) {
          hit(next.line, next.text);
          continue;
        }
        if (next.kind !== 'text' || !/\p{L}{2}/u.test(next.text)) continue;
        // the element right after the heading names the role, whether it is the line or wraps it
        const sib = nextEl(h.el, page);
        if (hasClassWord(next.el, ROLE) || (sib && descendants(sib).includes(next.el) && hasClassWord(sib, ROLE))) { hit(next.line, next.text); continue; }
        // a paragraph, not a stat made of label pieces: a p, its own running text, or one inline piece
        if (!next.paragraph) continue;
        // two or more paragraphs of prose under a heading are the content, not a subtitle
        const prose = (it) => (it.text.match(/[.!?](?:\s|$)/g) || []).length >= 2 || words(it.text).length >= 20;
        // under an h1, short paragraphs that lead into a call to action are a hero line, not an article
        const run = items.slice(i + 1).findIndex((it) => !isParagraph(it));
        const leadsToAction = run >= 0 && items[i + 1 + run].kind === 'action';
        const article = rank(h) > 1 || words(next.text).length >= 20 || !leadsToAction;
        if (article && isParagraph(next) && isParagraph(after) && prose(next) && next.el.parent && descendants(next.el.parent).includes(after.el)) continue;
        if (rank(h) === 1) { hit(next.line, next.text); continue; }
        // a grid of blocks with their own headings after the line counts as content
        const grid = after && after.kind === 'heading' && rank(after) > rank(h) && ancestor(after.el, (a) => !descendants(a).includes(next.el) && kids(a, page).length >= 2 && /grid|flex/.test(displayOf(a, page)) && !/column/.test((declsFor(a, page).map['flex-direction'] || { value: '' }).value));
        if (after && (after.kind === 'content' || grid)) hit(next.line, next.text);
      }
    },
  },
  {
    id: 'page-explanatory', group: 'words',
    line: 'No text that talks about the page itself instead of being the content.',
    why: 'text about the page or a helper caption: the screen should explain itself. this catches named openers (this page, this section, here you can, use this to, welcome to, below is, tip:, click a row), helper classes and caption classes only. other self-talk can slip through',
    fix: 'cut the line, or replace it with the actual content it describes',
    said: SAID.explain,
    check(ctx, hit) {
      const { page } = ctx;
      const PART = '(?:page|section|screen|site|dashboard|view|report|table|chart|list|panel|tab|form|tool|app)';
      // the screen itself: this page, this screen, this section or this dashboard and whatever it does
      // (not "this section of the orchard"); other parts only with a verb that describes them
      const SELF = '(?:page|screen|section|dashboard)';
      // click and hover only happen on a screen; tap, drag and swipe also happen in a kitchen and need a screen thing after them
      const UI = '(?:row|rows|button|link|card|name|item|tab|icon|field|cell|column|header|chart|bar|tile|entry|box|dot|line|arrow)';
      const OPENER = new RegExp(`(?:^|[.!?:,;]\\s+)(this ${SELF}\\s+(?!of\\b|in\\b|on\\b|at\\b|from\\b|by\\b|and\\b|or\\b|was\\b|were\\b|had\\b)\\p{L}|this ${PART}\\s+(?:shows|lists|displays|contains|lets|gives|explains|covers|summari[sz]es|includes|helps|tracks|collects|walks|will|is (?:where|for|your|the|a|an|here))\\b|(?:on|in) this ${PART}\\b|here,? you(?:'ll| will)? (?:can|find|see)\\b|below,? you\\b|below (?:is|are)\\b|the following (?:list|table|items|steps|sections?|chart|shows|lists|is|are)\\b|use this (?:${PART} )?to\\b|welcome to\\b|as you can see\\b|everything (?:below|here|on this page)\\b|(?:pro )?(?:tip|hint|note|heads up):|(?:click|double-click|right-click|hover over) (?:a|an|the|on|any|each|here|and)\\b|(?:tap|drag|swipe) (?:on )?(?:(?:a|an|the|any|each) )?(?:\\p{L}+ )?${UI}\\b|tap here\\b)`, 'iu');
      for (const b of readText(page).blocks) {
        const m = OPENER.exec(b.text);
        if (m) hit(lineOf(b, m[1]), b.text.slice(m.index).trim());
      }
      // a caption or helper by its class: one line, not a repeated item such as a list of notes
      const LAYOUT = /^(?:tbl|table|img|image|fig|figure|photo|chart|card|grid|list|form|field|input|section)$/;
      for (const el of page.all) {
        if (!classList(el).length || isHidden(el, page) || ['a', 'button'].includes(el.tag) || inside(el, TABLE_PARTS)) continue;
        const names = classList(el).map((c) => c.toLowerCase());
        const w = classWords(el);
        // a -cap class names a caption when it follows a number, a picture or a table it describes
        const prior = prevEl(el, page);
        const describes = prior && (['img', 'picture', 'figure', 'table', 'svg', 'canvas', 'video'].includes(prior.tag) || NUMBER_TOKEN.test(visibleText(prior, page)));
        const capPart = names.some((c) => { const parts = c.split(/[-_]/); const i = parts.indexOf('cap'); return i > 0 && (LAYOUT.test(parts[i - 1]) || describes); });
        const named = capPart || names.some((c) => /^(?:form-text|help-block|helptext)$/.test(c)) || ['caption', 'hint', 'helper', 'help', 'note', 'explain', 'explainer'].some((x) => w.has(x));
        if (!named || !textOnly(el, page) || words(visibleText(el, page)).filter((x) => /\p{L}{2}/u.test(x)).length < 2) continue;
        const same = kids(el.parent, page).filter((k) => k !== el && k.attrs.class === el.attrs.class);
        if (same.length) continue;
        hit(el.line, visibleText(el, page));
      }
    },
  },

  {
    id: 'page-word-quiet', group: 'words',
    line: 'Never use the word quiet or quietly.',
    why: 'the word quiet: say what actually happens',
    fix: 'name the real effect, for example "no emails unless something breaks"',
    said: SAID.never,
    check(ctx, hit) {
      for (const b of readText(ctx.page).blocks) {
        const m = english(b.el) && /\bquiet(?:ly)?\b/i.exec(b.text);
        if (m) hit(lineOf(b, b.text.slice(m.index)), m[0]);
      }
    },
  },
  {
    id: 'page-word-real', group: 'words',
    line: 'Never use the word real on its own.',
    why: 'the word real: it promises without showing. real estate and real-time are fine, real-world and keep-it-real are not. a capitalised Real inside a name (El Camino Real) is a name, unless the whole line is set in title case',
    fix: 'drop the word or name the proof',
    said: SAID.never,
    check(ctx, hit) {
      for (const b of readText(ctx.page).blocks) {
        if (!english(b.el)) continue;
        const caps = (w) => /^\p{Lu}/u.test(w);
        // title case: every word capitalised but the small joining words
        const titleCase = words(b.text).filter((w) => /^\p{L}/u.test(w)).every((w) => caps(w) || /^(?:a|an|the|and|or|nor|but|for|of|to|in|on|at|by|with|as)$/.test(w));
        for (const m of b.text.matchAll(/\breal\b(?!(?:[\s\u00a0]+|[-\u2010\u2011])(?:estate|time)\b)/gi)) {
          // a place or a name: Real between other capitalised words in a sentence of lowercase words
          const before = b.text.slice(0, m.index).trimEnd();
          const prevWord = (/(\S+)$/.exec(before) || [])[1] || '';
          const nextWord = (/^\s*(\S+)/.exec(b.text.slice(m.index + 4)) || [])[1] || '';
          if (m[0] === 'Real' && !titleCase && before && !/[.!?:]$/.test(before) && (caps(prevWord) || caps(nextWord))) continue;
          hit(lineOf(b, b.text.slice(m.index)), b.text.slice(Math.max(0, m.index - 20), m.index + 30));
          break;
        }
      }
    },
  },
  {
    id: 'page-two-word-sentence', group: 'words',
    line: 'No one or two word sentences that end with a period.',
    why: 'a one or two word sentence: it reads as a slogan',
    fix: 'join it to the sentence next to it, or cut it',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      for (const b of readText(page).blocks) {
        if (TABLE_PARTS.has(b.el.tag) || inside(b.el, TABLE_PARTS) || b.el.tag === 'time' || inside(b.el, new Set(['pre', 'code']))) continue;
        if (b.attr) continue;
        // a citation ends on its publisher: Caro, R. (1974). The Power Broker. Knopf.
        if (/\(\d{4}[a-z]?\)\./.test(b.text) || b.el.tag === 'cite' || inside(b.el, new Set(['cite']))) continue;
        const text = b.text.replace(/[．。]/g, '.');
        const raw = text.split(/(?<=[.!?]["'”’)*†‡]*)\s+(?=\S)/);
        // join a piece that ends on an abbreviation, an initial or a number onto the next one
        // single letters (J. R., z. B.) and doubled capitals (EE. UU.) are abbreviations
        const joins = (last, next) => ABBR.test(last) || /\b[a-z]\.[a-z]\.$/i.test(last) || /(?:^|\s)\p{L}\.$/u.test(last) || /(?:^|\s)(\p{Lu})\1\.$/u.test(last) || /(?:^|\s)\d{1,2}\.$/.test(last) || (/(?:^|\s)no\.$/i.test(last) && /^\d/.test(next));
        const sentences = [];
        for (const s of raw) {
          const last = sentences[sentences.length - 1];
          if (last != null && joins(last, s)) sentences[sentences.length - 1] = `${last} ${s}`;
          else sentences.push(s);
        }
        for (const s of sentences) {
          const t = s.trim();
          if (!/[\p{L}\p{N}]\.["'”’)*†‡]*$/u.test(t)) continue;
          const w = words(t);
          if (w.length < 1 || w.length > 2) continue;
          if (ABBR.test(t) || /\b[a-z]\.[a-z]\.$/i.test(t) || /\d\.\d.*\.$/.test(t) || /^v?\d+(?:\.\d+)*\.$/i.test(t) || /^\p{Lu}\.$/u.test(t) || /^(\p{Lu})\1\.$/u.test(t)) continue;
          hit(lineOf(b, t), t);
        }
      }
    },
  },
  {
    id: 'page-dot-separator', group: 'words',
    line: 'No middle dots or bullets between words.',
    why: 'a dot used as a separator between words. a dot inside a word (col·legi) or between two single letters (a · b) is not a separator',
    fix: 'write it as a sentence, or put the items on their own lines',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      const re = new RegExp(`(\\S*)(\\s*)[${DOT_CHARS}](\\s*)(\\S*)`, 'gu');
      for (const b of readText(page).blocks) {
        for (const m of b.text.matchAll(re)) {
          const [, before, s1, s2, after] = m;
          if (!/[\p{L}\p{N})]$/u.test(before) || !/^[\p{L}\p{N}(]/u.test(after)) continue;
          if (!s1 && !s2) continue; // part of a word or formula
          if (m[0].includes('\u0387') && !(s1 && s2)) continue; // Greek ano teleia ending a clause
          const bare = (x) => x.replace(/[^\p{L}\p{N}]/gu, '');
          if (bare(before).length === 1 && bare(after).length === 1) continue; // an operator between two symbols
          if (/^\d+$/.test(bare(before)) && /^\d+$/.test(bare(after)) && b.text.includes('=')) continue; // multiplication in a sum
          hit(lineOf(b, b.text.slice(Math.max(0, m.index - 10))), b.text.slice(Math.max(0, m.index - 20), m.index + 30));
          break;
        }
      }
      const texty = (x) => x && /[\p{L}\p{N}]/u.test(visibleText(x, page));
      for (const el of page.all) {
        if (isHidden(el, page)) continue;
        // a dot in its own element, or a small round empty element, between two words
        const own = visibleText(el, page);
        const lone = own && new RegExp(`^[${DOT_CHARS}]$`, 'u').test(own) && !el.children.some((c) => c.type === 'el' && !INLINE.has(c.tag));
        // a small round box drawn with css, or a tiny svg of one circle
        const circle = el.tag === 'svg' && [el.attrs.width, el.attrs.height].every((x) => pxValue(x) != null && pxValue(x) <= 8) && descendants(el).length && descendants(el).every((x) => ['circle', 'ellipse'].includes(x.tag));
        const drawn = circle || (!own && !el.children.some((c) => c.type === 'el') && drawnDot(declsFor(el, page).map));
        // a dot in its own element, with a margin, between two runs of text
        const words2 = (x) => x && (x.type === 'text' ? /[\p{L}\p{N}]/u.test(x.text) : texty(x));
        const sibAt = (k) => { const all = el.parent ? el.parent.children.filter((c) => c.type === 'el' || c.text.trim()) : []; return all[all.indexOf(el) + k]; };
        if ((lone || drawn) && ((texty(prevEl(el, page)) && texty(nextEl(el, page))) || (words2(sibAt(-1)) && words2(sibAt(1))))) { hit(el.line, lone ? own : `<${el.tag}> drawn as a dot`); continue; }
        // the same dot drawn by css between items: on some siblings, not as a marker on every one
        const d = declsFor(el, page).pseudo;
        const dotty = (x, where) => new RegExp(`[${DOT_CHARS}]`, 'u').test(pseudoText(x, page, where)) || (!pseudoText(x, page, where).trim() && drawnDot(declsFor(x, page).pseudo[where]));
        for (const where of ['before', 'after']) {
          if (!d[where].content || !dotty(el, where)) continue;
          const sibs = kids(el.parent, page).filter((x) => x.tag === el.tag);
          const marked = sibs.filter((x) => declsFor(x, page).pseudo[where].content && dotty(x, where));
          if (marked.length < sibs.length && (where === 'before' ? prevEl(el, page) : nextEl(el, page))) { hit(d[where].content.line, `${where} content ${d[where].content.value}`); break; }
        }
      }
    },
  },

  {
    id: 'page-button-arrow', group: 'words',
    line: 'No arrows in buttons.',
    why: 'an arrow in a button or a button-like link: an arrow character, a chevron drawn with css, an arrow from an icon font, or an icon after the label. an icon-only button is not judged, since the check cannot see what an unnamed svg draws',
    fix: 'let the label carry it, for example "Book a fix"',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      for (const el of page.all) {
        if (isHidden(el, page) || !isButton(el, page)) continue;
        const label = el.tag === 'input' ? (el.attrs.value || '') : visibleText(el, page);
        if (hasArrow(label)) { hit(el.line, label); continue; }
        const d = declsFor(el, page);
        if (['before', 'after'].some((w) => drawnChevron(d.pseudo[w]))) { hit(el.line, `${label} with a chevron drawn by css`); continue; }
        // an icon drawn after the label: a cut or masked shape, or a glyph from an icon font
        const after = d.pseudo.after;
        if (label && after.content && (drawnShape(after) || /\\(?:e[0-9a-f]{3}|f[0-8][0-9a-f]{2})\b|[\ue000-\uf8ff]/i.test(after.content.value))) { hit(el.line, `${label} with an icon drawn after it`); continue; }
        const bg = (d.map['background-image'] || d.map.background || { value: '' }).value;
        if (label && /url\(/i.test(bg) && /\bright\b|\b(?:9\d|100)%/i.test(`${bg} ${(d.map['background-position'] || { value: '' }).value}`)) { hit(el.line, `${label} with an icon painted on its right edge`); continue; }
        // the last thing drawn inside, after the label text: an icon element or an arrow from an icon font
        const leaves = [];
        const walk = (n) => {
          for (const c of n.children) {
            if (c.type === 'text') { if (c.text.trim()) leaves.push(c); continue; }
            if (isHidden(c, page)) continue;
            if (iconLike(c, page)) { leaves.push(c); continue; }
            walk(c);
          }
        };
        walk(el);
        if (/row-reverse/.test((d.map['flex-direction'] || d.map['flex-flow'] || { value: '' }).value)) leaves.reverse();
        // flex order and a float to the right move a leaf to the end of the row
        const place = (c) => (c.type !== 'el' ? 0 : /right|inline-end/.test((declsFor(c, page).map.float || { value: '' }).value) ? Infinity : parseFloat((declsFor(c, page).map.order || { value: '0' }).value) || 0);
        leaves.sort((a, b) => place(a) - place(b));
        const last = leaves[leaves.length - 1];
        const textBefore = leaves.slice(0, -1).some((c) => c.type === 'text' || (c.type === 'el' && visibleText(c, page) && !iconFontName(c, page)));
        if (last && last.type === 'el' && textBefore) {
          const lig = iconFontName(last, page);
          if (!lig || /arrow|chevron|east|navigate_next|forward|trending_flat|north_east|open_in_new|launch/.test(lig)) hit(last.line, `${label} <${last.tag}>`);
        }
      }
    },
  },

  {
    id: 'page-sparkle', group: 'words',
    line: 'No sparkle or star-burst icons.',
    why: 'a sparkle icon: it says magic instead of showing the work. icons are caught by character, name, title or icon-font name, not by the shape an unnamed svg draws. a plain star in a rating (4.8 ★) is data',
    fix: 'remove the icon',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      for (const b of readText(page).blocks) {
        // a plain star (★ ☆) is a sparkle unless it is a rating: a row of stars or a star by a number
        const star = [...b.text.matchAll(/[★☆]/g)].find((x) => !/[★☆]|\d/.test(b.text.slice(Math.max(0, x.index - 3), x.index) + b.text.slice(x.index + 1, x.index + 4)));
        const m = SPARKLE.exec(b.text) || star;
        if (m) hit(lineOf(b, m[0]), m[0]);
      }
      const NAME = /(?:^|[^a-z])(?:sparkles?|stars|magic|wand|auto[-_]awesome)(?:[^a-z]|$)/i;
      const split = (x) => String(x).replace(/([a-z])([A-Z])/g, '$1-$2');
      for (const el of page.all) {
        if (isHidden(el, page) || inside(el, new Set(['head']))) continue;
        const lig = iconFontName(el, page);
        if (lig && NAME.test(lig)) { hit(el.line, lig); continue; }
        // an icon: an icon tag, a custom element or an empty span, or a wrapper that holds only an icon
        const empty = !visibleText(el, page);
        const iconTag = ICON_TAGS.has(el.tag) || el.tag === 'use' || /(?:^|-)icon(?:-|$)/.test(el.tag) || (el.tag.includes('-') && empty);
        const wrapper = empty && kids(el, page).length > 0 && kids(el, page).every((k) => ICON_TAGS.has(k.tag) || k.tag.includes('-'));
        const iconish = iconTag || wrapper || (el.tag === 'span' && empty) || 'data-lucide' in el.attrs || 'data-icon' in el.attrs;
        if (!iconish) continue;
        // a photo of stars is not an icon: an img counts by its file name only when it is icon sized or an svg
        const src = el.tag === 'img' && !(smallIcon(el, page) || /\.svg\b/i.test(el.attrs.src || '')) ? '' : el.attrs.src;
        // an svg named by its own title, directly or through aria-labelledby
        const titled = el.tag === 'svg' ? [...descendants(el).filter((d) => d.tag === 'title'), ...(el.attrs['aria-labelledby'] || '').split(/\s+/).map((id) => page.all.find((x) => id && x.attrs.id === id)).filter(Boolean)].map((t) => t.children.map((c) => c.text || '').join(' ')) : [];
        const names = [el.tag.includes('-') ? el.tag : '', el.attrs.class, el.attrs.id, el.attrs.href, el.attrs['xlink:href'], el.attrs['aria-label'], el.attrs['data-lucide'], el.attrs['data-icon'], el.attrs['data-name'], el.attrs.title, el.attrs.icon, el.attrs.name, src, ...titled]
          .filter(Boolean).map(split).join(' ');
        if (NAME.test(names)) hit(el.line, names);
      }
      // an icon painted as a background image: an svg, or a picture on an icon sized element; a photo
      // shown as a labelled picture (role img or an aria-label) is not an icon
      for (const d of lookDecls(page)) {
        const u = /url\(\s*["']?([^)"']*)/i.exec(d.value);
        if (!/^(?:background(?:-image)?|mask(?:-image)?|-webkit-mask(?:-image)?|list-style(?:-image)?|content)$/.test(d.prop) || !u || !NAME.test(split(u[1].split('/').pop()))) continue;
        const els = targets(d, page);
        const picture = els.length && els.every((el) => el.attrs.role === 'img' || el.attrs['aria-label']);
        const small = /\.svg\b/i.test(u[1]) || !/^background/.test(d.prop) || (d.rule && d.rule.selector && /::?(?:before|after)/.test(d.rule.selector)) || els.some((el) => { const m = declsFor(el, page).map; return pxValue((m.width || { value: '' }).value) != null && pxValue(m.width.value) <= 64; });
        if (!picture && small) { hit(d.line, `${d.prop}: ${d.value}`); break; }
      }
    },
  },

  {
    id: 'page-label-above-heading', group: 'words',
    line: 'No small label, tag or pill right above a heading.',
    why: 'a label above the heading, written there or moved there by the layout: the heading says it. a row of links (breadcrumbs, tabs), a status message and a page banner are not labels',
    fix: 'cut the label; if it matters, put it in the heading',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      const ROLE = ['eyebrow', 'kicker', 'overline', 'pill', 'badge', 'tag', 'chip', 'label'];
      const short = (t) => words(t).length <= 6 && t.length <= 48;
      for (const h of page.all) {
        if (!(/^h[12]$/.test(h.tag) || (!HEADING.test(h.tag) && headingLike(h, page))) || isHidden(h, page)) continue;
        // a small line drawn as a block inside the heading, before its words
        const firstKid = h.children.find((c) => (c.type === 'text' ? c.text.trim() : !isHidden(c, page)));
        if (firstKid && firstKid.type === 'el' && h.children.slice(h.children.indexOf(firstKid) + 1).some((c) => (c.type === 'text' ? c.text.trim() : visibleText(c, page))) && (!INLINE.has(firstKid.tag) || firstKid.tag === 'small' || displayOf(firstKid, page) === 'block') && short(visibleText(firstKid, page))) {
          hit(firstKid.line, visibleText(firstKid, page));
          continue;
        }
        // a short line its ::before draws as a block above its words
        const before = declsFor(h, page).pseudo.before;
        if (before.display && /^(?:block|flex|grid)/.test(before.display.value) && /\p{L}/u.test(pseudoText(h, page, 'before')) && short(pseudoText(h, page, 'before'))) { hit(before.content ? before.content.line : h.line, pseudoText(h, page, 'before')); continue; }
        // a short line written after the heading but shown above it by the layout
        const moved = shownAbove(h, page);
        if (moved && short(visibleText(moved, page)) && textOnly(moved, page)) { hit(moved.line, visibleText(moved, page)); continue; }
        // the heading may sit first in a wrapper: the label is then the wrapper's neighbour
        let at = h;
        while (!prevEl(at, page) && at.parent && at.parent.tag !== '#root' && at.parent.tag !== 'body' && kids(at.parent, page)[0] === at) at = at.parent;
        const prev = prevEl(at, page);
        if (!prev || ['nav', 'img', 'svg', 'picture', 'input', 'section', 'article', 'main', 'footer', 'form', 'table'].includes(prev.tag)) continue;
        // a header or a button counts only as a line of text: a disabled button is a label, not an action
        // a header right beside the heading is its label; a header before the wrapper is the page banner
        if ((prev.tag === 'header' && (!textOnly(prev, page) || at !== h)) || (prev.tag === 'button' && !('disabled' in prev.attrs))) continue;
        if (/^(?:status|alert|log)$/.test(prev.attrs.role || '') || 'aria-live' in prev.attrs) continue;
        const text = visibleText(prev, page);
        if (!text) continue;
        const links = [prev, ...descendants(prev)].filter((d) => d.tag === 'a');
        if (links.length >= 2) continue; // a row of links is navigation
        const role = hasClassWord(prev, ROLE) || (kids(prev, page).length > 0 && kids(prev, page).every((k) => hasClassWord(k, ROLE)));
        if (HEADING.test(prev.tag)) {
          if (role || (HEADING.test(h.tag) && +prev.tag[1] > +h.tag[1] + 1 && short(text))) hit(prev.line, text);
          continue;
        }
        // first among the parent's children that carry text, so a logo before it does not count
        const texty = kids(at.parent, page).filter((k) => visibleText(k, page));
        const first = texty[0] === prev;
        const list = ['ul', 'ol'].includes(prev.tag) && kids(prev, page).length === 1;
        if ((first && short(text) && (textOnly(prev, page, { icons: true }) || list)) || role) hit(prev.line, text);
      }
    },
  },

  {
    id: 'page-headline-accent', group: 'words',
    line: 'No single word styled differently inside a headline.',
    why: 'part of the headline in italics, a slant, or another font. a heading set wholly in one style is fine',
    fix: 'set the whole headline in one style',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      const SAME = /^(?:inherit|unset|revert)$/i;
      // a custom element styles itself from inside: the :host rule its script defines
      const hostDecls = (tag) => {
        for (const sc of page.scripts) {
          const at = sc.text.search(new RegExp(`define\\(\\s*["'\`]${tag}["'\`]`));
          const host = at >= 0 && /:host\s*\{([^}]*)\}/.exec(sc.text.slice(at));
          if (host) return Object.fromEntries(((cssRules(`x{${host[1]}}`)[0] || { decls: [] }).decls).map((d) => [d.prop, d]));
        }
        return {};
      };
      // the family named in a font shorthand: what follows the size
      const familyOf = (m) => {
        if (m['font-family'] && !SAME.test(m['font-family'].value.trim())) return m['font-family'].value.trim();
        const f = m.font && /\d[\d.]*(?:px|em|rem|%|pt)(?:\s*\/\s*\S+)?\s+(.+)$/.exec(m.font.value);
        return f ? f[1].trim() : '';
      };
      for (const h of page.all) {
        const top = /^h[12]$/.test(h.tag) || (h.attrs.role === 'heading' && /^[12]$/.test(h.attrs['aria-level'] || '2')) || (!HEADING.test(h.tag) && headingLike(h, page));
        if (!top || isHidden(h, page)) continue;
        const hm = declsFor(h, page).map;
        const whole = visibleText(h, page).replace(/\s+/g, '');
        for (const d of descendants(h)) {
          const t = visibleText(d, page);
          if (!/\p{L}/u.test(t) || isHidden(d, page) || iconFontName(d, page) || codeLike(d, page)) continue; // a command name in code is not an accent
          if (t.replace(/\s+/g, '') === whole) continue; // the whole heading in one style
          const m = d.tag.includes('-') ? { ...hostDecls(d.tag), ...declsFor(d, page).map } : declsFor(d, page).map;
          const v = (p) => (m[p] ? m[p].value.toLowerCase() : '');
          const style = m['font-style'] ? v('font-style') : (['em', 'i', 'cite', 'var', 'dfn'].includes(d.tag) ? 'italic' : '');
          const fam = familyOf(m);
          const family = fam && fam !== familyOf(hm) ? fam : '';
          const slant = /italic|oblique/.test(v('font')) || /["'](?:slnt|ital|casl)["']\s*-?[1-9]/i.test(v('font-variation-settings')) || /skew/.test(v('transform'));
          if (/italic|oblique/.test(style) || family || slant) { hit(d.line, t); break; }
        }
      }
    },
  },

  {
    id: 'page-numbered-sections', group: 'words',
    line: 'No decorative numbers like 01, 02 in front of sections.',
    why: 'numbered section labels: the order is already on the page. times, dates, versions, ranks and numbered terms the text refers back to are not decoration',
    fix: 'drop the numbers',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      const found = [];
      const MONTH = /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/i;
      // the number a label opens with: 01, 1., #1, Step 1, (1), a circled digit or a roman numeral before a mark
      const prefix = (text) => {
        let m = /^[①-⑳]/.exec(text);
        if (m) return { n: m[0].charCodeAt(0) - 0x245f, zero: false };
        m = /^(I{1,3}|IV|VI{0,3}|IX|X)\s*(?:[./:)—–-]|\s\/)\s*\p{L}/u.exec(text);
        if (m) return { n: ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'].indexOf(m[1]) + 1, zero: false };
        m = /^(?:(?:step|phase|stage|part)\s+)?(?:#\s?|\/\s?)?[([]?(0?)(\d{1,2})(?![\d:.,]\d)[)\]]?(?:\s*[./)·:—–-]\s*|\s+\/\s*|\s+(?=\S)|(?=\p{Lu}))/iu.exec(text);
        if (!m) return null;
        const rest = text.slice(m[0].length);
        if (MONTH.test(rest) || /^(?:am|pm|a\.m|p\.m|%|x\b|k\b|min|hours?|days?|weeks?|years?)/i.test(rest)) return null;
        return { n: +m[2], zero: !!m[1], step: /^\p{L}/u.test(m[0]) };
      };
      const LONE = /^(?:#\s?)?(0?)(\d{1,2})\.?$/;
      const beside = (el) => [prevEl(el, page), nextEl(el, page)].find((x) => x && /\p{L}/u.test(visibleText(x, page)));
      // beside a heading, or beside a section block that opens with a short title line
      const besideHeading = (el) => {
        const x = beside(el);
        if (!x) return false;
        if (HEADING.test(x.tag) || descendants(x).some((d) => HEADING.test(d.tag))) return true;
        const k = kids(x, page);
        return k.length >= 2 && textOnly(k[0], page) && words(visibleText(k[0], page)).length <= 8;
      };
      for (const el of page.all) {
        if (isHidden(el, page)) continue;
        const text = visibleText(el, page);
        if (!text) continue;
        const heading = HEADING.test(el.tag);
        // a number alone in its own element: 01 anywhere, or any number beside a heading
        const alone = LONE.exec(text);
        if (alone && !heading && !kids(el, page).length) {
          const row = TABLE_PARTS.has(el.tag) ? ancestor(el, (a) => a.tag === 'tr') : null;
          const tableHeading = row && descendants(row).some((d) => HEADING.test(d.tag));
          const firstInLine = el.parent && el.parent.children.find((c) => (c.type === 'text' ? c.text.trim() : true)) === el && /\p{L}/u.test(visibleText(el.parent, page).replace(text, ''));
          if (tableHeading || (!inside(el, TABLE_PARTS) && (besideHeading(el) || (alone[1] && (beside(el) || firstInLine))))) found.push({ n: +alone[2], el, text: `${text} ${visibleText(el.parent, page).replace(text, '').trim()}` });
          continue;
        }
        if (el.tag === 'li' || TABLE_PARTS.has(el.tag) || inside(el, TABLE_PARTS)) continue;
        const label = !heading && textOnly(el, page) && words(text).length <= 6;
        if (!heading && !label) continue;
        if (ancestor(el, (a) => HEADING.test(a.tag))) continue;
        const p = prefix(text);
        if (!p) continue;
        if (!heading && !p.zero && !p.step && /^\d{1,2}\s*\p{L}/u.test(text)) continue;
        found.push({ n: p.n, el, text });
      }
      // numbers the text refers back to (see section 3) are part of the content
      const all = readText(page).blocks.map((x) => x.text).join(' ');
      const cited = (n) => new RegExp(`\\b(?:section|clause|part|article|item|paragraph)s?\\s+${n}\\b`, 'i').test(all);
      if (found.some((f) => cited(f.n))) found.length = 0;
      for (let i = 0; i < found.length; i++) {
        const next = found.slice(i + 1, i + 4).find((f) => f.n === found[i].n + 1);
        if (next) { hit(found[i].el.line, `${found[i].text.slice(0, 30)} / ${next.text.slice(0, 30)}`); return; }
      }
      // numbering drawn by css: a counter on a heading or on a block that holds or sits by one (or opens
      // with a bold title), a counter in a list marker, or 01 list markers from a padded counter style
      const padded = sheetFor(page).rules.filter((r) => r.at === 'counter-style' && r.decls.some((d) => (d.prop === 'pad' && /^\s*[2-9]\s+["']0["']/.test(d.value)) || (d.prop === 'system' && /decimal-leading-zero/.test(d.value)))).map((r) => r.selector);
      const zeroStyle = (ls) => /decimal-leading-zero/.test(ls) || padded.some((n) => new RegExp(`(?:^|\\s)${n.replace(/[^\w-]/g, '')}(?:\\s|$)`).test(ls));
      const boldTitle = (x) => { const first = x.children.find((c) => (c.type === 'text' ? c.text.trim() : !isHidden(c, page))); return !!first && first.type === 'el' && (['b', 'strong'].includes(first.tag) ? words(visibleText(first, page)).length <= 8 : boldTitle(first)); };
      for (const el of page.all) {
        if (isHidden(el, page)) continue;
        const near = HEADING.test(el.tag) || kids(el, page).some((k) => HEADING.test(k.tag)) || (nextEl(el, page) && HEADING.test(nextEl(el, page).tag)) || boldTitle(el);
        const p = declsFor(el, page).pseudo;
        for (const where of ['before', 'after', 'marker']) {
          if (near && p[where].content && /counters?\(/.test(p[where].content.value)) { hit(p[where].content.line, p[where].content.value); return; }
        }
        const m = declsFor(el, page).map;
        const ls = `${m['list-style'] ? m['list-style'].value : ''} ${m['list-style-type'] ? m['list-style-type'].value : ''}`;
        if (zeroStyle(ls) && ['ol', 'ul', 'li'].includes(el.tag)) { hit(el.line, `list-style: ${ls.trim()}`); return; }
      }
    },
  },

  {
    id: 'page-all-caps', group: 'words',
    line: 'No text shown in capitals.',
    why: 'all caps reads as shouting, whether styled (uppercase, small caps) or typed',
    fix: 'use sentence case',
    said: SAID.caps,
    check(ctx, hit) {
      const { page } = ctx;
      for (const el of page.all) {
        if (isHidden(el, page)) continue;
        const shown = visibleText(el, page) || (el.tag === 'input' && /^(?:submit|button|reset)$/i.test(el.attrs.type || '') ? el.attrs.value || '' : '');
        if (!/\p{L}/u.test(shown)) continue;
        const m = declsFor(el, page).map;
        const v = (p) => (m[p] ? m[p].value : '');
        const tt = /uppercase/i.test(v('text-transform')) || /uppercase/i.test((declsFor(el, page).pseudo['first-line']['text-transform'] || { value: '' }).value);
        const sc = /small-caps|petite-caps/i.test(v('font-variant') + v('font')) || /small-caps|all-small|all-petite|petite/i.test(v('font-variant-caps')) || /["'](?:c2sc|smcp|c2pc|pcap)["']/i.test(v('font-feature-settings'));
        if (tt || sc) hit(el.line, shown);
      }
      const ok = CAPS_OK();
      const ROMAN = /^M{0,4}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/;
      for (const b of readText(page).blocks) {
        if (b.el.tag === 'td' || inside(b.el, new Set(['td']))) continue; // a ticker or a code in a table cell is data
        const word = /(?<![\p{L}\p{N}])(\p{Lu}{4,})\d*(?![\p{L}])/gu;
        let w, found = null;
        while ((w = word.exec(b.text))) if (!ok.has(w[1]) && !ROMAN.test(w[1])) { found = w[0]; break; }
        // a shouted phrase of short words, like TRY IT NOW
        const phrase = !found && /(?<![\p{L}])\p{Lu}{2,}(?:\s+\p{Lu}{2,}){2,}(?![\p{L}])/u.exec(b.text);
        if (phrase && !phrase[0].split(/\s+/).every((x) => ok.has(x))) found = phrase[0];
        if (found) hit(lineOf(b, found), found);
      }
    },
  },

  {
    id: 'page-emoji-icon', group: 'words',
    line: 'No emoji used as icons.',
    why: 'an emoji standing in for an icon: first in a heading, item, button, link or line of text, or alone beside a heading. an emoji in a table cell is data',
    fix: 'remove it, or use a drawn icon from the design library',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      for (const el of page.all) {
        if (isHidden(el, page) || TABLE_PARTS.has(el.tag) && !/\p{L}/u.test(visibleText(el, page)) || inside(el, TABLE_PARTS) && !/\p{L}/u.test(visibleText(el, page))) continue;
        const submit = el.tag === 'input' && /^(?:submit|button|reset)$/i.test(el.attrs.type || '');
        const text = submit ? (el.attrs.value || '').trim() : visibleText(el, page);
        if (!text) continue;
        const lead = submit || HEADING.test(el.tag) || ['li', 'button', 'a', 'dt', 'summary', 'td', 'th'].includes(el.tag) || textOnly(el, page);
        const startsEmoji = emojiAt(text.replace(/^["'“”‘’«(\[]+/, ''));
        const alone = !submit && textOnly(el, page) && !text.replace(/\s/g, '').replace(EMOJI_RUN, '');
        // the block after it opens with a heading: the emoji is that heading's icon
        const opensWithHeading = (x) => !!x && (HEADING.test(x.tag) || (kids(x, page).length > 0 && opensWithHeading(kids(x, page)[0])));
        const iconSpot = INLINE.has(el.tag) || opensWithHeading(nextEl(el, page));
        if (alone ? iconSpot : lead && startsEmoji) hit(el.line, text.slice(0, 20));
      }
    },
  },

  {
    id: 'page-placeholder', group: 'words',
    line: 'No lorem ipsum or placeholder text.',
    why: 'placeholder copy left on the page: filler latin, "text goes here", template marks like {{name}} or [Company name], TBD, or a sample name or address',
    fix: 'write the real words or remove the block',
    said: SAID.explain,
    check(ctx, hit) {
      const { page } = ctx;
      const re = PLACEHOLDER();
      // filler latin anywhere in a block, single or double brace template marks, a short [Company name],
      // TBD standing as a whole value, TKTK and sample addresses
      const LEFTOVER = /^lorem ipsum\b|\blorem ipsum (?:dolor|sed|amet|consectetur|adipiscing|elit|do|eiusmod|tempor|ut|labore|et)\b|\bsed ut perspiciatis\b|\bperspiciatis unde omnis\b|\beiusmod tempor\b|\bincididunt ut labore\b|\bnemo enim ipsam\b|\{\{\s*[\w.-]+\s*\}\}|\{\s*[a-z][\w.]{2,}\s*\}|\[(?:company|business|product|first|last|full|your|insert|year|date|city|name|title|headline|phone|email|address|client|customer)\b(?:\s+[\w]+){0,2}\]|(?:^|:\s*)TBD\.?$|\bTKTK\b|\b(?:example|test|name|user|email|your\.?name)@(?:email|example|domain|company|yourcompany)\.com\b/i;
      // a pseudonym in a case name (John Doe v. the county) is the record, not a sample name
      const caseName = (t, m) => /^\s*vs?\.\s/.test(t.slice(m.index + m[0].length)) || /\bvs?\.\s+$/.test(t.slice(0, m.index));
      for (const b of readText(page).blocks) {
        if (b.attr || b.field) continue;
        const r = re.exec(b.text);
        const m = r && !(/doe$/i.test(r[0]) && caseName(b.text, r)) ? r : LEFTOVER.exec(b.text);
        if (m) hit(lineOf(b, m[0]), m[0]);
      }
    },
  },

  {
    id: 'page-unsourced-number', group: 'words',
    line: 'No big statistic without a named source next to it.',
    why: 'a number shown as a statistic with no source named. this proves a source is named, not that the number is true',
    fix: 'add a cite element, a data-source or a Source: line next to the number, or drop the number',
    said: SAID.numbers,
    check(ctx, hit) {
      const { page } = ctx;
      const NO = new Set(['form', 'button', 'nav', 'time', 'code', 'pre', 'select', 'option', 'label', 'footer']);
      const CLAIM = /%|percent|\d\s?[x×](?![\w])|\+|\d\s?(?:k|m|b|bn)\b|billion|million|thousand|trillion|^#\d/i;
      // a price: a label that opens with how often it is paid, or says it is paid, billed or charged
      const PRICE_UNIT = /^(?:a|an|per|each|every|\/)\s*(?:month|mo|year|yr|seat|user|person|team|week|day|hour)\b|^(?:monthly|yearly|annually|one time|once|billed|forever|plus tax|incl)|\b(?:paid|billed|charged)\s+(?:once|monthly|yearly|annually|up front|each|every|per|a)\b/i;
      const DATE = /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?$/i;
      const big = (el) => { for (let a = el; a && a.tag !== '#root'; a = a.parent) { const f = declsFor(a, page).map['font-size']; if (f) return pxValue(f.value) >= 24 || /x+-large|xxx/.test(f.value); } return HEADING.test(el.tag); };
      // a big number with one word beside it: 3x faster, Top 1%, Over 10k
      const token = (t, el) => NUMBER_TOKEN.test(t) || (big(el) && words(t).length === 2 && (/^[$€£]?\d[\d,.]*\s?(?:%|x|\+)?\s+\p{L}+$/u.test(t) || /^\p{L}+\s+[$€£]?\d[\d,.]*\s?(?:%|x|\+|k|m|b)?\+?$/iu.test(t)));
      for (const el of page.all) {
        if (isHidden(el, page) || NO.has(el.tag) || inside(el, NO)) continue;
        if (HEADING.test(el.tag)) {
          const text = visibleText(el, page);
          if (/\d(?:\.\d+)?\s?(?:%|percent\b)|\b\d+(?:\.\d+)?\s?[x×](?![\w])|\b(?:two|three|four|five|six|seven|eight|nine|ten|twice|\d+)\s+times\s+(?:faster|more|less|better|cheaper|higher|lower|quicker)\b/i.test(text) && !hasSource(el, page)) hit(el.line, text);
          continue;
        }
        // the number: the element's own text, or a number its ::before draws over its text
        let own = visibleText(el, page), label = '', at = el;
        const drawn = pseudoText(el, page, 'before').trim();
        if (drawn && NUMBER_TOKEN.test(drawn) && own.replace(drawn, '').trim()) { label = own.replace(drawn, '').trim(); own = drawn; }
        if (!own || !token(own, el) || kids(el, page).some((k) => !INLINE.has(k.tag))) continue;
        // a table cell is data with its column heading, unless it is set big as a claim: a stat band built as a table
        if (TABLE_PARTS.has(el.tag)) {
          if (!['td', 'th'].includes(el.tag) || !big(el) || !CLAIM.test(own)) continue;
          const row = el.parent, col = kids(row, page).indexOf(el);
          const rows = kids(row.parent, page);
          const near = [rows[rows.indexOf(row) + 1], rows[rows.indexOf(row) - 1]].map((r) => r && kids(r, page)[col]).find((c) => c && visibleText(c, page) && !NUMBER_TOKEN.test(visibleText(c, page)));
          if (near && !hasSource(ancestor(el, (a) => a.tag === 'table') || el, page)) hit(el.line, `${own} ${visibleText(near, page)}`.slice(0, 80));
          continue;
        }
        // not a statistic: a year, a time, a plain step number, a version
        if (/^(?:19|20)\d\d$/.test(own) || /^\d{1,2}:\d\d$/.test(own) || /^0\d\s?\/\s?0?\d+$/.test(own) || /^v?\d+\.\d+\.\d+$/.test(own)) continue;
        if (INLINE.has(el.tag) && displayOf(el, page) === 'inline' && el.parent && readText(page).blocks.some((b) => b.el === el.parent && words(b.text).length > 8)) continue; // a number inside a sentence
        if (!label) {
          // look up through wrappers that hold only the number
          while (at.parent && at.parent.tag !== '#root' && visibleText(at.parent, page) === own) at = at.parent;
          const sibs = kids(at.parent, page);
          const i = sibs.indexOf(at);
          const sibLabel = sibs.find((x) => x !== at && !HEADING.test(x.tag) && visibleText(x, page) && !token(visibleText(x, page), x));
          const parentRest = sibs.filter((x) => x !== at && (HEADING.test(x.tag) || token(visibleText(x, page), x))).reduce((t, x) => t.replace(visibleText(x, page), ''), visibleText(at.parent, page).replace(own, '')).trim();
          label = sibLabel ? visibleText(sibLabel, page) : (parentRest && words(parentRest).length <= 12 ? parentRest : '');
          if (!label) continue;
          // a label written before a plain number is a setting or a row (Seats 25); before an amount it is a
          // price or a total (Latte $4.50, Total $42.10). a big or bold count after its label still reads as a stat
          const labelFirst = sibLabel ? sibs.indexOf(sibLabel) < i : visibleText(at.parent, page).indexOf(own) > 0;
          const strong = ['b', 'strong'].includes(el.tag) || /^(?:[6-9]00|bold)/.test((declsFor(el, page).map['font-weight'] || { value: '' }).value);
          if (labelFirst && !CLAIM.test(own) && !big(el) && (!strong || /^[$€£]/.test(own))) continue;
        }
        if (DATE.test(label.split(/\s+/)[0]) && /^\d{1,2}$/.test(own)) continue;
        if (/^[$€£]/.test(own) && PRICE_UNIT.test(label)) continue;
        if (/^(?:0\d|\d)\.?$/.test(own) && !/^(?:out of|of|in)\b/i.test(label)) continue; // a step number, not 9 out of 10
        if (!hasSource(at, page)) hit(el.line, `${own} ${label}`.slice(0, 80));
      }
    },
  },


  // shape
  {
    id: 'page-card-grid', group: 'shape',
    line: 'No grid of three or more same-shaped cards, each with its own heading or icon.',
    why: 'a grid of matching cards: the reader skims all of them and reads none. cards are blocks laid out side by side or boxed, each opening with a heading, a bold title or an icon; stacked plain sections are not cards',
    fix: 'write it as one list or a few sentences, or a table if it is data',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      const NO = new Set(['select', 'datalist', 'table', 'thead', 'tbody', 'tr', 'head', 'svg', 'menu']);
      // a plain wrapper around one card is looked through
      const unwrap = (b) => { let x = b; while (kids(x, page).length === 1 && !x.children.some((c) => c.type === 'text' && c.text.trim())) x = kids(x, page)[0]; return x; };
      // a card opens with a heading (any level below the page title), a short line set wholly in bold, or an icon
      const lead = (b) => {
        const first = kids(b, page)[0];
        if (!first || kids(b, page).length < 2) return null;
        const heads = descendants(b).filter((d) => /^h[2-6]$/.test(d.tag));
        if (heads.length) return 'h';
        if (smallIcon(first, page) || (!['img', 'picture'].includes(first.tag) && iconLike(first, page))) return 'icon';
        const t = visibleText(first, page);
        if (textOnly(first, page) && t && [...t.replace(/\s/g, '')].length <= 2 && !/[\p{L}\p{N}]/u.test(t)) return 'icon';
        if (!t && descendants(first).some((d) => smallIcon(d, page))) return 'icon';
        const bold = (x) => ['b', 'strong'].includes(x.tag) || /^(?:[6-9]00|bold)/.test((declsFor(x, page).map['font-weight'] || { value: '' }).value);
        const strongKids = (x) => { const k = kids(x, page); return k.length === 1 && bold(k[0]) && visibleText(k[0], page) === visibleText(x, page); };
        if (t && words(t).length <= 6 && (bold(first) || strongKids(first) || (strongKids(first.children.length ? first : b)))) return 'h';
        return null;
      };
      const block = (k) => !HEADING.test(k.tag) && (!INLINE.has(k.tag) || displayOf(k, page) !== 'inline' || kids(k, page).some((x) => !INLINE.has(x.tag)));
      const laidOut = (p) => { const m = declsFor(p, page).map; return (m.display && /grid|flex/.test(m.display.value) && !/column/.test((m['flex-direction'] || { value: '' }).value)) || !!m['grid-template-columns'] || parseInt((m.columns || m['column-count'] || { value: '' }).value, 10) >= 2; };
      // the shape of a card is what it opens with, not its tag or class names
      const cardsOf = (p) => kids(p, page).filter(block).map((w) => { const b = unwrap(w); return { b, tag: b.tag, key: `${lead(b)}`, side: laidOut(p) || /inline-block|table-cell/.test(displayOf(w, page)) || /left|right/.test((declsFor(w, page).map.float || { value: '' }).value) }; })
        .filter((c) => c.key !== 'null' && (!['ul', 'ol'].includes(p.tag) || c.key === 'h'));
      const footer = (x) => x.tag === 'footer' || x.attrs.role === 'contentinfo';
      for (const parent of [page.root, ...page.all]) {
        if (NO.has(parent.tag) || isHidden(parent, page) || footer(parent) || ancestor(parent, footer)) continue;
        let cards = cardsOf(parent);
        // rows of cards: a grid split into rows of two still reads as one grid
        const rows = kids(parent, page).filter(block);
        if (cards.length < 3 && rows.length >= 2 && rows.every((r) => laidOut(r) && cardsOf(r).length >= 1)) cards = rows.flatMap(cardsOf);
        if (cards.length < 3) continue;
        const groups = new Map();
        for (const c of cards) { if (!groups.has(c.key)) groups.set(c.key, []); groups.get(c.key).push(c); }
        for (const [key, same] of groups) {
          if (same.length < 3) continue;
          // icon-led blocks of a few words read as cards even when stacked
          const short = key === 'icon' && !['ul', 'ol'].includes(parent.tag) && same.every((c) => words(visibleText(c.b, page)).length <= 60);
          if (short || same.every((c) => c.side) || same.every((c) => boxed(c.b, page))) { hit(parent.line, `${same.length} blocks shaped ${same[0].tag} with ${key === 'h' ? 'a heading' : 'an icon'}`); break; }
        }
      }
    },
  },

  {
    id: 'page-card-in-card', group: 'shape',
    line: 'No boxed element inside another boxed element.',
    why: 'a card inside a card: two frames around one thing. a page sheet or a coloured band with only a fill is not counted as the outer frame',
    fix: 'keep one box and drop the inner frame',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      for (const el of page.all) {
        // the inner box holds words or a picture; a link drawn as a button is a control, like a real button
        const holds = visibleText(el, page) || descendants(el).some((d) => ['img', 'picture', 'video', 'svg', 'canvas'].includes(d.tag));
        if (isHidden(el, page) || !holds || (isButton(el, page) && /^inline/.test(displayOf(el, page))) || !boxed(el, page)) continue;
        const outer = ancestor(el, (a) => { const b = boxedParts(a, page); return b && (b.border || b.shadow || b.radius); });
        if (outer) hit(el.line, `<${el.tag}> inside <${outer.tag}> (line ${outer.line})`);
      }
    },
  },

  {
    id: 'page-left-border', group: 'shape',
    line: 'No coloured bar on the left edge of a block.',
    why: 'a decorative left-edge bar, however it is drawn: a left border, a shadow, a gradient stop, a narrow first column or a ::before strip. a light grey rule between columns is a divider and a matching grey rule on both sides is a frame, not a bar',
    fix: 'remove the bar; let spacing or a heading group the block',
    said: SAID.bars,
    check(ctx, hit) {
      const { page } = ctx;
      for (const el of page.all) {
        if (isHidden(el, page) || ['html', 'body', 'hr'].includes(el.tag)) continue;
        const d = declsFor(el, page);
        const m = d.map;
        const v = (p) => (m[p] ? m[p].value.trim().toLowerCase() : '');
        const ln = (p) => (m[p] ? m[p].line : el.line);
        // the left side as the cascade leaves it, from every border form; a matching rule on the right
        // in grey or black makes a pair of side rules (a poem set between two lines), not a bar
        const each = borderSides(m);
        const drawnSide = (x) => x.w >= 2 && !/none|hidden/.test(x.style) && (barColour(x.colour) || x.colour === 'currentcolor' || !!v('border-image'));
        const L = each.left, R = each.right;
        if (drawnSide(L) && !(drawnSide(R) && R.w === L.w && R.colour === L.colour && colourNeutral(L.colour) !== false)) { hit(L.line || el.line, `border-left: ${L.w}px ${L.style} ${L.colour}`); continue; }
        // a hard edge of shadow on the left, inside or outside the box
        const bar = shadows(v('box-shadow')).find((sh) => Math.abs(sh.y) <= 2 && sh.blur <= 2 && sh.spread <= 0 && barColour(sh.colour) && ((sh.inset && sh.x >= 2) || (!sh.inset && sh.x <= -2)));
        if (bar) { hit(ln('box-shadow'), `box-shadow: ${v('box-shadow')}`); continue; }
        // a gradient that stops a few pixels from the left, or a solid strip sized to a few pixels on the left
        const bgv = `${v('background')} ${v('background-image')}`;
        const g = /linear-gradient\(\s*(?:to right|90deg)\s*,\s*([^,]+?)\s+(\d*\.?\d+(?:px|rem|em))\s*,\s*[^,]+?\s+(\d*\.?\d+(?:px|rem|em)?)\s*\)/.exec(bgv);
        if (g && pxValue(g[2]) >= 2 && pxValue(g[2]) <= 8 && pxValue(g[3]) <= pxValue(g[2]) && barColour(g[1])) { hit(ln(m.background ? 'background' : 'background-image'), `background: ${g[0]}`); continue; }
        const strip = /linear-gradient\(\s*([^,()]+|\w+\([^)]*\))\s*,\s*\1\s*\)/.exec(bgv);
        const size = (/\/\s*(\S+)\s+100%/.exec(bgv) || [])[1] || (/^(\S+)\s+100%/.exec(v('background-size')) || [])[1];
        if (strip && size && pxValue(size) >= 2 && pxValue(size) <= 8 && !/\bright\b/.test(bgv + v('background-position')) && /no-repeat|repeat-y/.test(bgv + v('background-repeat')) && barColour(strip[1])) { hit(ln(m.background ? 'background' : 'background-image'), `background: ${strip[0]} sized ${size}`); continue; }
        // a narrow first column or flex item holding nothing but paint: an empty element or the ::before
        const cols = (v('grid-template-columns') || (v('grid-template').split('/')[1] || '')).trim().split(/\s+/);
        const flex = /flex/.test(v('display')) && !/column/.test(v('flex-direction'));
        const first = kids(el, page)[0];
        const emptyPaint = (x) => x && !visibleText(x, page) && !kids(x, page).length && barColour(fillOf(declsFor(x, page).map));
        const narrowCol = cols.length >= 2 && /^\d*\.?\d+(?:px|rem|em)$/.test(cols[0]) && pxValue(cols[0]) >= 2 && pxValue(cols[0]) <= 8;
        if (narrowCol && /grid/.test(v('display')) && d.pseudo.before.content && barColour(fillOf(d.pseudo.before))) { hit(d.pseudo.before.content.line, `grid column of ${cols[0]} painted by ::before`); continue; }
        if (narrowCol && emptyPaint(first)) { hit(first.line, `grid column of ${cols[0]} painted ${fillOf(declsFor(first, page).map)}`); continue; }
        if (flex && emptyPaint(first) && pseudoBar(declsFor(first, page).map, true)) { hit(first.line, `<${first.tag}> drawn as a bar`); continue; }
        // an empty element pinned to the left edge as tall as the block
        if (!visibleText(el, page) && !kids(el, page).length && pseudoBar(m, false)) { hit(el.line, `<${el.tag}> drawn as a bar`); continue; }
        for (const where of ['before', 'after']) {
          const pm = d.pseudo[where];
          if (pseudoBar(pm, flex && where === 'before')) { hit((pm.width || pm['inline-size'] || pm.left || pm.inset || pm['border-left'] || pm.content).line, `::${where} bar on the left edge`); break; }
        }
      }
      // a bar a script sets on an element's style
      for (const d of lookDecls(page)) if (d.script && /^border-(?:left|inline-start)$/.test(d.prop) && sideBar(d.value.toLowerCase())) { hit(d.line, `${d.prop}: ${d.value} (set by a script)`); break; }
      // rules for elements a script builds at run time: their class names appear only in a script
      for (const { c, rule } of scriptOnly(page)) {
        const m = Object.fromEntries(rule.decls.map((x) => [x.prop, x]));
        if (c.pseudo) { if (pseudoBar(m)) hit(rule.line, rule.selector); continue; }
        for (const p of ['border-left', 'border-inline-start']) if (m[p] && sideBar(m[p].value.toLowerCase())) { hit(m[p].line, `${p}: ${m[p].value}`); break; }
      }
    },
  },


  // look
  {
    id: 'page-looping-motion', group: 'look',
    line: 'Nothing on the page loops forever.',
    why: 'an animation that never stops pulls the eye from the words: infinite, a repeat count that keeps it moving for a minute or more, an svg animation that repeats or restarts itself, a marquee, or a script that keeps changing a style on a timer or every frame',
    fix: 'remove the loop, or run the motion once',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      // a minute of motion is about how long a reader stays on a screen. a count that runs past it loops for them
      const seconds = (t) => { const x = /^(\d*\.?\d+)(ms|s)$/i.exec(t || ''); return x ? (+x[1] / (x[2].toLowerCase() === 'ms' ? 1000 : 1)) : null; };
      const forever = (d) => splitTop(d.value, ',').some(({ text }) => {
        const toks = text.trim().toLowerCase().split(/\s+(?![^(]*\))/);
        if (toks.some((tok) => tok === 'infinite' || /^calc\(\s*infinity\s*\)$/.test(tok))) return true;
        const count = toks.find((tok) => /^\d*\.?\d+(?:e\+?\d+)?$/.test(tok));
        if (!count) return false;
        const own = toks.map(seconds).find((x) => x != null);
        const ruleDur = d.rule && d.rule.decls.find((x) => /animation-duration$/.test(x.prop));
        const dur = d.prop.endsWith('iteration-count') ? seconds(ruleDur && ruleDur.value.trim()) : own;
        return +count * (dur || 1) >= 60;
      });
      for (const d of lookDecls(page)) {
        if (/^(?:-\w+-)?animation(?:-iteration-count)?$/.test(d.prop) && forever(d)) { hit(d.line, `${d.prop}: ${d.value}`); return; }
      }
      const begins = new Map(page.all.filter((el) => el.attrs.id && el.attrs.begin).map((el) => [el.attrs.id, el.attrs.begin]));
      for (const el of page.all) {
        if (el.tag === 'marquee' && !/^\d+$/.test(el.attrs.loop || '')) { hit(el.line, '<marquee>'); return; }
        if (!/^(?:animate(?:transform|motion|color)?|set)$/.test(el.tag)) continue;
        const runs = parseFloat(el.attrs.repeatcount) * (seconds(el.attrs.dur) || 1);
        if (/indefinite/i.test(el.attrs.repeatcount || '') || /indefinite/i.test(el.attrs.repeatdur || '') || runs >= 60 || (seconds(el.attrs.repeatdur) || 0) >= 60) { hit(el.line, `<${el.tag} repeatCount="${el.attrs.repeatcount || el.attrs.repeatdur}">`); return; }
        // two animations that start each other when they end
        const refs = [...(el.attrs.begin || '').matchAll(/([\w-]+)\.end\b/g)].map((m) => m[1]);
        if (refs.some((r) => r === el.attrs.id || (el.attrs.id && new RegExp(`\\b${el.attrs.id}\\.end\\b`).test(begins.get(r) || '')))) { hit(el.line, `<${el.tag} begin="${el.attrs.begin}">`); return; }
      }
      for (const sc of page.scripts) {
        const code = stripJsComments(sc.text);
        const at = (i) => sc.line + (code.slice(0, i).match(/\n/g) || []).length;
        let m = /iterations\s*[:=]\s*(?:Infinity|Number\.POSITIVE_INFINITY|\d*\.?\d+\s*\/\s*0(?![.\d])|\d*\.?\d+e\+?\d+)|\brepeat\s*:\s*-1\b|\byoyo\s*:\s*true[^}]*repeat\s*:\s*-1/.exec(code);
        if (m) { hit(at(m.index), m[0]); return; }
        // a timer or a frame loop that keeps changing how something looks
        const styles = /classList|className|\.style\b|\.animate\(|setAttribute\(\s*["'](?:class|style)/;
        const fns = [...code.matchAll(/function\s+([\w$]+)\s*\([^)]*\)\s*\{|(?:const|let|var)\s+([\w$]+)\s*=\s*(?:\([^)]*\)|[\w$]+)\s*=>\s*\{?/g)].map((f) => ({ name: f[1] || f[2], at: f.index, body: code.slice(f.index, f.index + 2000) }));
        for (const iv of code.matchAll(/setInterval\(\s*([\w$]+)?/g)) {
          const fn = iv[1] && fns.find((f) => f.name === iv[1]);
          if (styles.test(fn ? fn.body.slice(0, 600) : code.slice(iv.index, iv.index + 400))) { hit(at(iv.index), 'setInterval that changes a style'); return; }
        }
        for (const f of fns) {
          const esc = f.name.replace(/\$/g, '\\$');
          if (new RegExp(`requestAnimationFrame\\(\\s*${esc}\\s*\\)`).test(f.body)) { hit(at(f.at), `requestAnimationFrame(${f.name}) loop`); return; }
          if (new RegExp(`setTimeout\\(\\s*${esc}\\b`).test(f.body) && styles.test(f.body.slice(0, 600))) { hit(at(f.at), `setTimeout(${f.name}) loop`); return; }
        }
      }
    },
  },

  {
    id: 'page-scroll-fade', group: 'look',
    line: 'Sections do not fade or slide in on scroll.',
    why: 'content that appears on scroll hides the words until the reader moves: a scroll trigger (an observer, a scroll handler, a scroll timeline or a reveal library) together with content that starts hidden or is faded in by the script',
    fix: 'show the content from the start',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      const look = lookDecls(page);
      const lineAt = (sc, code, i) => sc.line + (code.slice(0, i).match(/\n/g) || []).length;
      // content that starts hidden: opacity 0, hidden, or pushed aside, on something with words in it
      const startsHidden = look.some((d) => !d.script && d.selector !== null && d.at !== 'keyframes' && !DYNAMIC_SEL.test(d.selector || '') &&
        ((d.prop === 'opacity' && /^0(?:\.0+)?$/.test(d.value.trim())) || (d.prop === 'visibility' && /^hidden$/.test(d.value.trim()))) &&
        targets(d, page).some((el) => visibleText(el, page) || el.tag === 'section'));
      for (const sc of page.scripts) {
        const code = stripJsComments(sc.text);
        // a reveal library: the whole point of these calls is content appearing on scroll
        const lib = /\bScrollReveal\s*\(|\bnew\s+WOW\b|\bAOS\.init\b|\bsal\s*\(|\bScrollTrigger\b|\bscrollReveal\b/.exec(code);
        if (lib) { hit(lineAt(sc, code, lib.index), lib[0]); return; }
        const trigger = /IntersectionObserver|addEventListener\(\s*['"]scroll['"]|\bonscroll\s*=|\bwhileInView\b|\buseInView\b/.exec(code);
        if (!trigger) continue;
        // the script fades or slides something: a style it sets, a visibility it turns on, or an animation it runs
        const fades = /\.style\.(?:opacity|transform)\s*=\s*[^;]*(?:opacity|translate|['"`]?[01](?:\.\d+)?['"`]?)|opacity\s*:\s*[01]\b|whileInView|\.style\.visibility\s*=|setProperty\(\s*["'](?:opacity|transform|translate|visibility)["']|\.animate\(\s*\[[^\]]*(?:opacity|translate|transform)/.test(code) && !/scale[XY]?\(/.test(code.slice(trigger.index));
        // a class or data attribute the script adds that a style rule turns visible: the reveal state of hidden content
        const added = [...code.matchAll(/classList\.(?:add|toggle|replace)\(\s*(["'`])([\w-]+)\1|className\s*\+?=\s*(["'`])\s*([\w-]+)/g)].map((m) => `\\.${m[2] || m[4]}(?![\\w-])`);
        const attrs = [...code.matchAll(/dataset\.([\w$]+)\s*=(?!=)|(?:setAttribute|toggleAttribute)\(\s*["'](data-[\w-]+)["']/g)].map((m) => `\\[${m[2] || `data-${m[1].replace(/[A-Z]/g, (x) => `-${x.toLowerCase()}`)}`}(?![\\w-])`);
        const changes = [...added, ...attrs].some((sel) => look.some((d) => d.selector && new RegExp(sel).test(d.selector) && ((d.prop === 'opacity' && !/^0(?:\.0+)?$/.test(d.value.trim())) || (d.prop === 'transform' && /none/.test(d.value)))));
        // the observed element itself is restyled (a class, a style, a data attribute written): the reveal
        // pattern; reading its data-src to load an image is not
        const observed = /IntersectionObserver/.test(trigger[0]);
        const onTarget = observed && /\.target\s*\.\s*(?:classList|className|style|setAttribute\(\s*["'](?:class|style|data-)|toggleAttribute|dataset\.[\w$]+\s*=(?!=))/.test(code);
        // a style a scroll handler sets counts only on content that starts hidden (a back-to-top link is not content)
        if ((fades && (observed || startsHidden)) || onTarget || (changes && startsHidden)) { hit(lineAt(sc, code, trigger.index), trigger[0]); return; }
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
    why: 'a glow or blurred blob behind content: a blur filter on something that is not a content image or a small blur over words, a radial-gradient wash, a soft coloured halo, or an svg blur or radial blob. a small dot pattern and a soft grey drop shadow are fine',
    fix: 'remove it and let the plain background show',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      const contentImage = (el) => ['img', 'video', 'picture', 'canvas'].includes(el.tag) && (el.attrs.alt || '').trim() && el.attrs['aria-hidden'] !== 'true';
      for (const d of lookDecls(page)) {
        const v = d.value;
        if (/^(?:-webkit-)?filter$/.test(d.prop)) {
          const b = /blur\(\s*(calc\([^)]*\)|[\d.]+)(px|rem|em)?/i.exec(v);
          const radius = b ? (/^calc/i.test(b[1]) ? 99 : pxValue(`${b[1]}${b[2] || 'px'}`)) : 0;
          if (radius > 0) {
            const els = targets(d, page);
            // a content image, or a small blur over words (a spoiler), is not a glow
            const benign = els.length && els.every((el) => contentImage(el) || (radius < 20 && visibleText(el, page)));
            const imgSel = !els.length && !d.el && /(?:^|[\s>+~])(?:img|video|picture|canvas)(?:[.#:\[]|$)/i.test((d.selector || '').split(',').pop());
            if (!benign && !imgSel) { hit(d.line, `${d.prop}: ${v}`); return; }
          }
          const ds = [...v.matchAll(/drop-shadow\(((?:[^()]|\([^()]*\))*)\)/gi)].map((x) => shadows(x[1])[0]).filter(Boolean);
          if (ds.length && glowShadows(ds)) { hit(d.line, `${d.prop}: ${v}`); return; }
          const u = /url\(\s*#([\w-]+)\s*\)/.exec(v);
          if (u && page.all.some((el) => el.attrs.id === u[1] && descendants(el).some((x) => x.tag === 'fegaussianblur' && parseFloat(x.attrs.stddeviation) >= 10))) { hit(d.line, `${d.prop}: ${v}`); return; }
          // an svg filter written inside a data url
          const inline = v.search(/data:image\/svg\+xml/i);
          const std = inline >= 0 && /feGaussianBlur[^>]*stdDeviation\s*=\s*\\?["']?([\d.]+)/i.exec(decodeURIComponent(v.slice(inline).replace(/%(?![0-9a-f]{2})/gi, '%25')));
          if (std && +std[1] > 0 && !targets(d, page).every((el) => contentImage(el))) { hit(d.line, `${d.prop}: a blur filter in a data url`); return; }
        }
        if (/^(?:background(?:-image)?|(?:-webkit-)?mask(?:-image)?)$/.test(d.prop) && /radial-gradient\(/i.test(v)) {
          // a repeating dot pattern: small tiles or a gradient of a few pixels
          const size = /\/\s*(\d+)px/.exec(v) || /(\d+)px/.exec((d.rule ? (d.rule.decls.find((x) => x.prop === 'background-size') || {}).value : '') || '');
          const tiny = /radial-gradient\([^)]*?\b[0-4](?:\.\d+)?px\b/i.test(v) && !/\b(?:[5-9]|\d{2,})%/.test(v.replace(/\d+px/g, ''));
          if (!(size && +size[1] <= 64) && !tiny) { hit(d.line, `${d.prop}: ${v}`); return; }
        }
        if (/^(?:box|text)-shadow$/.test(d.prop) && glowShadows(shadows(v))) { hit(d.line, `${d.prop}: ${v}`); return; }
      }
      // an svg blob filled with a radial gradient that fades out
      for (const el of page.all) {
        if (el.tag !== 'radialgradient' || !descendants(el).some((st) => st.tag === 'stop' && (/^0(?:\.0*)?$/.test(st.attrs['stop-opacity'] || '') || /transparent/.test(st.attrs['stop-color'] || '')))) continue;
        const id = el.attrs.id;
        const user = id && page.all.find((x) => ['circle', 'ellipse', 'rect', 'path'].includes(x.tag) && (x.attrs.fill || '').includes(`#${id}`));
        if (user) { hit(user.line, `<${user.tag} fill="${user.attrs.fill}">`); return; }
      }
      // svg filters: a wide blur anywhere; any blur, as in css, on a shape that uses it (a blur next to an
      // offset is a drop shadow); a coloured drop shadow centred on its shape (its stdDeviation is half a css blur)
      const usedOnShape = (id) => id && page.all.some((x) => ['circle', 'ellipse', 'rect', 'path', 'polygon', 'g', 'image'].includes(x.tag) && new RegExp(`url\\(\\s*["']?#${id}["']?\\s*\\)`).test(x.attrs.filter || (declsFor(x, page).map.filter || { value: '' }).value));
      for (const el of page.all) {
        const filter = ancestor(el, (a) => a.tag === 'filter');
        const std = parseFloat(el.attrs.stddeviation);
        if (el.tag === 'fegaussianblur' && (std >= 10 || (std > 0 && filter && usedOnShape(filter.attrs.id) && !descendants(filter).some((x) => x.tag === 'feoffset')))) { hit(el.line, `<feGaussianBlur stdDeviation="${el.attrs.stddeviation}">`); return; }
        if (el.tag === 'fedropshadow' && std > 0 && glowShadow({ x: parseFloat(el.attrs.dx) || 0, y: parseFloat(el.attrs.dy) || 0, blur: 2 * std, spread: 0, colour: el.attrs['flood-color'] || 'black' })) { hit(el.line, `<feDropShadow stdDeviation="${el.attrs.stddeviation}">`); return; }
      }
    },
  },

  {
    id: 'page-glass', group: 'look',
    line: 'No frosted glass effects.',
    why: 'a blurred see-through panel',
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
    why: 'gradient text: a background clipped to the text, an svg text filled with a gradient, or text blended over a gradient',
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
    why: 'a banned font, named in css, an svg or font attribute, a font file, a font link or a script that loads fonts. a font renamed through a link that hides its name cannot be seen',
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
        for (const f of code.matchAll(/(?:fontFamily\s*[:=]|new\s+FontFace\s*\()[^\n]{0,200}/gi)) if (named(decode(f[0]))) { hit(sc.line + (code.slice(0, f.index).match(/\n/g) || []).length, f[0]); return; }
      }
    },
  },

  {
    id: 'page-noise', group: 'look',
    line: 'No dithering or grain texture.',
    why: 'a noise or grain texture over the page: feTurbulence (also inside a data url or a script), random pixels drawn on a canvas, a tiny checker pattern, pixelated scaling of a decorative layer, or a noise, grain or dither image or empty layer. a texture baked into an encoded png cannot be seen',
    fix: 'remove the texture',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      // svg inside a data url, decoded so its filter can be read
      const unpack = (v) => String(v || '').replace(/data:image\/svg\+xml(?:;[\w-]+=[\w-]+)*;base64,([A-Za-z0-9+/=]+)/g, (_, b) => { try { return Buffer.from(b, 'base64').toString('utf8'); } catch { return ''; } }).replace(/data:image\/svg\+xml(?:;utf8)?,([^)"']+)/g, (_, b) => { try { return decodeURIComponent(b); } catch { return b; } });
      for (const el of page.all) {
        if (el.tag === 'feturbulence') { hit(el.line, '<feTurbulence>'); return; }
        if (/feTurbulence/i.test(unpack(el.attrs.src))) { hit(el.line, `<${el.tag} src> with feTurbulence`); return; }
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
        if (/^background(?:-image)?$|^mask(?:-image)?$/.test(d.prop) && /url\([^)]*(?:noise|grain|dither)[^)]*\)/i.test(d.value) && !(targets(d, page).length && targets(d, page).every((el) => el.attrs.role === 'img' || el.attrs['aria-label']))) { hit(d.line, `${d.prop}: ${d.value}`); return; }
        // a checker or dot pattern of a few pixels is a dither
        if (/^background(?:-image)?$/.test(d.prop) && /repeating-conic-gradient\(/i.test(d.value)) {
          const size = /\/\s*(\d+(?:\.\d+)?)px/.exec(d.value) || /(\d+(?:\.\d+)?)px/.exec((d.rule ? (d.rule.decls.find((x) => x.prop === 'background-size') || {}).value : '') || '');
          if (size && +size[1] <= 8) { hit(d.line, `${d.prop}: ${d.value}`); return; }
        }
      }
      for (const sc of page.scripts) {
        const code = stripJsComments(sc.text);
        // random pixels: random values written into image data, or a field of one pixel dots at random places
        const random = /Math\.random|crypto\.getRandomValues/.test(code);
        const m = /feTurbulence/i.exec(code) || (random && /(?:createImageData|getImageData|putImageData)/.exec(code)) || (/Math\.random/.test(code) && /fillRect\([^;]*?Math\.random[^;]*?,\s*[12]\s*,\s*[12]\s*\)/.exec(code));
        if (m) { hit(sc.line + (code.slice(0, m.index).match(/\n/g) || []).length, /feTurbulence/i.test(m[0]) ? 'feTurbulence built by a script' : 'random pixels drawn on a canvas'); return; }
      }
      for (const el of page.all) {
        if (isHidden(el, page) && el.attrs['aria-hidden'] !== 'true') continue;
        const cls = hasClassWord(el, ['noise', 'grain', 'grainy', 'dither', 'dithered']) && !visibleText(el, page) && !kids(el, page).length;
        const file = /(?:noise|grain|dither)[^/]*\.(?:png|svg|webp|gif|jpe?g)/i.test(el.attrs.src || '') && decorative(el);
        if (cls || file) { hit(el.line, el.attrs.class || el.attrs.src); return; }
      }
    },
  },

];

// --- running ----------------------------------------------------------------------

function switchedOff(root) {
  if (!root) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, '.atris', 'slop.rules.json'), 'utf8'));
    return Array.isArray(raw && raw.off) ? raw.off.filter((id) => PAGE_RULES.some((r) => r.id === id)) : [];
  } catch { return []; }
}

// Style sheets the page links from its own folder are read as part of the page. Their rules
// report the line of the link, since the finding is about this page.
function linkedSheets(page, file) {
  let dir;
  try { if (file && fs.statSync(file).isFile()) dir = path.dirname(file); } catch { return; }
  if (!dir) return;
  for (const el of page.links) {
    const href = el.attrs.href || '';
    if (!/\bstylesheet\b/i.test(el.attrs.rel || '') || /^(?:[a-z]+:|\/\/|data:)/i.test(href) || !href) continue;
    try { page.styles.push({ el, text: fs.readFileSync(path.resolve(dir, href.split(/[?#]/)[0]), 'utf8').replace(/\n/g, ' '), line: el.line }); } catch { /* a missing sheet is skipped */ }
  }
}

function checkPage(text, label = 'page.html', options = {}) {
  const page = parsePage(text);
  linkedSheets(page, options.file || (label && label !== '-' ? path.resolve(label) : null));
  const off = switchedOff(options.root);
  const findings = [];
  const results = [];
  const ctx = { page, label };
  for (const rule of PAGE_RULES) {
    if (off.includes(rule.id) || (options.only && options.only !== rule.id)) continue;
    const seen = new Set();
    let count = 0;
    const hit = (line, matched) => {
      if (seen.has(line)) return;
      seen.add(line);
      count++;
      findings.push({ rule: rule.id, kind: 'screen', level: 'error', file: label, line, text: clip(matched), why: rule.why, fix: rule.fix, said: rule.said });
    };
    try { rule.check(ctx, hit); } catch (err) {
      findings.push({ rule: rule.id, kind: 'screen', level: 'error', file: label, line: 1, text: clip(`the check could not run: ${err.message}`), why: rule.why, fix: rule.fix, said: rule.said });
      count++;
    }
    // a page shown inside an iframe srcdoc is read as part of this page, at the iframe's line
    if (!options.inner) {
      for (const el of page.all) {
        if (el.tag !== 'iframe' || !el.attrs.srcdoc || isHidden(el, page)) continue;
        const inner = checkPage(el.attrs.srcdoc, label, { ...options, inner: true, only: rule.id });
        for (const f of inner.findings) hit(el.line, f.text);
      }
    }
    results.push({ id: rule.id, ok: count === 0 });
  }
  for (const id of off) results.push({ id, ok: null, off: true });
  findings.sort((a, b) => a.line - b.line);
  return { kind: page.isContentPage ? 'content' : 'raw', findings, results, off };
}

function ruleSheet() {
  const groups = {};
  for (const r of PAGE_RULES) (groups[r.group] = groups[r.group] || []).push({ id: r.id, line: r.line, why: r.why, said: r.said });
  return groups;
}

module.exports = { PAGE_RULES, checkPage, ruleSheet, _flow: flow };
