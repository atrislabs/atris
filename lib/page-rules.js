// Page rules for `atris slop detect --kind screen` on html pages. Each rule is data plus a
// check that reads the page structure and the resolved style declarations (lib/page-scan.js),
// never class names alone, so a renamed class or a card drawn with a plain div is still seen.
// Every rule is a yes/no error. A project can switch one off in .atris/slop.rules.json
// ({ "off": ["page-glow"] }); a switched-off rule is reported in `off`, never dropped silently.

const fs = require('fs');
const path = require('path');
const { parsePage, cssRules, declsFor, visibleText, pseudoText, isHidden, classList, utilityDecls, sheetFor, matchesSelector, resolveVars, INLINE } = require('./page-scan');

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
const CONTENT_TAGS = new Set(['table', 'ul', 'ol', 'dl', 'form', 'figure', 'img', 'picture', 'svg', 'video', 'canvas', 'iframe', 'pre']);

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

// Code a reader skips: code, pre, kbd and samp, unless they are restyled in a prose font.
function codeLike(el, page) {
  if (!['code', 'pre', 'kbd', 'samp', 'tt'].includes(el.tag)) return false;
  const f = declsFor(el, page).map['font-family'];
  return !f || /mono|courier|consolas|menlo|code|inherit/i.test(f.value);
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
    const t = text.replace(/\s+/g, ' ').trim();
    if (!t) return;
    const first = nodes.find((n) => n.text.trim());
    const line = first ? first.line + (first.text.match(/^\s*/)[0].match(/\n/g) || []).length : el.line;
    blocks.push({ el, text: t, nodes, line, ...extra });
  };
  const walk = (el) => {
    for (const c of el.children) {
      if (c.type !== 'el' || NEVER_READ.has(c.tag) || isHidden(c, page) || codeLike(c, page)) continue;
      if (c.tag === 'svg') { for (const t of descendants(c)) if (t.tag === 'text') add(t, visibleText(t, page), textNodes(t)); continue; }
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
    if (n.tag !== '#root') parts.push(pseudoText(n, page, 'before'));
    // children of a flex or grid box are laid out as separate items
    const apart = n.tag !== '#root' && /flex|grid/.test(displayOf(n, page));
    n.children.forEach((c, i) => {
      if (c.type === 'text') { parts.push(c.text); return; }
      const prev = n.children[i - 1];
      if (INLINE.has(c.tag) && displayOf(c, page) !== 'block' && !codeLike(c, page) && !isHidden(c, page)) {
        // two parts styled apart (a badge then its text) read as two words
        if (c.tag === 'br' || apart || (prev && prev.type === 'el' && (prev.attrs.class || '') !== (c.attrs.class || ''))) parts.push(' ');
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
// English word rules read only text the page marks as English, or does not mark at all.
function english(el) {
  for (let a = el; a; a = a.parent) if (a.attrs && a.attrs.lang) return /^en\b/i.test(a.attrs.lang);
  return true;
}
// The page as a reader meets it, top to bottom: headings, lines of text, content (tables, lists,
// forms and fields, figures, images, maps, data), actions (a lone link or button) and nav rows.
// Wrappers are looked through, so a line two divs away from its heading is still the next thing.
const FLOW_CONTENT = new Set(['table', 'ul', 'ol', 'dl', 'form', 'figure', 'img', 'picture', 'video', 'canvas', 'iframe', 'input', 'textarea', 'select', 'address', 'svg', 'object', 'embed', 'audio', 'map', 'meter', 'progress']);
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
      // the heading's own text, then any block inside it or drawn after it as its own line
      const blockKid = el.children.find((c) => c.type === 'el' && !isHidden(c, page) && visibleText(c, page) && (!INLINE.has(c.tag) || displayOf(c, page) === 'block'));
      const headText = blockKid ? squashText(el.children.slice(0, el.children.indexOf(blockKid)).map((c) => (c.type === 'text' ? c.text : visibleText(c, page))).join(' ')) : visibleText(el, page);
      items.push({ kind: 'heading', el, text: headText || visibleText(el, page), line: el.line, big: !HEADING.test(el.tag) && el.attrs.role !== 'heading' });
      if (blockKid && headText) items.push({ kind: 'text', el: blockKid, text: visibleText(blockKid, page), line: blockKid.line, paragraph: true });
      const after = declsFor(el, page).pseudo.after;
      if (after.display && /^(?:block|flex|grid)/.test(after.display.value) && pseudoText(el, page, 'after').trim()) items.push({ kind: 'text', el, text: pseudoText(el, page, 'after'), line: after.content ? after.content.line : el.line, paragraph: true });
      return;
    }
    if (el.tag === 'nav' || el.attrs.role === 'navigation') { items.push({ kind: 'nav', el, text: visibleText(el, page), line: el.line }); return; }
    if (FLOW_CONTENT.has(el.tag)) { items.push({ kind: 'content', el, text: visibleText(el, page), line: el.line }); return; }
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
  const out = [];
  for (const s of page.styles) for (const r of cssRules(s.text, s.line)) for (const d of r.decls) out.push({ ...d, selector: r.selector, at: r.at });
  for (const el of page.all) {
    if (el.attrs.style) for (const d of (cssRules(`x{${el.attrs.style}}`, el.line)[0] || { decls: [] }).decls) out.push({ ...d, el, selector: null });
    for (const c of classList(el)) for (const u of utilityDecls(c)) out.push({ ...u, line: el.line, el, selector: null });
  }
  page._look = out;
  return out;
}

function pxValue(s) {
  const m = /(-?\d*\.?\d+)(px|rem|em)?/.exec(s || '');
  if (!m) return null;
  const n = parseFloat(m[1]);
  return m[2] === 'rem' || m[2] === 'em' ? n * 16 : n;
}

// Colours: neutral when grey, black, white or fully clear; null when unknown (a variable).
function colourNeutral(c) {
  const s = c.trim().toLowerCase();
  if (/^var\(/.test(s) || s === 'currentcolor') return null;
  if (/^(?:black|white|gray|grey|transparent|silver)$/.test(s)) return true;
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  let r, g, b;
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = h.split('').map((x) => x + x).join('');
    r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
  } else if ((m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s))) {
    r = +m[1]; g = +m[2]; b = +m[3];
  } else if ((m = /^hsla?\(\s*[\d.]+(?:deg)?[\s,]+([\d.]+)%/.exec(s))) {
    return +m[1] < 12;
  } else if ((m = /^oklch\(\s*[\d.%]+\s+([\d.]+)/.exec(s))) {
    return +m[1] < 0.03;
  } else return /^[a-z]+$/.test(s) ? false : null;
  return Math.max(r, g, b) - Math.min(r, g, b) < 24;
}

// Shadows as { inset, x, y, blur, spread, colour }.
function shadows(value) {
  if (!value || /^none$/i.test(value.trim())) return [];
  return value.split(/,(?![^(]*\))/).map((part) => {
    const colourM = /(#[0-9a-f]{3,8}\b|(?:rgba?|hsla?|oklch|color-mix|var)\([^)]*\)+|\b(?:black|white|red|blue|green|purple|orange|pink|violet|indigo|teal|cyan|gold|yellow|magenta)\b)/i.exec(part);
    const rest = part.replace(colourM ? colourM[0] : '', ' ');
    const nums = (rest.match(/-?\d*\.?\d+(?:px|rem|em)?/g) || []).map(pxValue);
    return { inset: /\binset\b/i.test(part), x: nums[0] || 0, y: nums[1] || 0, blur: nums[2] || 0, spread: nums[3] || 0, colour: colourM ? colourM[0] : '' };
  });
}

 // A glow, not a drop shadow: wide blur, a colour, centred on the box rather than cast below it.
const glowShadow = (s) => !s.inset && s.blur >= 30 && s.spread >= 0 && Math.abs(s.y) <= s.blur / 2 && colourNeutral(s.colour) === false;

const sectionOf = (el) => ancestor(el, (a) => ['section', 'article', 'aside', 'figure'].includes(a.tag));
// A source named near a number: a cite element, a data-source with a value, or a line that opens
// with Source: in the number's block, the block around it, or its section.
function hasSource(el, page) {
  const scopes = [el.parent, el.parent && el.parent.parent, sectionOf(el)].filter((x) => x && !['body', 'main', '#root', 'html'].includes(x.tag));
  const named = (d) => d.tag === 'cite' || (d.attrs['data-source'] || '').trim() || (page && textOnly(d, page) && /^(?:sources?|data|via)\s*:/i.test(visibleText(d, page)));
  return [el, ...scopes].some((s) => named(s) || descendants(s).some(named));
}

// Boxed: a border, a shadow or a fill, together with padding or rounded corners.
function boxed(el, page) {
  if (['html', 'body', 'a', 'button', 'input', 'select', 'textarea', 'img', 'svg', 'pre', 'code', 'hr', 'iframe', 'video'].includes(el.tag)) return false;
  if (TABLE_PARTS.has(el.tag) || INLINE.has(el.tag)) return false;
  const m = declsFor(el, page).map;
  const v = (p) => (m[p] ? m[p].value.trim().toLowerCase() : '');
  if (/^inline(?!-?(?:flex|grid)\b)/.test(v('display')) || v('display') === 'inline-flex') return false;
  const border = (v('border') && !/^(?:none|0|0px|hidden)\b/.test(v('border'))) ||
    (v('border-width') && !/^0(?:px)?(?:\s+0(?:px)?)*$/.test(v('border-width')) && v('border-style') && v('border-style') !== 'none') ||
    (v('outline') && !/^(?:none|0)/.test(v('outline')));
  const shadow = shadows(v('box-shadow')).some((s) => !s.inset && (s.blur > 0 || s.spread > 0));
  const bg = v('background-color') || v('background');
  const fill = bg && !/^(?:none|transparent|inherit|initial|unset|0)\b/.test(bg) && !/^url\(/.test(bg);
  const pad = v('padding') && !/^0(?:px)?(?:\s+0(?:px)?)*$/.test(v('padding'));
  const radius = v('border-radius') && !/^0(?:px)?$/.test(v('border-radius'));
  return (border || shadow || fill) && (pad || radius || ['padding-top', 'padding-left', 'padding-inline', 'padding-block'].some((p) => v(p) && pxValue(v(p)) > 0));
}

// A ::before or ::after drawn as a narrow filled bar down the left edge.
function pseudoBar(pm) {
  const pv = (p) => (pm[p] ? pm[p].value.trim().toLowerCase() : '');
  if (!pm.content && !pm.background && !pm['background-color']) return false;
  const abs = /absolute|fixed/.test(pv('position'));
  const left = /^0(?:px)?$/.test(pv('left')) || /^0(?:px)?$/.test(pv('inset-inline-start')) || /^0(?:px)?\s+auto\s+0(?:px)?\s+0(?:px)?$/.test(pv('inset'));
  const w = pxValue(pv('width') || pv('inline-size'));
  const tall = (/^0/.test(pv('top')) && /^0/.test(pv('bottom'))) || /100%/.test(pv('height')) || /^0(?:px)?\s+auto\s+0/.test(pv('inset'));
  const fill = pv('background') || pv('background-color');
  return abs && left && w != null && w >= 2 && w <= 8 && tall && !!fill && !/^(?:none|transparent)/.test(fill) && colourNeutral(fill) !== true;
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
  if (!named) return '';
  const t = visibleText(el, page);
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
  const bg = v('background-color') || v('background');
  const fill = bg && !/^(?:none|transparent|inherit|initial|unset)/.test(bg);
  const border = v('border') && !/^(?:none|0)/.test(v('border'));
  return !!(pad && (fill || border));
}

function cssContent(value) {
  if (!value) return '';
  const m = /["']((?:\\.|[^"'])*)["']/.exec(value);
  if (!m) return '';
  return m[1].replace(/\\([0-9a-f]{1,6})\s?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/\\(.)/g, '$1');
}

const ARROW = /[→↗↘➔➜➝⟶⇒›»⟩←↑↓⟵⇐⬅⬆⬇➡⮕❯❮❱➤➢➣➥➦➧➨➩➪➫➬➭➮➯➱⇨⇾⟹⟾⇢↦⭢⭠⮞⮜▶▸►◀◂◄]|->|=>|<-|(?:^|\s)(?:>>?|<<?)(?=\s|$)/;
// An arrow in a label; a pair of French quote marks around a word is not an arrow.
const hasArrow = (label) => ARROW.test(label.replace(/«([^«»]*)»/g, '$1').replace(/‹([^‹›]*)›/g, '$1'));
// A chevron drawn with css: borders on two sides of a small box, turned with rotate.
function drawnChevron(pm) {
  const v = (p) => (pm[p] ? pm[p].value.toLowerCase() : '');
  if (!/rotate/.test(v('transform') + v('rotate'))) return false;
  const sides = ['top', 'right', 'bottom', 'left'].filter((sd) => pxValue(v(`border-${sd}`)) >= 1 || pxValue(v(`border-${sd}-width`)) >= 1);
  const widths = v('border-width').split(/\s+/).filter(Boolean).map(pxValue);
  const fromWidth = widths.length === 4 ? widths.filter((w) => w >= 1).length : 0;
  return sides.length === 2 || fromWidth === 2;
}
// An icon: an svg, img, i or picture, an icon-font glyph, a span or other inline tag with an icon
// class or nothing in it but a drawn chevron, or a custom icon element.
function iconLike(el, page) {
  if (ICON_TAGS.has(el.tag) || /(?:^|-)icon(?:-|$)/.test(el.tag) || iconFontName(el, page)) return true;
  if (!INLINE.has(el.tag)) return false;
  const t = visibleText(el, page);
  if (t && !hasArrow(t)) return false;
  if (t) return true;
  if (hasClassWord(el, ['icon', 'arrow', 'chevron', 'caret', 'lucide', 'fa', 'bi', 'material', 'symbols'])) return true;
  const d = declsFor(el, page);
  return drawnChevron(d.map) || ['before', 'after'].some((w) => drawnChevron(d.pseudo[w]));
}
const SPARKLE = /[✨✦✧✩✪✫✬✭✮✯✰✱✲✳✴✵✶✷✸✹✺✻✼✽❂❃❇❈❉❊❋⁂💫⭐🌟🌠]/u;
const DOT_CHARS = '·•‧∙●◦⋅・･⦁';
const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}️/u;
// An emoji at the start of a string: a pictograph, a keycap (1️⃣) or a flag; not ©, ® or an arrow.
const emojiAt = (s) => /^(?:[0-9#*]\uFE0F?\u20E3|[\u{1F1E6}-\u{1F1FF}]{2}|(?![©®™‼⁉↔-↙↩↪⤴⤵])\p{Extended_Pictographic})/u.test(s);
const EMOJI_RUN = /(?:[0-9#*]\uFE0F?\u20E3|\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\u{1F1E6}-\u{1F1FF}]|\p{Emoji_Modifier}|[\uFE0F\u200D])+/gu;
const NUMBER_TOKEN = /^(?:#\s?)?[~≈<>+−-]?[$€£]?\d[\d,.]*\s?(?:%|x|×|\+|k|m|b|bn|mm|ms|s|h|hrs?|min|pts?|days?|weeks?|wks?|mo|yrs?|billion|million|thousand|trillion)?\+?(?:\s?(?:\/|of)\s?[\d,]+)?$/i;
const NUMBER_PREFIX = /^(?:#\s?)?(0?\d{1,2})(?:\s*[./)·:\u2014–-]\s*|\s+\/\s*|\s+(?=\S))/;
// Abbreviations that end in a period inside a sentence: titles, places, months and days.
const ABBR = /(?:^|\s)(?:inc|ltd|co|corp|llc|jr|sr|dr|mr|mrs|ms|st|vs|etc|fig|approx|dept|est|mt|ave|blvd|rd|ln|hwy|apt|ste|prof|rev|hon|gen|gov|sen|rep|sgt|capt|lt|col|fr|vol|ch|sec|pp|ed|eds|ft|oz|lb|lbs|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|a\.m|p\.m|e\.g|i\.e|cf|al)\.$/i;

// --- the rules ------------------------------------------------------------------

const PAGE_RULES = [
  // words
  {
    id: 'page-subtitle', group: 'words',
    line: 'No line of supporting text right under a heading.',
    why: 'subtitle under a heading: the heading alone carries it, so cut the line',
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
        if (next.kind !== 'text') continue;
        if (hasClassWord(next.el, ROLE)) { hit(next.line, next.text); continue; }
        // a paragraph, not a stat made of label pieces: a p, its own running text, or one inline piece
        if (!next.paragraph) continue;
        // two or more paragraphs of prose under a heading are the content, not a subtitle
        if (isParagraph(next) && isParagraph(after) && next.el.parent && descendants(next.el.parent).includes(after.el)) continue;
        if (rank(h) === 1) { hit(next.line, next.text); continue; }
        if (after && after.kind === 'content') hit(next.line, next.text);
      }
    },
  },
  {
    id: 'page-explanatory', group: 'words',
    line: 'No text that talks about the page itself instead of being the content.',
    why: 'text about the page or a helper caption: the screen should explain itself. this catches named openers (this page shows, on this page, below is, tip:, click a row), helper classes and caption classes only, so other self-talk can slip through',
    fix: 'cut the line, or replace it with the actual content it describes',
    said: SAID.explain,
    check(ctx, hit) {
      const { page } = ctx;
      const PART = '(?:page|section|screen|site|dashboard|view|report|table|chart|list|panel|tab|form|tool|app)';
      const OPENER = new RegExp(`(?:^|[.!?:,]\\s+)((?:This|this) ${PART}\\s+(?:shows|lists|displays|contains|lets|gives|explains|covers|summari[sz]es|includes|helps|tracks|collects|walks|will|is (?:where|for|your|the|a|an|here))\\b|(?:On|In|on|in) this ${PART}\\b|Here,? you(?:'ll| will)? (?:can|find|see)\\b|Below,? you\\b|Below (?:is|are)\\b|The following (?:list|table|items|steps|sections?|chart|shows|lists|is|are)\\b|Use this ${PART} to\\b|Welcome to\\b|As you can see\\b|Everything (?:below|here|on this page)\\b|(?:Pro )?(?:Tip|Hint|Note|Heads up):|(?:Click|Tap|Drag|Double-click|Right-click|Hover over|Swipe) (?:a|an|the|on|any|each|here|and)\\b)`);
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
        const capPart = names.some((c) => { const parts = c.split(/[-_]/); const i = parts.indexOf('cap'); return i > 0 && LAYOUT.test(parts[i - 1]); });
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
    why: 'the word real: it promises without showing. real estate and real-time are fine, real-world and keep-it-real are not',
    fix: 'drop the word or name the proof',
    said: SAID.never,
    check(ctx, hit) {
      for (const b of readText(ctx.page).blocks) {
        const m = english(b.el) && /\breal\b(?!(?:\s+|-)(?:estate|time)\b)/i.exec(b.text);
        if (m) hit(lineOf(b, b.text.slice(m.index)), b.text.slice(Math.max(0, m.index - 20), m.index + 30));
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
        const text = b.text.replace(/[．。]/g, '.');
        const raw = text.split(/(?<=[.!?]["'”’)*†‡]*)\s+(?=\S)/);
        // join a piece that ends on an abbreviation, an initial or a number onto the next one
        const joins = (last, next) => ABBR.test(last) || /\b[a-z]\.[a-z]\.$/i.test(last) || /(?:^|\s)\p{Lu}\.$/u.test(last) || /(?:^|\s)\d{1,2}\.$/.test(last) || (/(?:^|\s)no\.$/i.test(last) && /^\d/.test(next));
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
          if (ABBR.test(t) || /\b[a-z]\.[a-z]\.$/i.test(t) || /\d\.\d.*\.$/.test(t) || /^v?\d+(?:\.\d+)*\.$/i.test(t) || /^\p{Lu}\.$/u.test(t)) continue;
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
          if (before.length === 1 && after.length === 1) continue; // an operator between two symbols
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
        const m = declsFor(el, page).map;
        const px = (p) => (m[p] ? pxValue(m[p].value) : null);
        const drawn = !own && !el.children.some((c) => c.type === 'el') && px('width') != null && px('width') <= 8 && px('height') != null && px('height') <= 8 && m['border-radius'] && (m.background || m['background-color']);
        if ((lone || drawn) && texty(prevEl(el, page)) && texty(nextEl(el, page))) { hit(el.line, lone ? own : `<${el.tag}> drawn as a dot`); continue; }
        // the same dot drawn by css between items: on some siblings, not as a marker on every one
        const d = declsFor(el, page).pseudo;
        for (const where of ['before', 'after']) {
          if (!d[where].content || !new RegExp(`[${DOT_CHARS}]`, 'u').test(pseudoText(el, page, where))) continue;
          const sibs = kids(el.parent, page).filter((x) => x.tag === el.tag);
          const marked = sibs.filter((x) => new RegExp(`[${DOT_CHARS}]`, 'u').test(pseudoText(x, page, where)));
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
        const bg = (d.map['background-image'] || d.map.background || { value: '' }).value;
        if (label && /url\(/i.test(bg) && /\bright\b/i.test(`${bg} ${(d.map['background-position'] || { value: '' }).value}`)) { hit(el.line, `${label} with an icon painted on its right edge`); continue; }
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
    why: 'a sparkle icon: it says magic instead of showing the work. icons are caught by character, name or icon-font name, not by the shape an unnamed svg draws',
    fix: 'remove the icon',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      for (const b of readText(page).blocks) {
        const m = SPARKLE.exec(b.text);
        if (m) hit(lineOf(b, m[0]), m[0]);
      }
      const NAME = /(?:^|[^a-z])(?:sparkles?|stars|magic|wand|auto[-_]awesome)(?:[^a-z]|$)/i;
      const split = (x) => String(x).replace(/([a-z])([A-Z])/g, '$1-$2');
      for (const el of page.all) {
        if (isHidden(el, page) || inside(el, new Set(['head']))) continue;
        const lig = iconFontName(el, page);
        if (lig && NAME.test(lig)) { hit(el.line, lig); continue; }
        const iconTag = ICON_TAGS.has(el.tag) || el.tag === 'use' || /(?:^|-)icon(?:-|$)/.test(el.tag);
        const iconish = iconTag || (el.tag === 'span' && !visibleText(el, page)) || 'data-lucide' in el.attrs || 'data-icon' in el.attrs;
        if (!iconish) continue;
        // a photo of stars is not an icon: an img counts by its file name only when it is icon sized or an svg
        const src = el.tag === 'img' && !(smallIcon(el, page) || /\.svg\b/i.test(el.attrs.src || '')) ? '' : el.attrs.src;
        const names = [el.attrs.class, el.attrs.id, el.attrs.href, el.attrs['xlink:href'], el.attrs['aria-label'], el.attrs['data-lucide'], el.attrs['data-icon'], el.attrs.icon, el.attrs.name, src]
          .filter(Boolean).map(split).join(' ');
        if (NAME.test(names)) hit(el.line, names);
      }
      // an icon painted as a background image
      for (const d of lookDecls(page)) {
        if (/^(?:background(?:-image)?|mask(?:-image)?|-webkit-mask(?:-image)?|list-style(?:-image)?|content)$/.test(d.prop) && /url\([^)]*(?:sparkle|magic|wand)[^)]*\)/i.test(d.value)) { hit(d.line, `${d.prop}: ${d.value}`); break; }
      }
    },
  },

  {
    id: 'page-label-above-heading', group: 'words',
    line: 'No small label, tag or pill right above a heading.',
    why: 'a label above the heading: the heading says it. a row of links (breadcrumbs, tabs) and a status message are not labels',
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
        // the heading may sit first in a wrapper: the label is then the wrapper's neighbour
        let at = h;
        while (!prevEl(at, page) && at.parent && at.parent.tag !== '#root' && at.parent.tag !== 'body' && kids(at.parent, page)[0] === at) at = at.parent;
        const prev = prevEl(at, page);
        if (!prev || ['button', 'nav', 'img', 'svg', 'picture', 'input', 'header', 'section', 'article', 'main', 'footer', 'form', 'table'].includes(prev.tag)) continue;
        if (/^(?:status|alert|log)$/.test(prev.attrs.role || '') || 'aria-live' in prev.attrs) continue;
        const text = visibleText(prev, page);
        if (!text) continue;
        const links = [prev, ...descendants(prev)].filter((d) => d.tag === 'a');
        if (links.length >= 2) continue; // a row of links is navigation
        const role = hasClassWord(prev, ROLE) || (kids(prev, page).length > 0 && kids(prev, page).every((k) => hasClassWord(k, ROLE)));
        if (links.length && !role) continue;
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
      const SAME = /^(?:inherit|initial|unset|revert)$/i;
      // the family named in a font shorthand: what follows the size
      const familyOf = (m) => {
        if (m['font-family'] && !SAME.test(m['font-family'].value.trim())) return m['font-family'].value.trim();
        const f = m.font && /\d[\d.]*(?:px|em|rem|%|pt)(?:\s*\/\s*\S+)?\s+(.+)$/.exec(m.font.value);
        return f ? f[1].trim() : '';
      };
      for (const h of page.all) {
        if (!/^h[12]$/.test(h.tag) || isHidden(h, page)) continue;
        const hm = declsFor(h, page).map;
        const whole = visibleText(h, page).replace(/\s+/g, '');
        for (const d of descendants(h)) {
          const t = visibleText(d, page);
          if (!/\p{L}/u.test(t) || isHidden(d, page) || iconFontName(d, page)) continue;
          if (t.replace(/\s+/g, '') === whole) continue; // the whole heading in one style
          const m = declsFor(d, page).map;
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
        m = /^(?:(?:step|phase|stage|part)\s+)?(?:#\s?)?\(?(0?)(\d{1,2})(?![\d:.,]\d)\)?(?:\s*[./)·:—–-]\s*|\s+\/\s*|\s+(?=\S)|(?=\p{Lu}))/iu.exec(text);
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
      // numbering drawn by css: a counter on a heading or on a block that holds or sits by one, or 01 list markers
      for (const el of page.all) {
        if (isHidden(el, page)) continue;
        const near = HEADING.test(el.tag) || kids(el, page).some((k) => HEADING.test(k.tag)) || (nextEl(el, page) && HEADING.test(nextEl(el, page).tag));
        const p = declsFor(el, page).pseudo;
        for (const where of ['before', 'after']) {
          if (near && p[where].content && /counters?\(/.test(p[where].content.value)) { hit(p[where].content.line, p[where].content.value); return; }
        }
        const m = declsFor(el, page).map;
        const ls = `${m['list-style'] ? m['list-style'].value : ''} ${m['list-style-type'] ? m['list-style-type'].value : ''}`;
        if (/decimal-leading-zero/.test(ls) && ['ol', 'ul'].includes(el.tag)) { hit(el.line, `list-style: ${ls.trim()}`); return; }
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
        const tt = /uppercase/i.test(v('text-transform'));
        const sc = /small-caps/i.test(v('font-variant') + v('font')) || /small-caps|all-small|all-petite|petite/i.test(v('font-variant-caps')) || /["'](?:c2sc|smcp|c2pc|pcap)["']/i.test(v('font-feature-settings'));
        if (tt || sc) hit(el.line, shown);
      }
      const ok = CAPS_OK();
      const ROMAN = /^M{0,4}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/;
      for (const b of readText(page).blocks) {
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
        const text = visibleText(el, page);
        if (!text) continue;
        const lead = HEADING.test(el.tag) || ['li', 'button', 'a', 'dt', 'summary', 'td', 'th'].includes(el.tag) || textOnly(el, page);
        const startsEmoji = emojiAt(text.replace(/^["'“”‘’«(\[]+/, ''));
        const alone = textOnly(el, page) && !text.replace(/\s/g, '').replace(EMOJI_RUN, '');
        const iconSpot = INLINE.has(el.tag) || (nextEl(el, page) && HEADING.test(nextEl(el, page).tag));
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
      const LEFTOVER = /^lorem ipsum\b|\{\{\s*[\w.-]+\s*\}\}|\[(?:company|business|product|first|last|full|your|insert|year|date|city|name|title|headline|phone|email|address|client|customer)\b[\w\s]*\]|\bTBD\b|\bTKTK\b|\b(?:example|test|name|user|email|your\.?name)@(?:email|example|domain|company|yourcompany)\.com\b/i;
      for (const b of readText(page).blocks) {
        if (b.attr || b.field) continue;
        const m = re.exec(b.text) || LEFTOVER.exec(b.text);
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
      const CLAIM = /%|percent|\d\s?[x×](?![\w])|\+|\d\s?(?:k|m|b|bn)\b|billion|million|thousand|trillion|^#\d|^[$€£]/i;
      const PRICE_UNIT = /^(?:a|an|per|each|every|\/)\s*(?:month|mo|year|yr|seat|user|person|team|week|day|hour)\b|^(?:monthly|yearly|annually|one time|once|billed|forever|plus tax|incl)/i;
      const DATE = /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?$/i;
      const big = (el) => { for (let a = el; a && a.tag !== '#root'; a = a.parent) { const f = declsFor(a, page).map['font-size']; if (f) return pxValue(f.value) >= 24 || /x+-large|xxx/.test(f.value); } return HEADING.test(el.tag); };
      const token = (t, el) => NUMBER_TOKEN.test(t) || (big(el) && /^[$€£]?\d[\d,.]*\s?(?:%|x|\+)?\s+\p{L}+$/u.test(t) && words(t).length === 2);
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
        if (TABLE_PARTS.has(el.tag)) continue; // a table cell is data with its column heading
        // not a statistic: a year, a time, a plain step number, a version
        if (/^(?:19|20)\d\d$/.test(own) || /^\d{1,2}:\d\d$/.test(own) || /^0\d\s?\/\s?0?\d+$/.test(own) || /^v?\d+\.\d+\.\d+$/.test(own)) continue;
        if (INLINE.has(el.tag) && el.parent && readText(page).blocks.some((b) => b.el === el.parent && words(b.text).length > 8)) continue; // a number inside a sentence
        if (!label) {
          // look up through wrappers that hold only the number
          while (at.parent && at.parent.tag !== '#root' && visibleText(at.parent, page) === own) at = at.parent;
          const sibs = kids(at.parent, page);
          const i = sibs.indexOf(at);
          const sibLabel = sibs.find((x) => x !== at && !HEADING.test(x.tag) && visibleText(x, page) && !NUMBER_TOKEN.test(visibleText(x, page)));
          const parentRest = sibs.filter((x) => HEADING.test(x.tag)).reduce((t, x) => t.replace(visibleText(x, page), ''), visibleText(at.parent, page).replace(own, '')).trim();
          label = sibLabel ? visibleText(sibLabel, page) : (parentRest && words(parentRest).length <= 12 ? parentRest : '');
          if (!label) continue;
          // a label written before a plain number is a setting or a price row (Seats 25), not a statistic
          const labelFirst = sibLabel ? sibs.indexOf(sibLabel) < i : visibleText(at.parent, page).indexOf(own) > 0;
          const strong = ['b', 'strong'].includes(el.tag) || /^(?:[6-9]00|bold)/.test((declsFor(el, page).map['font-weight'] || { value: '' }).value);
          if (labelFirst && !CLAIM.test(own) && !big(el) && !strong) continue;
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
    why: 'a grid of matching cards: the reader skims all of them and reads none',
    fix: 'write it as one list or a few sentences, or a table if it is data',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      const NO = new Set(['nav', 'select', 'datalist', 'form', 'fieldset', 'table', 'thead', 'tbody', 'tr', 'head', 'svg', 'menu']);
      for (const parent of [page.root, ...page.all]) {
        if (NO.has(parent.tag) || isHidden(parent, page) || ancestor(parent, (x) => x.tag === 'nav' || x.tag === 'footer') || parent.tag === 'footer') continue;
        const blocks = kids(parent, page).filter((k) => !INLINE.has(k.tag) && !HEADING.test(k.tag));
        if (blocks.length < 3) continue;
        const shape = (b) => kids(b, page).map((k) => (HEADING.test(k.tag) ? 'h' : k.tag)).join(',');
        const groups = new Map();
        for (const b of blocks) {
          const s = shape(b);
          if (!s) continue;
          if (!groups.has(s)) groups.set(s, []);
          groups.get(s).push(b);
        }
        for (const [, same] of groups) {
          if (same.length < 3) continue;
          const titled = same.every((b) => {
            const first = kids(b, page)[0];
            const icon = first && (smallIcon(first, page) || (textOnly(first, page) && [...visibleText(first, page)].every((ch) => EMOJI.test(ch) || /[️\s]/.test(ch))) || (!visibleText(first, page) && descendants(first).some((d) => smallIcon(d, page))));
            return icon || descendants(b).some((d) => /^h[2-5]$/.test(d.tag) && descendants(b).indexOf(d) < 4);
          });
          if (!titled) continue;
          const pm = declsFor(parent, page).map;
          const laidOut = (pm.display && /grid|flex/.test(pm.display.value)) || !!pm['grid-template-columns'];
          const short = same.every((b) => words(visibleText(b, page)).length <= 60);
          if (laidOut || short || same.every((b) => boxed(b, page))) { hit(parent.line, `${same.length} blocks shaped ${same[0].tag}(${shape(same[0])})`); break; }
        }
      }
    },
  },
  {
    id: 'page-card-in-card', group: 'shape',
    line: 'No boxed element inside another boxed element.',
    why: 'a card inside a card: two frames around one thing',
    fix: 'keep one box and drop the inner frame',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      for (const el of page.all) {
        if (isHidden(el, page) || !visibleText(el, page) || !boxed(el, page)) continue;
        const outer = ancestor(el, (a) => boxed(a, page));
        if (outer) hit(el.line, `<${el.tag}> inside <${outer.tag}> (line ${outer.line})`);
      }
    },
  },
  {
    id: 'page-left-border', group: 'shape',
    line: 'No coloured bar on the left edge of a block.',
    why: 'a decorative left-edge bar',
    fix: 'remove the bar; let spacing or a heading group the block',
    said: SAID.bars,
    check(ctx, hit) {
      const { page } = ctx;
      // width of a coloured bar; a grey, black or white rule is not a coloured bar
      const barWidth = (v) => {
        if (!v || /\b(?:none|hidden)\b/.test(v) || /\btransparent\b/.test(v)) return 0;
        const colour = /(#[0-9a-f]{3,8}\b|(?:rgba?|hsla?|oklch|var)\([^)]*\)+|\b[a-z]+\b(?=\s*$))/i.exec(v.replace(/\b(?:solid|dashed|dotted|double|groove|ridge|inset|outset)\b/g, ' ').trim());
        if (colour && colourNeutral(colour[1]) === true) return 0;
        return pxValue(v) || 0;
      };
      for (const el of page.all) {
        if (isHidden(el, page) || TABLE_PARTS.has(el.tag) || ['html', 'body', 'hr'].includes(el.tag)) continue;
        const d = declsFor(el, page);
        const m = d.map;
        const v = (p) => (m[p] ? m[p].value.trim().toLowerCase() : '');
        const ln = (p) => (m[p] ? m[p].line : el.line);
        for (const p of ['border-left', 'border-inline-start']) {
          if (barWidth(v(p)) >= 2) { hit(ln(p), `${p}: ${v(p)}`); break; }
        }
        if (barWidth(v('border-left-width') || v('border-inline-start-width')) >= 2 && !/none|transparent/.test(v('border-left-color') + v('border-left-style'))) hit(ln('border-left-width'), `border-left-width: ${v('border-left-width')}`);
        const bw = v('border-width').split(/\s+/).map(pxValue);
        if (bw.length === 4 && bw[3] >= 2 && bw[0] === 0 && bw[1] === 0) hit(ln('border-width'), `border-width: ${v('border-width')}`);
        for (const s of shadows(v('box-shadow'))) if (s.inset && s.x >= 2 && s.y === 0 && s.blur === 0) { hit(ln('box-shadow'), `box-shadow: ${v('box-shadow')}`); break; }
        for (const where of ['before', 'after']) {
          const pm = d.pseudo[where];
          if (pseudoBar(pm)) { hit((pm.width || pm['inline-size'] || pm.left || pm.inset).line, `::${where} bar on the left edge`); break; }
        }
      }
      // rules for elements a script builds at run time: their class names appear only in a script
      for (const { c, rule } of scriptOnly(page)) {
        if (c.tag && TABLE_PARTS.has(c.tag)) continue;
        const m = Object.fromEntries(rule.decls.map((x) => [x.prop, x]));
        if (c.pseudo) { if (pseudoBar(m)) hit(rule.line, rule.selector); continue; }
        for (const p of ['border-left', 'border-inline-start']) if (m[p] && barWidth(m[p].value.toLowerCase()) >= 2) { hit(m[p].line, `${p}: ${m[p].value}`); break; }
      }
    },
  },

  // look
  {
    id: 'page-looping-motion', group: 'look',
    line: 'Nothing on the page loops forever.',
    why: 'an animation that never stops pulls the eye from the words',
    fix: 'remove the loop, or run the motion once',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      for (const d of lookDecls(page)) {
        if (/^(?:-\w+-)?animation(?:-iteration-count)?$/.test(d.prop) && /\binfinite\b/i.test(d.value)) { hit(d.line, `${d.prop}: ${d.value}`); return; }
      }
      for (const el of page.all) {
        if (/^animate(?:transform|motion)?$/.test(el.tag) && /indefinite/i.test(el.attrs.repeatcount || '')) { hit(el.line, `<${el.tag} repeatCount="indefinite">`); return; }
      }
      for (const s of page.scripts) {
        const m = /iterations\s*:\s*Infinity/.exec(s.text);
        if (m) { hit(s.line + (s.text.slice(0, m.index).match(/\n/g) || []).length, m[0]); return; }
      }
    },
  },
  {
    id: 'page-scroll-fade', group: 'look',
    line: 'Sections do not fade or slide in on scroll.',
    why: 'content that appears on scroll hides the words until the reader moves',
    fix: 'show the content from the start',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      for (const s of page.scripts) {
        const io = /IntersectionObserver|addEventListener\(\s*['"]scroll['"]|\bwhileInView\b/.exec(s.text);
        if (io && /classList\.(?:add|toggle|replace)|\.style\.(?:opacity|transform)|opacity|whileInView/.test(s.text)) {
          hit(s.line + (s.text.slice(0, io.index).match(/\n/g) || []).length, io[0]);
          return;
        }
      }
      for (const el of page.all) {
        const a = Object.keys(el.attrs).find((k) => /^data-(?:aos|sal|scroll|reveal|animate-on-scroll)$/.test(k));
        if (a) { hit(el.line, a); return; }
      }
      for (const d of lookDecls(page)) {
        if (/animation-timeline/.test(d.prop) && /\b(?:view|scroll)\(/.test(d.value)) { hit(d.line, `${d.prop}: ${d.value}`); return; }
      }
      for (const d of lookDecls(page)) {
        if (d.prop === 'opacity' && /^0(?:\.0+)?$/.test(d.value) && d.selector && /\.(?:[\w-]*-)?(?:reveal|fade-?in|fade-?up|fade-?in-?up|in-?view|inview|aos|on-?scroll|scroll-?in|appear-?on-?scroll)(?:-[\w-]*)?(?![\w-])/i.test(d.selector)) {
          hit(d.line, `${d.selector} { opacity: 0 }`);
          return;
        }
      }
    },
  },
  {
    id: 'page-glow', group: 'look',
    line: 'No blurred blobs or glows behind content.',
    why: 'a glow or blurred blob behind content',
    fix: 'remove it and let the plain background show',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      const imageSel = (sel) => sel && /(?:^|[\s>+~])(?:img|video|picture|canvas)(?:[.#:\[]|$)/.test(sel.trim().split(/\s*,\s*/).pop().split(/[\s>+~]+/).pop() || '');
      for (const d of lookDecls(page)) {
        const isImg = d.el ? ['img', 'video', 'picture', 'canvas'].includes(d.el.tag) : imageSel(d.selector);
        if (/^(?:-webkit-)?filter$/.test(d.prop)) {
          const b = /blur\(\s*([\d.]+)(px|rem|em)?/.exec(d.value);
          if (b && parseFloat(b[1]) > 0 && !isImg) { hit(d.line, `${d.prop}: ${d.value}`); return; }
          const ds = /drop-shadow\(([^()]*(?:\([^)]*\))?[^()]*)\)/.exec(d.value);
          if (ds && shadows(ds[1]).some(glowShadow)) { hit(d.line, `${d.prop}: ${d.value}`); return; }
        }
        if (/^background(?:-image)?$/.test(d.prop) && /radial-gradient\(/.test(d.value)) { hit(d.line, `${d.prop}: ${d.value}`); return; }
        if (/^(?:box|text)-shadow$/.test(d.prop) && shadows(d.value).some(glowShadow)) { hit(d.line, `${d.prop}: ${d.value}`); return; }
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
        if (/^(?:-webkit-)?backdrop-filter$/.test(d.prop) && /blur\(/.test(d.value)) { hit(d.line, `${d.prop}: ${d.value}`); return; }
      }
    },
  },
  {
    id: 'page-gradient-text', group: 'look',
    line: 'No gradient-filled text.',
    why: 'gradient text',
    fix: 'set the text in one solid colour',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      for (const d of lookDecls(page)) {
        if (/^(?:-webkit-)?background-clip$/.test(d.prop) && /\btext\b/.test(d.value)) { hit(d.line, `${d.prop}: ${d.value}`); return; }
      }
      for (const el of page.all) {
        if (['text', 'tspan', 'textpath'].includes(el.tag) && /url\(#/.test(el.attrs.fill || '')) { hit(el.line, `<${el.tag} fill="${el.attrs.fill}">`); return; }
      }
    },
  },
  {
    id: 'page-banned-font', group: 'look',
    line: 'Never use Instrument Serif, Playfair Display, Inter or Roboto.',
    why: 'a banned font',
    fix: 'use a font from the design library',
    said: SAID.fonts,
    check(ctx, hit) {
      const { page } = ctx;
      const FONT = /instrument[\s+_-]*serif|playfair(?:[\s+_-]*display)?|\binter(?=$|[^a-z]|variable|display|tight)|roboto/i;
      const strip = (s) => s.replace(/\binterstate\b/ig, '');
      for (const d of lookDecls(page)) {
        if (!(/^font(?:-family)?$/.test(d.prop) || d.prop === 'src' || d.prop.startsWith('--'))) continue;
        const m = FONT.exec(strip(d.value));
        if (m) { hit(d.line, `${d.prop}: ${d.value}`); return; }
      }
      for (const s of page.styles) {
        for (const r of cssRules(s.text, s.line)) {
          if (r.at === 'import' && FONT.test(r.selector)) { hit(r.line, r.selector); return; }
        }
      }
      for (const el of page.links) {
        const href = el.attrs.href || '';
        if (/font|family=/i.test(href) && FONT.test(decodeURIComponent(href.replace(/%(?![0-9a-f]{2})/gi, '%25')))) { hit(el.line, href); return; }
      }
      for (const s of page.scripts) {
        const m = /(?:families\s*:|fonts\.(?:googleapis|bunny)|fontsource)[^\n]{0,200}/i.exec(s.text);
        if (m && FONT.test(m[0])) { hit(s.line + (s.text.slice(0, m.index).match(/\n/g) || []).length, m[0]); return; }
      }
    },
  },
  {
    id: 'page-noise', group: 'look',
    line: 'No dithering or grain texture.',
    why: 'a noise or grain texture over the page',
    fix: 'remove the texture',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      for (const el of page.all) {
        if (el.tag === 'feturbulence') { hit(el.line, '<feTurbulence>'); return; }
      }
      for (const d of lookDecls(page)) {
        if (/feTurbulence/i.test(d.value)) { hit(d.line, `${d.prop}: feTurbulence`); return; }
        if (d.prop === 'image-rendering' && /pixelated|crisp-edges/.test(d.value)) {
          const tag = d.el ? d.el.tag : '';
          const decorative = d.el ? (!['img', 'canvas'].includes(tag) || d.el.attrs.alt === '' || d.el.attrs['aria-hidden'] === 'true') : !/(?:^|[\s>])(?:img|canvas)(?:[.#:\[]|$)/.test(d.selector || '');
          if (decorative) { hit(d.line, `${d.prop}: ${d.value}`); return; }
        }
        if (/^background(?:-image)?$|^mask(?:-image)?$/.test(d.prop) && /url\([^)]*(?:noise|grain|dither)[^)]*\)/i.test(d.value)) { hit(d.line, `${d.prop}: ${d.value}`); return; }
      }
      for (const el of page.all) {
        if (isHidden(el, page) && el.attrs['aria-hidden'] !== 'true') continue;
        if (hasClassWord(el, ['noise', 'grain', 'grainy', 'dither', 'dithered']) || /(?:noise|grain|dither)[^/]*\.(?:png|svg|webp|gif|jpe?g)/i.test(el.attrs.src || '')) { hit(el.line, el.attrs.class || el.attrs.src); return; }
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
