// Page rules for `atris slop detect --kind screen` on html pages. Each rule is data plus a
// check that reads the page structure and the resolved style declarations (lib/page-scan.js),
// never class names alone, so a renamed class or a card drawn with a plain div is still seen.
// Every rule is a yes/no error. A project can switch one off in .atris/slop.rules.json
// ({ "off": ["page-glow"] }); a switched-off rule is reported in `off`, never dropped silently.

const fs = require('fs');
const path = require('path');
const { parsePage, cssRules, declsFor, visibleText, isHidden, classList, utilityDecls, sheetFor, matchesCompound, INLINE } = require('./page-scan');

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
  if (!textOnly(el, page) || words(visibleText(el, page)).length > 12) return false;
  const m = declsFor(el, page).map;
  return !!m['font-size'] && pxValue(m['font-size'].value) >= 40;
}
const words = (s) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
const clip = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 80);
const lineIn = (node, index) => node.line + (node.text.slice(0, Math.max(0, index)).match(/\n/g) || []).length;
const ancestor = (el, test) => { for (let a = el && el.parent; a && a.tag !== '#root'; a = a.parent) if (test(a)) return a; return null; };
// el itself or one of its ancestors has one of the tags
const inside = (el, tags) => !!ancestor({ parent: el }, (a) => tags.has(a.tag));

// One walk: visible text nodes a visitor reads, and blocks of running text.
function readText(page) {
  if (page._text) return page._text;
  const nodes = [], blocks = [];
  const blockOf = new Map();
  const walk = (el, hidden, skipped) => {
    for (const c of el.children) {
      if (c.type === 'text') {
        if (hidden || skipped || !c.text.trim()) continue;
        nodes.push(c);
        let b = el;
        while (b.tag !== '#root' && INLINE.has(b.tag) && b.parent) b = b.parent;
        if (!blockOf.has(b)) { const entry = { el: b, nodes: [] }; blockOf.set(b, entry); blocks.push(entry); }
        blockOf.get(b).nodes.push(c);
        continue;
      }
      const h = hidden || isHidden(c, page);
      walk(c, h, skipped || SKIP_TEXT.has(c.tag));
    }
  };
  walk(page.root, false, false);
  for (const b of blocks) {
    b.text = inlineText(b.el, page);
    b.line = b.nodes[0].line + (b.nodes[0].text.match(/^\s*/)[0].match(/\n/g) || []).length;
  }
  page._text = { nodes, blocks };
  return page._text;
}
// The running text of a block: its text and inline children, not nested blocks.
function inlineText(el, page) {
  const parts = [];
  const walk = (n) => {
    for (const c of n.children) {
      if (c.type === 'text') parts.push(c.text);
      else if (INLINE.has(c.tag) && !SKIP_TEXT.has(c.tag) && !isHidden(c, page)) { if (c.tag === 'br') parts.push(' '); walk(c); }
      else parts.push(' ');
    }
  };
  walk(el);
  return parts.join('').replace(/\s+/g, ' ').trim();
}
function lineOf(block, snippet) {
  const probe = snippet.trim().slice(0, 12);
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

const sectionOf = (el) => ancestor(el, (a) => ['section', 'article', 'aside', 'figure', 'main', 'body', 'header', 'footer'].includes(a.tag));
function hasSource(el) {
  const scopes = [el.parent, el.parent && el.parent.parent, sectionOf(el)].filter(Boolean);
  return scopes.some((s) => s.tag === 'cite' || 'data-source' in s.attrs || descendants(s).some((d) => d.tag === 'cite' || 'data-source' in d.attrs));
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
  return sheetFor(page).compiled.filter(({ c }) => c.classes.length && c.classes.every((k) => code.includes(k)) && !page.all.some((el) => matchesCompound(el, { ...c, pseudo: null })));
}

// An icon: an svg or i element, or an image no bigger than 64px.
function smallIcon(el, page) {
  if (el.tag === 'svg' || el.tag === 'i') return true;
  if (el.tag !== 'img') return false;
  const m = declsFor(el, page).map;
  const size = [el.attrs.width, el.attrs.height, m.width && m.width.value, m.height && m.height.value].map(pxValue).filter((n) => n != null);
  return size.length > 0 && Math.max(...size) <= 64;
}

function isButton(el, page) {
  if (el.tag === 'button' || el.attrs.role === 'button') return true;
  if (el.tag === 'input' && /^(?:submit|button)$/i.test(el.attrs.type || '')) return true;
  if (el.tag !== 'a') return false;
  if (hasClassWord(el, ['btn', 'button', 'cta'])) return true;
  // a link drawn as a button: padding with a fill or a border
  const m = declsFor(el, page).map;
  const v = (p) => (m[p] ? m[p].value.trim().toLowerCase() : '');
  const pad = v('padding') && !/^0/.test(v('padding'));
  const bg = v('background-color') || v('background');
  const fill = bg && !/^(?:none|transparent|inherit)/.test(bg);
  const border = v('border') && !/^(?:none|0)/.test(v('border'));
  return !!(pad && (fill || border));
}

function cssContent(value) {
  if (!value) return '';
  const m = /["']((?:\\.|[^"'])*)["']/.exec(value);
  if (!m) return '';
  return m[1].replace(/\\([0-9a-f]{1,6})\s?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/\\(.)/g, '$1');
}

const ARROW = /[→↗↘➔➜➝⟶⇒›»⟩]|->|=>/;
const SPARKLE = /[✨✦✧❇✴💫⭐🌟]/u;
const DOTS = /[·•‧∙]/;
const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}️/u;
const NUMBER_TOKEN = /^[~≈<>+−-]?[$€£]?\d[\d,.]*\s?(?:%|x|×|\+|k|m|b|bn|mm|ms|s|h|hrs?|min|pts?|days?|weeks?|wks?|mo|yrs?)?\+?(?:\s?(?:\/|of)\s?[\d,]+)?$/i;
const NUMBER_PREFIX = /^(?:#\s?)?(0?\d{1,2})(?:\s*[./)·:\u2014–-]\s*|\s+\/\s*|\s+(?=\S))/;
const ABBR = /(?:^|\s)(?:inc|ltd|co|corp|llc|jr|sr|dr|mr|mrs|ms|st|vs|etc|no|fig|approx|dept|est|mt|ave|blvd)\.$/i;

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
      const contentish = (el) => el && (CONTENT_TAGS.has(el.tag) || kids(el, page).length >= 2 && !textOnly(el, page) || descendants(el).some((d) => CONTENT_TAGS.has(d.tag)));
      for (const h of page.all) {
        const big = !HEADING.test(h.tag) && headingLike(h, page);
        if (!(/^h[1-3]$/.test(h.tag) || big) || isHidden(h, page)) continue;
        let next = nextEl(h, page);
        let after = next ? nextEl(next, page) : null;
        // a heading alone in a wrapper: look past the wrapper
        if (!next && kids(h.parent, page).length === 1 && h.parent.tag !== '#root' && h.parent.tag !== 'body') next = nextEl(h.parent, page);
        else if (next && !after && kids(h.parent, page).length === 2 && h.parent.tag !== 'body') {
          // a heading group (heading and one line) followed by content; a run of same-shaped
          // blocks is a list of cards, handled by page-card-grid
          const shape = (el) => kids(el, page).map((k) => k.tag).join(',');
          const following = nextEl(h.parent, page);
          if (following && shape(following) !== shape(h.parent)) after = following;
        }
        if (!next || HEADING.test(next.tag) || ['a', 'button'].includes(next.tag)) continue;
        if (hasClassWord(next, ROLE) && visibleText(next, page)) { hit(next.line, visibleText(next, page)); continue; }
        if (!textOnly(next, page)) continue;
        if (h.tag === 'h1' || big) { hit(next.line, visibleText(next, page)); continue; }
        // a paragraph: a p, or a text-only element with its own running text (not a stat of label pieces)
        const paragraph = next.tag === 'p' || next.children.some((c) => c.type === 'text' && /\p{L}{2}/u.test(c.text));
        if (paragraph && contentish(after)) hit(next.line, visibleText(next, page));
      }
    },
  },
  {
    id: 'page-explanatory', group: 'words',
    line: 'No text that talks about the page itself instead of being the content.',
    why: 'text about the page or a helper caption: the screen should explain itself. this catches named openers and caption-style classes only, so other self-talk can slip through',
    fix: 'cut the line, or replace it with the actual content it describes',
    said: SAID.explain,
    check(ctx, hit) {
      const { page } = ctx;
      const OPENER = /(?:^|[.!?]\s+)(This (?:page|section|screen|site|dashboard|view|report)\b|Here you(?:'ll| will)? (?:can|find|see)\b|Below,? you\b|Below (?:is|are)\b|The following\b|Use this (?:to|page|screen|section)\b|Welcome to\b|As you can see\b|Everything (?:below|here|on this page)\b)/i;
      for (const b of readText(page).blocks) {
        const m = OPENER.exec(b.text);
        if (m) hit(lineOf(b, m[1]), b.text.slice(m.index).trim());
      }
      for (const el of page.all) {
        if (!classList(el).length || isHidden(el, page)) continue;
        const w = classWords(el);
        const named = ['caption', 'cap', 'hint', 'helper', 'help', 'note', 'explain', 'explainer'].some((x) => w.has(x));
        if (named && textOnly(el, page)) hit(el.line, visibleText(el, page));
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
      for (const n of readText(ctx.page).nodes) {
        const m = /\bquiet(?:ly)?\b/i.exec(n.text);
        if (m) hit(lineIn(n, m.index), m[0]);
      }
    },
  },
  {
    id: 'page-word-real', group: 'words',
    line: 'Never use the word real on its own.',
    why: 'the word real: it promises without showing. real estate and real-time are fine',
    fix: 'drop the word or name the proof',
    said: SAID.never,
    check(ctx, hit) {
      for (const n of readText(ctx.page).nodes) {
        const re = /\breal\b(?!(?:\s+|-)(?:estate|time)\b)/gi;
        let m;
        while ((m = re.exec(n.text))) {
          if (n.text[m.index - 1] === '-' || n.text[m.index + 4] === '-') continue; // part of a joined word
          hit(lineIn(n, m.index), n.text.slice(Math.max(0, m.index - 20), m.index + 30));
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
        const raw = b.text.split(/(?<=[.!?])\s+(?=\S)/);
        // join pieces that end on an abbreviation back onto the next one
        const sentences = [];
        for (const s of raw) {
          const last = sentences[sentences.length - 1];
          if (last != null && (ABBR.test(last) || /\b[a-z]\.[a-z]\.$/i.test(last))) sentences[sentences.length - 1] = `${last} ${s}`;
          else sentences.push(s);
        }
        for (const s of sentences) {
          const t = s.trim();
          if (!/[\p{L}\p{N}]\.["'”’)]*$/u.test(t)) continue;
          const w = words(t);
          if (w.length < 1 || w.length > 2) continue;
          if (ABBR.test(t) || /\b[a-z]\.[a-z]\.$/i.test(t) || /\d\.\d.*\.$/.test(t) || /^v?\d+(?:\.\d+)*\.$/i.test(t)) continue;
          hit(lineOf(b, t), t);
        }
      }
    },
  },
  {
    id: 'page-dot-separator', group: 'words',
    line: 'No middle dots or bullets between words.',
    why: 'a dot used as a separator between words',
    fix: 'write it as a sentence, or put the items on their own lines',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      for (const b of readText(page).blocks) {
        const m = /[^\s·•‧∙]\s*[·•‧∙]\s*[^\s·•‧∙]/u.exec(b.text);
        if (m) hit(lineOf(b, b.text.slice(Math.max(0, m.index - 10))), b.text.slice(Math.max(0, m.index - 20), m.index + 30));
      }
      // the same dot drawn by css between items
      for (const el of page.all) {
        const d = declsFor(el, page).pseudo;
        for (const where of ['before', 'after']) {
          if (!d[where].content || !DOTS.test(cssContent(d[where].content.value))) continue;
          const sib = where === 'before' ? prevEl(el, page) : nextEl(el, page);
          if (sib && !isHidden(el, page)) { hit(d[where].content.line, `${where} content ${d[where].content.value}`); break; }
        }
      }
    },
  },
  {
    id: 'page-button-arrow', group: 'words',
    line: 'No arrows in buttons.',
    why: 'an arrow in a button or a button-like link',
    fix: 'let the label carry it, for example "Book a fix"',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      for (const el of page.all) {
        if (isHidden(el, page) || !isButton(el, page)) continue;
        const label = el.tag === 'input' ? (el.attrs.value || '') : visibleText(el, page);
        if (ARROW.test(label)) { hit(el.line, label); continue; }
        const after = declsFor(el, page).pseudo.after;
        if (after.content && ARROW.test(cssContent(after.content.value))) { hit(after.content.line, `${label} ${cssContent(after.content.value)}`); continue; }
        // an icon as the last child, after the label text
        const parts = el.children.filter((c) => (c.type === 'text' ? c.text.trim() : !isHidden(c, page)));
        const last = parts[parts.length - 1];
        const textBefore = parts.slice(0, -1).some((c) => (c.type === 'text' ? c.text.trim() : visibleText(c, page)));
        if (last && last.type === 'el' && textBefore) {
          const iconish = ICON_TAGS.has(last.tag) || (last.tag === 'span' && (!visibleText(last, page) || ARROW.test(visibleText(last, page)) || hasClassWord(last, ['icon', 'arrow', 'chevron', 'caret', 'lucide', 'fa', 'bi', 'material', 'symbols'])));
          if (iconish) hit(last.line, `${label} <${last.tag}>`);
        }
      }
    },
  },
  {
    id: 'page-sparkle', group: 'words',
    line: 'No sparkle or star-burst icons.',
    why: 'a sparkle icon: it says magic instead of showing the work',
    fix: 'remove the icon',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      for (const n of readText(page).nodes) {
        const m = SPARKLE.exec(n.text);
        if (m) hit(lineIn(n, m.index), m[0]);
      }
      const NAME = /(?:^|[^a-z])(?:sparkles?|stars|magic|wand)(?:[^a-z]|$)/i;
      for (const el of page.all) {
        if (isHidden(el, page) && el.attrs['aria-hidden'] !== 'true') continue;
        if (inside(el, new Set(['head']))) continue;
        const names = [el.attrs.class, el.attrs.id, el.attrs.href, el.attrs['xlink:href'], el.attrs['aria-label'], el.attrs['data-lucide'], el.attrs['data-icon'], el.attrs.src]
          .filter(Boolean).join(' ');
        const iconish = ICON_TAGS.has(el.tag) || el.tag === 'use' || el.tag === 'span' || 'data-lucide' in el.attrs || 'data-icon' in el.attrs;
        if (iconish && NAME.test(names)) hit(el.line, names);
      }
    },
  },
  {
    id: 'page-label-above-heading', group: 'words',
    line: 'No small label, tag or pill right above a heading.',
    why: 'a label above the heading: the heading says it',
    fix: 'cut the label; if it matters, put it in the heading',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      const ROLE = ['eyebrow', 'kicker', 'overline', 'pill', 'badge', 'tag', 'chip', 'label'];
      for (const h of page.all) {
        if (!(/^h[12]$/.test(h.tag) || (!HEADING.test(h.tag) && headingLike(h, page))) || isHidden(h, page)) continue;
        const prev = prevEl(h, page);
        if (!prev || HEADING.test(prev.tag) || ['a', 'button', 'nav', 'img', 'svg', 'picture', 'input'].includes(prev.tag)) continue;
        const text = visibleText(prev, page);
        if (!text) continue;
        const first = kids(h.parent, page)[0] === prev;
        const short = words(text).length <= 6 && text.length <= 48;
        if ((first && short && textOnly(prev, page, { icons: true })) || hasClassWord(prev, ROLE)) hit(prev.line, text);
      }
    },
  },
  {
    id: 'page-headline-accent', group: 'words',
    line: 'No single word styled differently inside a headline.',
    why: 'one word in italics or another font inside the headline',
    fix: 'set the whole headline in one style',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      for (const h of page.all) {
        if (!/^h[12]$/.test(h.tag) || isHidden(h, page)) continue;
        const hm = declsFor(h, page).map;
        for (const d of descendants(h)) {
          if (!/\p{L}/u.test(visibleText(d, page)) || isHidden(d, page)) continue;
          const m = declsFor(d, page).map;
          const style = m['font-style'] ? m['font-style'].value.toLowerCase() : (['em', 'i', 'cite', 'var', 'dfn'].includes(d.tag) ? 'italic' : '');
          const family = m['font-family'] && (!hm['font-family'] || m['font-family'].value !== hm['font-family'].value) ? m['font-family'].value : '';
          const font = m.font && /italic|oblique|serif|["']/.test(m.font.value) ? m.font.value : '';
          if (/italic|oblique/.test(style) || family || font) { hit(d.line, visibleText(d, page)); break; }
        }
      }
    },
  },
  {
    id: 'page-numbered-sections', group: 'words',
    line: 'No decorative numbers like 01, 02 in front of sections.',
    why: 'numbered section labels: the order is already on the page',
    fix: 'drop the numbers',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      const found = [];
      const LONE = /^(?:#\s?)?0?(\d{1,2})\.?$/;
      for (const el of page.all) {
        if (isHidden(el, page) || el.tag === 'li' || TABLE_PARTS.has(el.tag) || inside(el, TABLE_PARTS)) continue;
        const text = visibleText(el, page);
        if (!text) continue;
        const heading = HEADING.test(el.tag);
        const label = !heading && textOnly(el, page) && words(text).length <= 6;
        if (!heading && !label) continue;
        // a number standing alone in its own element, beside a heading or a label
        const alone = LONE.exec(text);
        if (alone && label) {
          const sib = [prevEl(el, page), nextEl(el, page)].find((x) => x && visibleText(x, page) && /\p{L}/u.test(visibleText(x, page)));
          if (sib) found.push({ n: +alone[1], el, text: `${text} ${visibleText(sib, page)}` });
          continue;
        }
        if (ancestor(el, (a) => HEADING.test(a.tag))) continue;
        // a heading or label that opens on a number, typed or in its own first element
        const first = el.children.find((c) => (c.type === 'text' ? c.text.trim() : !isHidden(c, page)));
        const lead = first && first.type === 'el' ? LONE.exec(visibleText(first, page)) : null;
        const m = lead || NUMBER_PREFIX.exec(text);
        if (!m) continue;
        if (!lead && /^\d{1,2}\s+\p{L}/u.test(text) && !/^0\d/.test(text) && !heading) continue;
        found.push({ n: +m[1], el, text });
      }
      for (let i = 0; i < found.length; i++) {
        const next = found.slice(i + 1, i + 4).find((f) => f.n === found[i].n + 1);
        if (next) { hit(found[i].el.line, `${found[i].text.slice(0, 30)} / ${next.text.slice(0, 30)}`); return; }
      }
      // numbering drawn by a css counter on headings
      for (const el of page.all) {
        if (!HEADING.test(el.tag) || isHidden(el, page)) continue;
        const p = declsFor(el, page).pseudo;
        for (const where of ['before', 'after']) {
          if (p[where].content && /counter\(/.test(p[where].content.value)) { hit(p[where].content.line, p[where].content.value); return; }
        }
      }
    },
  },
  {
    id: 'page-all-caps', group: 'words',
    line: 'No text shown in capitals.',
    why: 'all caps reads as shouting',
    fix: 'use sentence case',
    said: SAID.caps,
    check(ctx, hit) {
      const { page } = ctx;
      for (const el of page.all) {
        if (isHidden(el, page) || !visibleText(el, page)) continue;
        const m = declsFor(el, page).map;
        const tt = m['text-transform'] && /uppercase/i.test(m['text-transform'].value);
        const sc = m['font-variant'] && /small-caps/i.test(m['font-variant'].value) || m['font-variant-caps'] && /small-caps|all-small|all-petite|petite/i.test(m['font-variant-caps'].value);
        if (tt || sc) hit(el.line, visibleText(el, page));
      }
      const ok = CAPS_OK();
      for (const n of readText(page).nodes) {
        const re = /\b[A-Z]{4,}\b/g;
        let w;
        while ((w = re.exec(n.text))) if (!ok.has(w[0]) && !/^[IVXLCDM]+$/.test(w[0])) { hit(lineIn(n, w.index), w[0]); break; }
      }
    },
  },
  {
    id: 'page-emoji-icon', group: 'words',
    line: 'No emoji used as icons.',
    why: 'an emoji standing in for an icon',
    fix: 'remove it, or use a drawn icon from the design library',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      for (const el of page.all) {
        if (isHidden(el, page)) continue;
        const text = visibleText(el, page);
        if (!text) continue;
        const lead = HEADING.test(el.tag) || ['li', 'button', 'a', 'dt', 'summary'].includes(el.tag);
        const first = [...text][0] || '';
        const alone = textOnly(el, page) && [...text.replace(/\s/g, '')].every((ch) => EMOJI.test(ch) || /[️‍]/.test(ch) || /\p{Emoji_Modifier}/u.test(ch));
        if ((lead && EMOJI.test(first)) || alone) hit(el.line, text.slice(0, 20));
      }
    },
  },
  {
    id: 'page-placeholder', group: 'words',
    line: 'No lorem ipsum or placeholder text.',
    why: 'placeholder copy left on the page',
    fix: 'write the real words or remove the block',
    said: SAID.explain,
    check(ctx, hit) {
      const { page } = ctx;
      const re = PLACEHOLDER();
      for (const b of readText(page).blocks) {
        const m = re.exec(b.text);
        if (m) hit(lineOf(b, m[0]), m[0]);
      }
    },
  },
  {
    id: 'page-unsourced-number', group: 'words',
    line: 'No big statistic without a named source next to it.',
    why: 'a number shown as a statistic with no source named. this proves a source is named, not that the number is true',
    fix: 'add a cite element or data-source next to the number, or drop the number',
    said: SAID.numbers,
    check(ctx, hit) {
      const { page } = ctx;
      const NO = new Set(['form', 'button', 'a', 'nav', 'time', 'code', 'pre', 'select', 'option', 'label', 'li', 'footer']);
      for (const el of page.all) {
        if (isHidden(el, page) || TABLE_PARTS.has(el.tag) || inside(el, TABLE_PARTS) || NO.has(el.tag) || inside(el, NO)) continue;
        if (HEADING.test(el.tag)) {
          const text = visibleText(el, page);
          if (/\d(?:\.\d+)?\s?%|\b\d+(?:\.\d+)?\s?[x×](?![\w])/i.test(text) && !hasSource(el)) hit(el.line, text);
          continue;
        }
        const own = visibleText(el, page);
        if (!own || !NUMBER_TOKEN.test(own) || kids(el, page).some((k) => !INLINE.has(k.tag))) continue;
        // not a statistic: a year, a plain price, a time, a step number like 1 or 01
        if (/^(?:19|20)\d\d$/.test(own) || /^[$€£][\d,.]+(?:\s?\/\s?[a-z]+)?$/i.test(own) || /^\d{1,2}[.:]\d\d$/.test(own) || /^#?(?:0\d|\d)\.?$/.test(own) || /^0\d\s?\/\s?0?\d+$/.test(own)) continue;
        if (INLINE.has(el.tag) && el.parent && readText(page).blocks.some((b) => b.el === el.parent && words(b.text).length > 8)) continue; // a number inside a sentence
        const sibLabel = kids(el.parent, page).some((s) => s !== el && visibleText(s, page) && !NUMBER_TOKEN.test(visibleText(s, page)));
        const parentRest = visibleText(el.parent, page).replace(own, '').trim();
        const label = sibLabel || (parentRest && words(parentRest).length <= 8);
        if (label && !hasSource(el)) hit(el.line, `${own} ${parentRest}`.slice(0, 80));
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

function checkPage(text, label = 'page.html', options = {}) {
  const page = parsePage(text);
  const off = switchedOff(options.root);
  const findings = [];
  const results = [];
  const ctx = { page, label };
  for (const rule of PAGE_RULES) {
    if (off.includes(rule.id)) continue;
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

module.exports = { PAGE_RULES, checkPage, ruleSheet };
