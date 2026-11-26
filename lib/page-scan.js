// A small, tolerant html and css reader for the page check (lib/page-rules.js).
// Zero packages. It never throws: bad markup gives a best-effort tree.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style']);
const RCDATA = new Set(['textarea', 'title']);
const INLINE = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'kbd', 'mark', 'q', 's',
  'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr', 'del', 'ins', 'label', 'font']);
const NOT_SHOWN = new Set(['head', 'script', 'style', 'template', 'noscript', 'title', 'meta', 'link']);

// Opening one of these closes an open <p>, as browsers do.
const CLOSES_P = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figure', 'footer',
  'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul']);
const IMPLIED = { li: ['li'], dt: ['dt', 'dd'], dd: ['dt', 'dd'], tr: ['tr', 'td', 'th'], td: ['td', 'th'], th: ['td', 'th'], option: ['option'] };

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', bull: '•', hellip: '…', mdash: '\u2014',
  ndash: '–', rarr: '→', larr: '←', rsaquo: '›', lsaquo: '‹', raquo: '»', laquo: '«', copy: '©', reg: '®', trade: '™', times: '×',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', deg: '°', euro: '€', pound: '£', check: '✓', star: '☆', starf: '★', rArr: '⇒',
  nearr: '↗', searr: '↘', thinsp: ' ', ensp: ' ', emsp: ' ', zwj: '‍', zwnj: '‌', sect: '§', para: '¶', half: '½', plusmn: '±' };

function decode(s) {
  if (!s || s.indexOf('&') < 0) return s || '';
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (all, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      try { return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : all; } catch { return all; }
    }
    return Object.prototype.hasOwnProperty.call(NAMED, code) ? NAMED[code] : all;
  });
}

function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (pos) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

const ATTR_RE = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(src) {
  const attrs = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(src))) {
    const name = m[1].toLowerCase();
    if (name in attrs) continue;
    attrs[name] = decode(m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : '');
  }
  return attrs;
}

function parsePage(input) {
  const text = String(input == null ? '' : input).replace(/\r\n?/g, '\n');
  const lineAt = lineIndex(text);
  const root = { type: 'el', tag: '#root', attrs: {}, line: 1, parent: null, children: [] };
  const all = [], styles = [], scripts = [], links = [], comments = [];
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const addText = (s, pos) => {
    if (!s) return;
    const node = { type: 'text', text: decode(s), line: lineAt(pos), parent: top() };
    top().children.push(node);
  };
  const close = (tag) => {
    for (let i = stack.length - 1; i > 0; i--) {
      if (stack[i].tag === tag) { stack.length = i; return; }
    }
  };
  let i = 0;
  const n = text.length;
  try {
    while (i < n) {
      const lt = text.indexOf('<', i);
      if (lt < 0) { addText(text.slice(i), i); break; }
      if (lt > i) addText(text.slice(i, lt), i);
      if (text.startsWith('<!--', lt)) {
        const end = text.indexOf('-->', lt + 4);
        const stop = end < 0 ? n : end + 3;
        comments.push({ text: text.slice(lt + 4, end < 0 ? n : end), line: lineAt(lt) });
        i = stop;
        continue;
      }
      if (text[lt + 1] === '!' || text[lt + 1] === '?') {
        const end = text.indexOf('>', lt);
        i = end < 0 ? n : end + 1;
        continue;
      }
      const m = /^<(\/?)([a-zA-Z][\w:-]*)/.exec(text.slice(lt, lt + 64));
      if (!m) { addText('<', lt); i = lt + 1; continue; }
      // Find the end of the tag, skipping quoted attribute values.
      let j = lt + m[0].length, quote = null;
      while (j < n) {
        const c = text[j];
        if (quote) { if (c === quote) quote = null; } else if (c === '"' || c === "'") quote = c; else if (c === '>') break;
        j++;
      }
      const tag = m[2].toLowerCase();
      const inner = text.slice(lt + m[0].length, j);
      i = j + 1;
      if (m[1]) { close(tag); continue; }
      if (CLOSES_P.has(tag) && stack.some((s) => s.tag === 'p')) {
        // only close a <p> that is the current block, not one far up the stack
        for (let k = stack.length - 1; k > 0; k--) {
          if (stack[k].tag === 'p') { stack.length = k; break; }
          if (!INLINE.has(stack[k].tag)) break;
        }
      }
      if (IMPLIED[tag]) {
        const t = top();
        if (IMPLIED[tag].includes(t.tag)) stack.pop();
      }
      const el = { type: 'el', tag, attrs: parseAttrs(inner), line: lineAt(lt), parent: top(), children: [] };
      top().children.push(el);
      all.push(el);
      if (tag === 'link') links.push(el);
      const selfClose = /\/\s*$/.test(inner);
      if (RAW.has(tag) || RCDATA.has(tag)) {
        const endRe = new RegExp(`</${tag}\\s*>`, 'ig');
        endRe.lastIndex = i;
        const em = endRe.exec(text);
        const stop = em ? em.index : n;
        const body = text.slice(i, stop);
        if (body) el.children.push({ type: 'text', text: RAW.has(tag) ? body : decode(body), line: lineAt(i), parent: el });
        if (tag === 'style') styles.push({ el, text: body, line: lineAt(i) });
        if (tag === 'script') scripts.push({ el, text: body, line: lineAt(i) });
        i = em ? em.index + em[0].length : n;
        continue;
      }
      if (!VOID.has(tag) && !selfClose) stack.push(el);
    }
  } catch { /* keep what was read */ }
  const firstEl = root.children.find((c) => c.type === 'el');
  const page = { root, all, styles, scripts, links, comments, isContentPage: !!firstEl && firstEl.tag === 'main', text };
  return page;
}

// --- css ----------------------------------------------------------------------

function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, (c) => c.replace(/[^\n]/g, ' '));
}

function splitTop(s, sep) {
  const out = [];
  let depth = 0, quote = null, from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote && s[i - 1] !== '\\') quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === sep && depth <= 0) { out.push({ text: s.slice(from, i), at: from }); from = i + 1; }
  }
  out.push({ text: s.slice(from), at: from });
  return out;
}

function parseDecls(body, offset, lineAt) {
  const decls = [];
  for (const part of splitTop(body, ';')) {
    const colon = part.text.indexOf(':');
    if (colon < 0) continue;
    const prop = part.text.slice(0, colon).trim().toLowerCase();
    if (!prop || /[\s{}]/.test(prop)) continue;
    const value = part.text.slice(colon + 1).replace(/!important/i, '').trim();
    const lead = part.text.length - part.text.trimStart().length;
    decls.push({ prop, value, line: lineAt(offset + part.at + lead) });
  }
  return decls;
}

// Rules of a style sheet: [{ selector, decls, line, at }]. `at` names the at-rule a rule sits in
// ('media', 'supports'), or is 'font-face', 'keyframes' (selector is the animation name) or 'import'.
function cssRules(input, baseLine = 1) {
  const css = stripCssComments(String(input || ''));
  const local = lineIndex(css);
  const lineAt = (pos) => local(pos) + baseLine - 1;
  const rules = [];
  const walk = (from, to, at) => {
    let i = from;
    while (i < to) {
      // the next "{" or ";" at this level ends the prelude
      let j = i, quote = null, paren = 0;
      while (j < to) {
        const c = css[j];
        if (quote) { if (c === quote) quote = null; } else if (c === '"' || c === "'") quote = c;
        else if (c === '(') paren++; else if (c === ')') paren--;
        else if (paren <= 0 && (c === '{' || c === ';' || c === '}')) break;
        j++;
      }
      const prelude = css.slice(i, j).trim();
      const preludeAt = i + (css.slice(i, j).length - css.slice(i, j).trimStart().length);
      if (j >= to || css[j] === '}') { i = j + 1; continue; }
      if (css[j] === ';') {
        if (/^@import\b/i.test(prelude)) rules.push({ selector: prelude, decls: [], line: lineAt(preludeAt), at: 'import' });
        else if (prelude && !prelude.startsWith('@')) {
          // a stray declaration outside a block (inline style text read as a sheet)
        }
        i = j + 1;
        continue;
      }
      // find the matching close brace
      let depth = 1, k = j + 1; quote = null;
      while (k < to && depth > 0) {
        const c = css[k];
        if (quote) { if (c === quote) quote = null; } else if (c === '"' || c === "'") quote = c;
        else if (c === '{') depth++; else if (c === '}') depth--;
        k++;
      }
      const bodyEnd = depth === 0 ? k - 1 : to;
      const atm = /^@([\w-]+)\s*(.*)$/s.exec(prelude);
      if (atm) {
        const name = atm[1].toLowerCase();
        if (/^(?:-\w+-)?keyframes$/.test(name)) {
          rules.push({ selector: atm[2].trim().replace(/^["']|["']$/g, ''), decls: [], line: lineAt(preludeAt), at: 'keyframes' });
        } else if (name === 'font-face') {
          rules.push({ selector: '@font-face', decls: parseDecls(css.slice(j + 1, bodyEnd), j + 1, lineAt), line: lineAt(preludeAt), at: 'font-face' });
        } else {
          walk(j + 1, bodyEnd, name);
        }
      } else if (prelude) {
        rules.push({ selector: prelude, decls: parseDecls(css.slice(j + 1, bodyEnd), j + 1, lineAt), line: lineAt(preludeAt), at: at || null });
      }
      i = k;
    }
  };
  try { walk(0, css.length, null); } catch { /* keep what was read */ }
  return rules;
}

function inlineDecls(el) {
  const s = el.attrs && el.attrs.style;
  if (!s) return [];
  return parseDecls(stripCssComments(s), 0, () => el.line);
}

// --- selectors ----------------------------------------------------------------

const DYNAMIC = /:(?:hover|focus|focus-within|focus-visible|active|visited|target|checked|disabled|placeholder-shown|invalid|valid)\b/;

// The last compound of a selector: tag, classes, id, attribute tests and pseudo-element.
function lastCompound(selector) {
  const s = selector.trim().replace(/\s*([>+~])\s*/g, '$1');
  // split on combinators that sit outside brackets and parens
  let depth = 0, cut = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && (c === ' ' || c === '>' || c === '+' || c === '~')) cut = i + 1;
  }
  const part = s.slice(cut);
  if (DYNAMIC.test(part)) return null;
  const pseudoM = /::?(before|after)\b/i.exec(part);
  const core = part.replace(/::?[\w-]+(?:\([^)]*\))?/g, '');
  const tagM = /^([a-zA-Z][\w-]*|\*)/.exec(core);
  const classes = [...core.matchAll(/\.((?:\\.|[\w-])+)/g)].map((m) => m[1].replace(/\\(.)/g, '$1'));
  const idM = /#((?:\\.|[\w-])+)/.exec(core);
  const attrTests = [...core.matchAll(/\[\s*([\w:-]+)\s*(?:([~|^$*]?=)\s*["']?([^"'\]]*)["']?)?\s*\]/g)].map((m) => ({ name: m[1].toLowerCase(), op: m[2], value: m[3] }));
  const root = /:root\b/.test(part);
  const tag = tagM ? tagM[1].toLowerCase() : (root ? 'html' : null);
  if (!tag && !classes.length && !idM && !attrTests.length) return null;
  return { tag, classes, id: idM ? idM[1].replace(/\\(.)/g, '$1') : null, attrs: attrTests, pseudo: pseudoM ? pseudoM[1].toLowerCase() : null };
}

function classList(el) {
  const c = el.attrs && el.attrs.class;
  return c ? c.split(/\s+/).filter(Boolean) : [];
}

function matchesCompound(el, c) {
  if (c.tag && c.tag !== '*' && c.tag !== el.tag) return false;
  if (c.id && (el.attrs.id || '') !== c.id) return false;
  if (c.classes.length) {
    const have = new Set(classList(el));
    for (const k of c.classes) if (!have.has(k)) return false;
  }
  for (const a of c.attrs) {
    if (!(a.name in el.attrs)) return false;
    if (a.op === '=' && el.attrs[a.name] !== a.value) return false;
  }
  return true;
}

// --- utility classes ----------------------------------------------------------

// A small map for common utility classes (tailwind style) to the declarations they stand for.
function utilityDecls(cls) {
  const d = (prop, value) => ({ prop, value, util: cls });
  const base = cls.replace(/^(?:[\w-]+:)+/, ''); // drop variants like md: or hover:
  if (cls !== base && /(?:^|:)(?:hover|focus|active|group-hover|focus-within):/.test(cls)) return [];
  let m;
  if (base === 'border') return [d('border', '1px solid currentColor')];
  if ((m = /^border-([2-8])$/.exec(base))) return [d('border', `${m[1]}px solid currentColor`)];
  if ((m = /^border-(?:l|s)(?:-(\d+)|-\[(\d+)px\])?$/.exec(base))) return [d('border-left', `${m[1] || m[2] || 1}px solid currentColor`)];
  if (/^shadow(?:-(?:sm|md|lg|xl|2xl|inner))?$/.test(base)) return [d('box-shadow', base === 'shadow-inner' ? 'inset 0 2px 4px rgba(0,0,0,.05)' : '0 1px 3px rgba(0,0,0,.1)')];
  if (base === 'shadow-none') return [d('box-shadow', 'none')];
  if (/^rounded(?:-.+)?$/.test(base) && base !== 'rounded-none') return [d('border-radius', '8px')];
  if ((m = /^bg-(.+)$/.exec(base))) {
    const v = m[1];
    if (/^\[.*radial-gradient/.test(v)) return [d('background-image', 'radial-gradient(circle, currentColor, transparent)')];
    if (v === 'clip-text') return [d('background-clip', 'text')];
    if (/^(?:transparent|none|inherit|current|clip-.+|origin-.+|fixed|local|scroll|center|cover|contain|no-repeat|repeat.*|bottom|top|left|right|auto|gradient-.+|opacity-.+|blend-.+)$/.test(v)) return [];
    return [d('background-color', v)];
  }
  if (/^p[xytrbl]?-(?:\d|\[|px)/.test(base) && !/^p[xytrbl]?-0$/.test(base)) return [d('padding', '8px')];
  if (base === 'uppercase') return [d('text-transform', 'uppercase')];
  if (base === 'italic') return [d('font-style', 'italic')];
  if (base === 'not-italic') return [d('font-style', 'normal')];
  if (/^font-(?:serif|mono|sans)$/.test(base)) return [d('font-family', base.slice(5))];
  if ((m = /^animate-(pulse|ping|bounce|spin)$/.exec(base))) return [d('animation', `${m[1]} 1s infinite`)];
  if ((m = /^blur-(2xl|3xl)$/.exec(base))) return [d('filter', m[1] === '2xl' ? 'blur(40px)' : 'blur(64px)')];
  if (/^backdrop-blur(?:-.+)?$/.test(base)) return [d('backdrop-filter', 'blur(8px)')];
  if (base === 'hidden') return [d('display', 'none')];
  if (base === 'invisible') return [d('visibility', 'hidden')];
  if (base === 'sr-only') return [d('display', 'none')];
  if (base === 'grid') return [d('display', 'grid')];
  if (base === 'flex') return [d('display', 'flex')];
  if (/^grid-cols-([2-9]|1[0-2])$/.test(base)) return [d('grid-template-columns', 'repeat(2, 1fr)')];
  if (/^(?:block|inline|inline-block|inline-flex)$/.test(base)) return [d('display', base)];
  return [];
}

// --- declarations for a node ----------------------------------------------------

function sheetFor(page) {
  if (page._sheet) return page._sheet;
  const rules = [];
  for (const s of page.styles) for (const r of cssRules(s.text, s.line)) rules.push(r);
  const compiled = [];
  for (const r of rules) {
    if (r.at === 'font-face' || r.at === 'keyframes' || r.at === 'import') continue;
    for (const sel of splitTop(r.selector, ',')) {
      const c = lastCompound(sel.text);
      if (c) compiled.push({ c, rule: r, selector: sel.text.trim() });
    }
  }
  page._sheet = { rules, compiled };
  return page._sheet;
}

// The declarations that apply to a node. An approximation: a css rule applies when the LAST
// compound of its selector matches the node by tag, class, id or attribute; ancestors in the
// selector, specificity and hover states are not checked. Later declarations win, inline last.
// Returns { map: {prop: {value, line}}, list, pseudo: { before: map, after: map } }.
function declsFor(node, page) {
  if (!node || node.type !== 'el') return { map: {}, list: [], pseudo: { before: {}, after: {} } };
  page._decls = page._decls || new Map();
  if (page._decls.has(node)) return page._decls.get(node);
  const out = { map: {}, list: [], pseudo: { before: {}, after: {} }, pseudoList: { before: [], after: [] } };
  const put = (target, list, decl) => { target[decl.prop] = { value: decl.value, line: decl.line }; list.push(decl); };
  for (const cls of classList(node)) for (const u of utilityDecls(cls)) put(out.map, out.list, { ...u, line: node.line });
  for (const { c, rule } of sheetFor(page).compiled) {
    if (!matchesCompound(node, c)) continue;
    for (const decl of rule.decls) {
      if (c.pseudo) put(out.pseudo[c.pseudo], out.pseudoList[c.pseudo], decl);
      else put(out.map, out.list, decl);
    }
  }
  for (const decl of inlineDecls(node)) put(out.map, out.list, decl);
  page._decls.set(node, out);
  return out;
}

// --- text helpers ---------------------------------------------------------------

const squash = (s) => s.replace(/\s+/g, ' ').trim();

function isHidden(node, page) {
  for (let el = node && node.type === 'el' ? node : node && node.parent; el && el.tag !== '#root'; el = el.parent) {
    if (NOT_SHOWN.has(el.tag)) return true;
    if ('hidden' in el.attrs) return true;
    if (el.attrs['aria-hidden'] === 'true') return true;
    if (page) {
      const m = declsFor(el, page).map;
      if (m.display && /^none\b/.test(m.display.value)) return true;
      if (m.visibility && /^hidden\b/.test(m.visibility.value)) return true;
    }
  }
  return false;
}

function ownText(node) {
  if (!node || !node.children) return '';
  return squash(node.children.filter((c) => c.type === 'text').map((c) => c.text).join(' '));
}

function visibleText(node, page) {
  if (!node) return '';
  if (node.type === 'text') return isHidden(node.parent, page) ? '' : squash(node.text);
  if (isHidden(node, page)) return '';
  const parts = [];
  const walk = (n) => {
    for (const c of n.children) {
      if (c.type === 'text') parts.push(c.text);
      else if (!NOT_SHOWN.has(c.tag) && !('hidden' in c.attrs) && c.attrs['aria-hidden'] !== 'true') {
        if (page) {
          const m = declsFor(c, page).map;
          if ((m.display && /^none\b/.test(m.display.value)) || (m.visibility && /^hidden\b/.test(m.visibility.value))) continue;
        }
        if (c.tag === 'br') parts.push(' ');
        if (!INLINE.has(c.tag)) parts.push(' ');
        walk(c);
        if (!INLINE.has(c.tag)) parts.push(' ');
      }
    }
  };
  walk(node);
  return squash(parts.join(''));
}

module.exports = { parsePage, cssRules, declsFor, ownText, visibleText, isHidden, decode, lastCompound, matchesCompound, classList, utilityDecls, sheetFor, INLINE };
