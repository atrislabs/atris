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
  nearr: '↗', searr: '↘', thinsp: ' ', ensp: ' ', emsp: ' ', zwj: '\u200d', zwnj: '', sect: '§', para: '¶', half: '½', plusmn: '±',
  shy: '', period: '.', comma: ',', colon: ':', excl: '!', quest: '?', ast: '*', dagger: '†', Dagger: '‡', centerdot: '·', CenterDot: '·',
  bullet: '•', sdot: '⋅', rightarrow: '→', RightArrow: '→', Rightarrow: '⇒', srarr: '→', longrightarrow: '⟶', LongRightArrow: '⟶',
  xrarr: '⟶', leftarrow: '←', LeftArrow: '←', uarr: '↑', darr: '↓', downarrow: '↓', DownArrow: '↓', rang: '⟩', gt: '>', lsqb: '[', rsqb: ']',
  lcub: '{', rcub: '}', num: '#', percnt: '%', dollar: '$', sol: '/', bsol: '\\', lowbar: '_', hyphen: '‐', dash: '‐', squ: '□', squf: '▪', cir: '○' };

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

// Characters a reader never sees: soft hyphen, zero-width space and joiners, word joiner, byte order mark.
const invisible = (s) => s.replace(/[\u00ad\u200b\u200c\u2060\ufeff]/g, '');

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
    const node = { type: 'text', text: invisible(decode(s)), line: lineAt(pos), parent: top() };
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

function parseDecl(text, line) {
  const colon = text.indexOf(':');
  if (colon < 0) return null;
  const prop = text.slice(0, colon).trim().toLowerCase();
  if (!prop || /[\s{}&]/.test(prop)) return null;
  const raw = text.slice(colon + 1);
  const important = /!\s*important/i.test(raw);
  return { prop, value: raw.replace(/!\s*important/i, '').trim(), line, important };
}

function parseDecls(body, offset, lineAt) {
  const decls = [];
  for (const part of splitTop(body, ';')) {
    const lead = part.text.length - part.text.trimStart().length;
    const d = parseDecl(part.text, lineAt(offset + part.at + lead));
    if (d) decls.push(d);
  }
  return decls;
}

// A nested selector written inside a parent rule, joined onto each parent selector.
function nestSelectors(prelude, parents) {
  const own = splitTop(prelude, ',').map((p) => p.text.trim()).filter(Boolean);
  if (!parents) return own;
  const out = [];
  for (const parent of parents) for (const s of own) out.push(s.includes('&') ? s.replace(/&/g, parent) : `${parent} ${s}`);
  return out;
}

// Does an @media query hold on a desktop screen about 1280px wide?
function mediaOnDesktop(query) {
  const q = String(query || '').toLowerCase();
  if (!q) return true;
  return splitTop(q, ',').some(({ text }) => {
    const t = text.trim();
    if (/^not\b/.test(t)) return true;
    if (/\bprint\b/.test(t) && !/\bscreen\b|\ball\b/.test(t)) return false;
    for (const m of t.matchAll(/max-width\s*:\s*([\d.]+)(px|em|rem)?/g)) if (parseFloat(m[1]) * (m[2] && m[2] !== 'px' ? 16 : 1) < 1280) return false;
    for (const m of t.matchAll(/min-width\s*:\s*([\d.]+)(px|em|rem)?/g)) if (parseFloat(m[1]) * (m[2] && m[2] !== 'px' ? 16 : 1) > 1280) return false;
    for (const m of t.matchAll(/width\s*<=?\s*([\d.]+)(px)?/g)) if (parseFloat(m[1]) < 1280) return false;
    return true;
  });
}

// Rules of a style sheet: [{ selector, decls, line, at, media }]. `at` names the at-rule a rule sits
// in ('media', 'supports', 'theme'), or is 'font-face', 'keyframes' (selector is the animation name,
// frames holds each step) or 'import'. Native css nesting is read: a nested rule gets its full
// selector, and declarations written straight inside an at-rule (tailwind @theme) apply to :root.
function cssRules(input, baseLine = 1) {
  const css = stripCssComments(String(input || ''));
  const local = lineIndex(css);
  const lineAt = (pos) => local(pos) + baseLine - 1;
  const rules = [];
  const block = (from, to, parents, at, media) => {
    const decls = [];
    let i = from;
    while (i < to) {
      let j = i, quote = null, paren = 0;
      while (j < to) {
        const c = css[j];
        if (quote) { if (c === quote && css[j - 1] !== '\\') quote = null; } else if (c === '"' || c === "'") quote = c;
        else if (c === '(') paren++; else if (c === ')') paren--;
        else if (paren <= 0 && (c === '{' || c === ';' || c === '}')) break;
        j++;
      }
      const seg = css.slice(i, j);
      const prelude = seg.trim();
      const preludeAt = i + (seg.length - seg.trimStart().length);
      if (j >= to || css[j] !== '{') {
        if (/^@import\b/i.test(prelude)) rules.push({ selector: prelude, decls: [], line: lineAt(preludeAt), at: 'import' });
        else if (prelude && !prelude.startsWith('@')) { const d = parseDecl(prelude, lineAt(preludeAt)); if (d) decls.push(d); }
        i = j + 1;
        continue;
      }
      let depth = 1, k = j + 1; quote = null;
      while (k < to && depth > 0) {
        const c = css[k];
        if (quote) { if (c === quote && css[k - 1] !== '\\') quote = null; } else if (c === '"' || c === "'") quote = c;
        else if (c === '{') depth++; else if (c === '}') depth--;
        k++;
      }
      const bodyEnd = depth === 0 ? k - 1 : to;
      const atm = /^@([\w-]+)\s*(.*)$/s.exec(prelude);
      if (atm) {
        const name = atm[1].toLowerCase();
        if (/^(?:-\w+-)?keyframes$/.test(name)) {
          const frames = [];
          const holder = { push: (r) => frames.push(r) };
          const before = rules.length;
          block(j + 1, bodyEnd, null, 'frame', media);
          for (const r of rules.splice(before)) holder.push({ selector: r.selector, decls: r.decls });
          rules.push({ selector: atm[2].trim().replace(/^["']|["']$/g, ''), decls: [], frames, line: lineAt(preludeAt), at: 'keyframes' });
        } else if (name === 'font-face') {
          rules.push({ selector: '@font-face', decls: parseDecls(css.slice(j + 1, bodyEnd), j + 1, lineAt), line: lineAt(preludeAt), at: 'font-face' });
        } else {
          const rule = { selector: parents ? parents.join(', ') : ':root', decls: [], line: lineAt(preludeAt), at: name, media: name === 'media' ? atm[2].trim() : media };
          const at0 = rules.length;
          rules.push(rule);
          rule.decls = block(j + 1, bodyEnd, parents, name, rule.media);
          if (!rule.decls.length) rules.splice(at0, 1);
        }
      } else if (prelude) {
        const sels = at === 'frame' ? [prelude] : nestSelectors(prelude, parents);
        const rule = { selector: sels.join(', '), decls: [], line: lineAt(preludeAt), at: at || null, media: media || null };
        rules.push(rule);
        rule.decls = block(j + 1, bodyEnd, at === 'frame' ? null : sels, at, media);
      }
      i = k;
    }
    return decls;
  };
  try { block(0, css.length, null, null, null); } catch { /* keep what was read */ }
  return rules;
}

function inlineDecls(el) {
  const s = el.attrs && el.attrs.style;
  if (!s) return [];
  return parseDecls(stripCssComments(s), 0, () => el.line);
}

// --- selectors ----------------------------------------------------------------

const DYNAMIC = new Set(['hover', 'focus', 'focus-within', 'focus-visible', 'active', 'visited', 'target', 'checked', 'disabled',
  'placeholder-shown', 'invalid', 'valid', 'open', 'popover-open', 'fullscreen', 'modal', 'user-invalid', 'autofill', 'indeterminate']);
const PSEUDO_EL = new Set(['before', 'after']);
const OTHER_PSEUDO_EL = /^(?:first-letter|first-line|selection|placeholder|marker|backdrop|file-selector-button|-webkit-.+|-moz-.+|-ms-.+|part|slotted|cue|highlight|spelling-error|grammar-error|target-text|view-transition.*)$/;

// Split a selector into compounds joined by combinators, outside brackets and parens.
function splitCompounds(sel) {
  const s = sel.trim().replace(/\s*([>+~])\s*/g, '$1').replace(/\s+/g, ' ');
  const parts = [];
  let depth = 0, from = 0, comb = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && (c === ' ' || c === '>' || c === '+' || c === '~')) {
      if (i > from) parts.push({ text: s.slice(from, i), comb });
      comb = c;
      from = i + 1;
    }
  }
  if (from < s.length) parts.push({ text: s.slice(from), comb });
  return parts;
}

function parseCompound(text) {
  const c = { tag: null, classes: [], id: null, attrs: [], pseudo: null, nots: [], ises: [], pos: [], spec: 0 };
  let i = 0;
  const m0 = /^(?:[a-zA-Z][\w-]*|\*)/.exec(text);
  if (m0) { c.tag = m0[0].toLowerCase(); if (c.tag !== '*') c.spec += 1; i = m0[0].length; }
  while (i < text.length) {
    const rest = text.slice(i);
    let m;
    if ((m = /^\.((?:\\.|[\w-])+)/.exec(rest))) { c.classes.push(m[1].replace(/\\(.)/g, '$1')); c.spec += 100; }
    else if ((m = /^#((?:\\.|[\w-])+)/.exec(rest))) { c.id = m[1].replace(/\\(.)/g, '$1'); c.spec += 10000; }
    else if ((m = /^\[\s*([\w:-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?\s*(?:[is]\s*)?\]/.exec(rest))) {
      c.attrs.push({ name: m[1].toLowerCase(), op: m[2], value: m[3] != null ? m[3] : m[4] != null ? m[4] : m[5] });
      c.spec += 100;
    } else if ((m = /^::?([\w-]+)(?:\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\))?/.exec(rest))) {
      const name = m[1].toLowerCase();
      const arg = m[2];
      if (PSEUDO_EL.has(name)) c.pseudo = name;
      else if (OTHER_PSEUDO_EL.test(name) && (rest[1] === ':' || /^(?:first-letter|first-line|selection|placeholder|marker)$/.test(name))) return null;
      else if (DYNAMIC.has(name)) return null;
      else if (name === 'root') { c.tag = 'html'; c.spec += 100; }
      else if (arg != null && /^(?:is|where|matches|-webkit-any|-moz-any|not)$/.test(name)) {
        const list = splitTop(arg, ',').map((p) => compileSelector(p.text)).filter(Boolean);
        if (name === 'not') { if (list.length) c.nots.push(list); } else if (list.length) c.ises.push(list); else return null;
        if (name !== 'where') c.spec += Math.max(0, ...list.map((x) => x.spec));
      } else if (/^(?:first|last|only)-(?:child|of-type)$/.test(name)) { c.pos.push(name); c.spec += 100; }
      else c.spec += 100; // other pseudo-classes (nth-child, has, lang) are read as always true
    } else break;
    i += m[0].length;
  }
  if (i < text.length) return null;
  return c;
}

const compiledCache = new Map();
function compileSelector(sel) {
  if (compiledCache.has(sel)) return compiledCache.get(sel);
  let out = null;
  const parts = splitCompounds(sel);
  if (parts.length) {
    const comps = [];
    for (const p of parts) { const c = parseCompound(p.text); if (!c) { comps.length = 0; break; } comps.push({ c, comb: p.comb }); }
    if (comps.length) out = { parts: comps, spec: comps.reduce((n, x) => n + x.c.spec, 0), pseudo: comps[comps.length - 1].c.pseudo };
  }
  compiledCache.set(sel, out);
  return out;
}

function classList(el) {
  const c = el.attrs && el.attrs.class;
  return c ? c.split(/\s+/).filter(Boolean) : [];
}
const elKids = (el) => (el.parent ? el.parent.children.filter((x) => x.type === 'el') : [el]);

function matchesCompound(el, c) {
  if (!el || el.type !== 'el' || el.tag === '#root') return false;
  if (c.tag && c.tag !== '*' && c.tag !== el.tag) return false;
  if (c.id && (el.attrs.id || '') !== c.id) return false;
  if (c.classes.length) {
    const have = new Set(classList(el));
    for (const k of c.classes) if (!have.has(k)) return false;
  }
  for (const a of c.attrs) {
    if (!(a.name in el.attrs)) return false;
    const v = el.attrs[a.name], w = a.value;
    if (a.op === '=' && v !== w) return false;
    if (a.op === '~=' && !v.split(/\s+/).includes(w)) return false;
    if (a.op === '^=' && !v.startsWith(w)) return false;
    if (a.op === '$=' && !v.endsWith(w)) return false;
    if (a.op === '*=' && !v.includes(w)) return false;
    if (a.op === '|=' && v !== w && !v.startsWith(`${w}-`)) return false;
  }
  for (const list of c.nots) if (list.some((s) => matchesSelector(el, s))) return false;
  for (const list of c.ises) if (!list.some((s) => matchesSelector(el, s))) return false;
  for (const p of c.pos) {
    const sibs = elKids(el).filter((x) => !/of-type/.test(p) || x.tag === el.tag);
    if (p.startsWith('first') && sibs[0] !== el) return false;
    if (p.startsWith('last') && sibs[sibs.length - 1] !== el) return false;
    if (p.startsWith('only') && sibs.length !== 1) return false;
  }
  return true;
}

function matchesFrom(el, parts, k) {
  if (!matchesCompound(el, parts[k].c)) return false;
  if (k === 0) return true;
  const comb = parts[k].comb;
  if (comb === '>') return matchesFrom(el.parent, parts, k - 1);
  if (comb === ' ') { for (let a = el.parent; a && a.tag !== '#root'; a = a.parent) if (matchesFrom(a, parts, k - 1)) return true; return false; }
  const sibs = elKids(el);
  const at = sibs.indexOf(el);
  if (comb === '+') return at > 0 && matchesFrom(sibs[at - 1], parts, k - 1);
  if (comb === '~') { for (let x = at - 1; x >= 0; x--) if (matchesFrom(sibs[x], parts, k - 1)) return true; }
  return false;
}
function matchesSelector(el, compiled) {
  return !!compiled && matchesFrom(el, compiled.parts, compiled.parts.length - 1);
}
// --- utility classes ----------------------------------------------------------

const BLUR = { none: 0, sm: 4, '': 8, md: 12, lg: 16, xl: 24, '2xl': 40, '3xl': 64 };
const arb = (s) => s.replace(/^\[|\]$/g, '').replace(/_/g, ' ').replace(/^'|'$/g, '');

// A map for common utility classes (tailwind style) to the declarations they stand for. A
// before: or after: variant styles that pseudo-element; hover and focus variants are skipped.
function utilityDecls(cls) {
  const variants = cls.replace(/\[[^\]]*\]/g, '').split(':').slice(0, -1);
  if (variants.some((v) => /^(?:hover|focus|active|group-hover|peer-hover|focus-within|focus-visible|disabled|visited|checked|dark|print)$/.test(v))) return [];
  const pseudo = variants.includes('before') ? 'before' : variants.includes('after') ? 'after' : null;
  const lastColon = (() => { let depth = 0, at = -1; for (let i = 0; i < cls.length; i++) { if (cls[i] === '[') depth++; else if (cls[i] === ']') depth--; else if (cls[i] === ':' && depth === 0) at = i; } return at; })();
  const base = cls.slice(lastColon + 1).replace(/^!|!$/g, '').replace(/^-/, '');
  const d = (prop, value) => ({ prop, value, util: cls, pseudo });
  let m;
  if ((m = /^\[([\w-]+):(.+)\]$/.exec(base))) return [d(m[1].toLowerCase(), arb(m[2]))];
  if (base === 'border') return [d('border', '1px solid currentColor')];
  if ((m = /^border-([2-8])$/.exec(base))) return [d('border', `${m[1]}px solid currentColor`)];
  if ((m = /^border-(?:l|s)(?:-(\d+)|-(\[[^\]]+\]))?$/.exec(base))) return [d('border-left', `${m[1] || (m[2] ? arb(m[2]) : 1)}${m[2] ? '' : 'px'} solid currentColor`)];
  if (/^ring(?:-\d+)?$/.test(base)) return [d('box-shadow', `0 0 0 ${(/\d+/.exec(base) || [3])[0]}px currentColor`)];
  if ((m = /^shadow-(\[.+\])$/.exec(base))) return [d('box-shadow', arb(m[1]))];
  if (/^shadow(?:-(?:sm|md|lg|xl|2xl|inner))?$/.test(base)) return [d('box-shadow', base === 'shadow-inner' ? 'inset 0 2px 4px rgba(0,0,0,.05)' : '0 1px 3px rgba(0,0,0,.1)')];
  if (base === 'shadow-none') return [d('box-shadow', 'none')];
  if (/^rounded(?:-.+)?$/.test(base) && base !== 'rounded-none') return [d('border-radius', '8px')];
  if (/^bg-radial(?:-.+)?$/.test(base)) return [d('background-image', 'radial-gradient(circle, currentColor, transparent)')];
  if ((m = /^bg-(.+)$/.exec(base))) {
    const v = m[1];
    if (/^\[.*radial-gradient/.test(v)) return [d('background-image', arb(v))];
    if (v === 'clip-text') return [d('background-clip', 'text')];
    if (/^(?:transparent|none|inherit|current|clip-.+|origin-.+|fixed|local|scroll|center|cover|contain|no-repeat|repeat.*|bottom|top|left|right|auto|gradient-.+|linear-.+|conic.*|opacity-.+|blend-.+)$/.test(v)) return [];
    return [d('background-color', v)];
  }
  if (/^p[xytrbl]?-(?:\d|\[|px)/.test(base) && !/^p[xytrbl]?-0$/.test(base)) return [d('padding', '8px')];
  if (base === 'uppercase') return [d('text-transform', 'uppercase')];
  if (base === 'italic') return [d('font-style', 'italic')];
  if (base === 'not-italic') return [d('font-style', 'normal')];
  if ((m = /^font-(\[.+\])$/.exec(base))) return [d('font-family', arb(m[1]))];
  if (/^font-(?:serif|mono|sans)$/.test(base)) return [d('font-family', `var(--font-${base.slice(5)}, ${base.slice(5)})`)];
  if ((m = /^animate-(pulse|ping|bounce|spin)$/.exec(base))) return [d('animation', `${m[1]} 1s infinite`)];
  if ((m = /^animate-(\[.+\])$/.exec(base))) return [d('animation', arb(m[1]))];
  if ((m = /^animate-([\w-]+)$/.exec(base)) && m[1] !== 'none') return [d('animation', `var(--animate-${m[1]})`)];
  if ((m = /^blur(?:-(none|sm|md|lg|xl|2xl|3xl))?$/.exec(base))) return [d('filter', `blur(${BLUR[m[1] || '']}px)`)];
  if ((m = /^blur-(\[.+\])$/.exec(base))) return [d('filter', `blur(${arb(m[1])})`)];
  if ((m = /^backdrop-blur(?:-(none|sm|md|lg|xl|2xl|3xl|\[.+\]))?$/.exec(base))) return [d('backdrop-filter', `blur(${m[1] && m[1][0] === '[' ? arb(m[1]) : `${BLUR[m[1] || ''] == null ? 8 : BLUR[m[1] || '']}px`})`)];
  if (base === 'hidden') return [d('display', 'none')];
  if (base === 'invisible') return [d('visibility', 'hidden')];
  if (base === 'sr-only') return [d('display', 'none')];
  if (base === 'grid') return [d('display', 'grid')];
  if (base === 'flex') return [d('display', 'flex')];
  if (/^grid-cols-([2-9]|1[0-2])$/.test(base)) return [d('grid-template-columns', 'repeat(2, 1fr)')];
  if (/^(?:block|inline|inline-block|inline-flex)$/.test(base)) return [d('display', base)];
  if ((m = /^w-(\d+(?:\.5)?|px)$/.exec(base))) return [d('width', m[1] === 'px' ? '1px' : `${parseFloat(m[1]) * 4}px`)];
  if (/^(?:absolute|relative|fixed|sticky)$/.test(base)) return [d('position', base)];
  if (/^(?:left|inset-x|inset)-0$/.test(base)) return [d('left', '0')];
  if (/^inset-y-0$/.test(base)) return [d('top', '0'), d('bottom', '0')];
  if (/^h-full$/.test(base)) return [d('height', '100%')];
  if (pseudo && /^content-/.test(base)) return [d('content', `"${arb(base.slice(8))}"`)];
  return [];
}

// --- declarations for a node ----------------------------------------------------

function sheetFor(page) {
  if (page._sheet) return page._sheet;
  const rules = [];
  for (const s of page.styles) for (const r of cssRules(s.text, s.line)) rules.push(r);
  const compiled = [];
  const vars = {};
  rules.forEach((r, order) => {
    if (r.at === 'font-face' || r.at === 'keyframes' || r.at === 'import') return;
    for (const d of r.decls) if (d.prop.startsWith('--')) vars[d.prop] = d.value;
    for (const sel of splitTop(r.selector, ',')) {
      const c = compileSelector(sel.text);
      if (c) compiled.push({ c, rule: r, selector: sel.text.trim(), order, desktop: mediaOnDesktop(r.media) });
    }
  });
  for (const el of page.all) for (const d of inlineDecls(el)) if (d.prop.startsWith('--')) vars[d.prop] = d.value;
  compiled.sort((a, b) => a.c.spec - b.c.spec || a.order - b.order);
  page._sheet = { rules, compiled, vars };
  return page._sheet;
}

// Put the value of each var(--x, fallback) into a css value.
function resolveVars(value, lookup, depth = 0) {
  if (!value || value.indexOf('var(') < 0 || depth > 6) return value;
  return value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g, (all, name, fallback) => {
    const v = lookup(name);
    if (v != null) return resolveVars(v, lookup, depth + 1);
    return fallback != null ? resolveVars(fallback.trim(), lookup, depth + 1) : all;
  });
}

function rawDecls(node, page) {
  page._raw = page._raw || new Map();
  page._seq = page._seq || 0;
  if (page._raw.has(node)) return page._raw.get(node);
  const out = { map: {}, list: [], pseudo: { before: {}, after: {} }, pseudoList: { before: [], after: [] } };
  const put = (where, decl) => {
    const target = where ? out.pseudo[where] : out.map;
    const prev = target[decl.prop];
    if (prev && prev.important && !decl.important) return;
    target[decl.prop] = { value: decl.value, line: decl.line, important: decl.important, seq: ++page._seq };
    (where ? out.pseudoList[where] : out.list).push(decl);
  };
  for (const cls of classList(node)) for (const u of utilityDecls(cls)) put(u.pseudo, { ...u, line: node.line });
  for (const { c, rule, desktop } of sheetFor(page).compiled) {
    if (!desktop || !matchesSelector(node, c)) continue;
    for (const decl of rule.decls) put(c.pseudo, decl);
  }
  for (const decl of inlineDecls(node)) put(null, decl);
  page._raw.set(node, out);
  return out;
}

// The declarations that apply to a node: utility classes, then style rules matched by their full
// selector (ancestors, siblings, :is, :not) in order of specificity and source, then the inline
// style, with !important kept. Rules inside an @media that does not hold on a desktop screen are
// left out. var() values are filled in from the node, its ancestors, then the whole page.
// Returns { map: {prop: {value, line}}, list, pseudo: { before: map, after: map } }.
function declsFor(node, page) {
  if (!node || node.type !== 'el') return { map: {}, list: [], pseudo: { before: {}, after: {} }, pseudoList: { before: [], after: [] } };
  page._decls = page._decls || new Map();
  if (page._decls.has(node)) return page._decls.get(node);
  const raw = rawDecls(node, page);
  const sheet = sheetFor(page);
  const lookup = (name) => {
    for (let a = node; a && a.tag !== '#root'; a = a.parent) { const m = rawDecls(a, page).map[name]; if (m) return m.value; }
    return sheet.vars[name];
  };
  const fill = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.value.indexOf('var(') >= 0 ? { ...v, value: resolveVars(v.value, lookup) } : v]));
  const out = { map: fill(raw.map), list: raw.list, pseudo: { before: fill(raw.pseudo.before), after: fill(raw.pseudo.after) }, pseudoList: raw.pseudoList };
  page._decls.set(node, out);
  return out;
}

// --- text helpers ---------------------------------------------------------------

const squash = (s) => s.replace(/\s+/g, ' ').trim();

// Hidden from the eye: not shown, display none, visibility hidden, or the screen-reader-only
// pattern (a 1px clipped box). aria-hidden hides from screen readers only, so it stays visible.
function hiddenEl(el, page) {
  if (NOT_SHOWN.has(el.tag)) return true;
  if ('hidden' in el.attrs) return true;
  if (!page) return false;
  const m = declsFor(el, page).map;
  const v = (p) => (m[p] ? m[p].value.trim().toLowerCase() : '');
  if (/^none\b/.test(v('display')) || /^(?:hidden|collapse)\b/.test(v('visibility'))) return true;
  const tiny = (p) => { const n = /^([\d.]+)px$/.exec(v(p)); return n && +n[1] <= 1; };
  if (/absolute|fixed/.test(v('position')) && (/rect\(\s*0/.test(v('clip')) || /inset\(\s*50%/.test(v('clip-path')) || (tiny('width') && tiny('height')))) return true;
  return false;
}

function isHidden(node, page) {
  for (let el = node && node.type === 'el' ? node : node && node.parent; el && el.tag !== '#root'; el = el.parent) {
    if (hiddenEl(el, page)) return true;
  }
  return false;
}

// Text a ::before or ::after draws: quoted strings and attr() values, not counters or icon-font glyphs.
function pseudoText(el, page, where) {
  if (!page) return '';
  const c = declsFor(el, page).pseudo[where].content;
  if (!c || /^(?:none|normal)$/i.test(c.value.trim())) return '';
  let out = '';
  for (const m of c.value.matchAll(/"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|attr\(\s*([\w-]+)\s*\)/g)) {
    if (m[3]) out += el.attrs[m[3].toLowerCase()] || '';
    else out += (m[1] != null ? m[1] : m[2]).replace(/\\([0-9a-f]{1,6})\s?/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } }).replace(/\\(.)/g, '$1');
  }
  return out.replace(/[\uE000-\uF8FF]/g, '');
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
    parts.push(pseudoText(n, page, 'before'), n === node ? ' ' : '');
    for (const c of n.children) {
      if (c.type === 'text') parts.push(c.text);
      else if (!hiddenEl(c, page)) {
        if (c.tag === 'br') parts.push(' ');
        if (!INLINE.has(c.tag)) parts.push(' ');
        walk(c);
        if (!INLINE.has(c.tag)) parts.push(' ');
      }
    }
    parts.push(n === node ? ' ' : '', pseudoText(n, page, 'after'));
  };
  walk(node);
  return squash(parts.join(''));
}

module.exports = { parsePage, cssRules, declsFor, ownText, visibleText, pseudoText, isHidden, decode, compileSelector, matchesSelector, matchesCompound, classList, utilityDecls, sheetFor, resolveVars, mediaOnDesktop, INLINE };
