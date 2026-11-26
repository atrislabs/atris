// Page rules about the shape of the page: cards, frames and bars.

const { declsFor, visibleText, isHidden, splitTop, INLINE } = require('../page-scan');
const { SAID, HEADING, BODY_PX, TITLE_WORDS, ICON_PX, BAR_PX, kids, descendants, textOnly, words, ancestor, inside, flow, displayOf, lookDecls, pxValue, colourNeutral, shadows, borderSides, fillOf, boxedParts, boxed, barColour, sideBar, solidGradient, gradientBar, pseudoBar, scriptOnly, smallIcon, iconLike, NUMBER_TOKEN } = require('./shared');

// What every rule here can see.
const SEEN = 'found in the page source and the style sheets it links from its own folder: blocks a script builds are seen only through style rules that name them';

module.exports = [
  {
    id: 'page-card-grid', group: 'shape',
    line: 'No grid of three or more same-shaped cards, each with its own heading or icon.',
    why: `a grid of matching cards: the reader skims all of them and reads none. cards are blocks laid out side by side or boxed, each opening with a heading, a bold title or an icon; stacked plain sections are not cards, while blocks that each open with an icon count even when stacked. ${SEEN}`,
    fix: 'write it as one list or a few sentences, or a table if it is data',
    maybe: 'only a class name such as icon or chevron marked what each block opens with as an icon and the class may name something else',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      const NO = new Set(['select', 'datalist', 'table', 'thead', 'tbody', 'head', 'svg', 'menu']);
      // a plain wrapper around one card is looked through
      const unwrap = (b) => { let x = b; while (kids(x, page).length === 1 && !x.children.some((c) => c.type === 'text' && c.text.trim())) x = kids(x, page)[0]; return x; };
      // a card opens with a heading (any level below the page title), a short line set wholly in bold, or an icon
      // (a heading followed by bare text counts as two parts)
      const lead = (b) => {
        const first = kids(b, page)[0];
        if (!first || (kids(b, page).length < 2 && !(HEADING.test(first.tag) && b.children.some((c) => c.type === 'text' && /\p{L}{2}/u.test(c.text))))) return null;
        const heads = descendants(b).filter((d) => HEADING.test(d.tag));
        if (heads.length) return 'h';
        if (smallIcon(first, page)) return 'icon';
        const icon = !['img', 'picture'].includes(first.tag) && iconLike(first, page);
        if (icon) return icon === 'name' ? 'named icon' : 'icon';
        // an empty painted tile of icon size (a rounded square with a picture painted in)
        const fm = declsFor(first, page).map;
        if (!visibleText(first, page) && !kids(first, page).length && (fillOf(fm) || /url\(/.test((fm.background || fm['background-image'] || { value: '' }).value)) && ['width', 'height'].every((p) => fm[p] && pxValue(fm[p].value) != null && pxValue(fm[p].value) <= ICON_PX)) return 'icon';
        const t = visibleText(first, page);
        if (textOnly(first, page) && t && [...t.replace(/\s/g, '')].length <= 2 && !/[\p{L}\p{N}]/u.test(t)) return 'icon';
        if (!t && descendants(first).some((d) => smallIcon(d, page))) return 'icon';
        const bold = (x) => ['b', 'strong'].includes(x.tag) || /^(?:[6-9]00|bold)/.test((declsFor(x, page).map['font-weight'] || { value: '' }).value);
        const strongKids = (x) => { const k = kids(x, page); return k.length === 1 && bold(k[0]) && visibleText(k[0], page) === visibleText(x, page); };
        // a title line: set in bold, or set larger than body text
        const larger = (x) => (pxValue((declsFor(x, page).map['font-size'] || { value: '' }).value) || 0) > BODY_PX;
        if (t && words(t).length <= TITLE_WORDS && (bold(first) || strongKids(first) || (strongKids(first.children.length ? first : b)) || (textOnly(first, page) && larger(first) && /\p{L}{2}/u.test(t)))) return 'h';
        return null;
      };
      const block = (k) => !HEADING.test(k.tag) && (!INLINE.has(k.tag) || displayOf(k, page) !== 'inline' || kids(k, page).some((x) => !INLINE.has(x.tag)));
      // side by side: a grid or flex row, inline boxes, table cells, floats, or blocks pinned at different
      // left offsets. in newspaper columns blocks sit side by side only when each gets a column of its own or
      // is kept from breaking across columns; more blocks than columns flow as running text
      const laidOut = (p) => {
        const m = declsFor(p, page).map;
        const cols = parseInt((m.columns || m['column-count'] || { value: '' }).value, 10);
        const blocks = kids(p, page).filter(block);
        return (m.display && /grid|flex/.test(m.display.value) && !/column/.test((m['flex-direction'] || { value: '' }).value)) || !!m['grid-template-columns'] ||
          (cols >= 2 && (cols >= blocks.length || blocks.every((k) => /avoid/.test((declsFor(k, page).map['break-inside'] || { value: '' }).value))));
      };
      const placed = (w) => { const m = declsFor(w, page).map; return /absolute|fixed/.test((m.position || { value: '' }).value) && !!(m.left || m.right); };
      // the shape of a card is what it opens with, not its tag or class names
      const cardsOf = (p) => { const row = laidOut(p); return kids(p, page).filter(block).map((w) => { const b = unwrap(w); return { b, tag: b.tag, key: `${lead(b)}`, side: row || /inline-(?:block|flex|grid)|table-cell/.test(displayOf(w, page)) || /left|right/.test((declsFor(w, page).map.float || { value: '' }).value) || placed(w) }; })
        .filter((c) => c.key !== 'null' && (!['ul', 'ol'].includes(p.tag) || c.key === 'h') && (p.tag !== 'tr' || descendants(c.b).some((d) => HEADING.test(d.tag)))); };
      // footer link columns (a heading over a list of links) are navigation; cards with their own words are not
      const footer = (x) => x.tag === 'footer' || x.attrs.role === 'contentinfo';
      const linkColumn = (c) => { const linkText = descendants(c.b).filter((d) => d.tag === 'a' || HEADING.test(d.tag)).map((d) => visibleText(d, page)).join(' '); return words(visibleText(c.b, page)).length - words(linkText).length < 4; };
      for (const parent of [page.root, ...page.all]) {
        if (NO.has(parent.tag) || isHidden(parent, page)) continue;
        const inFooter = footer(parent) || !!ancestor(parent, footer);
        let cards = cardsOf(parent).filter((c) => !inFooter || !linkColumn(c));
        // rows of cards: a grid split into rows of two still reads as one grid
        const rows = kids(parent, page).filter(block);
        if (cards.length < 3 && rows.length >= 2 && rows.every((r) => laidOut(r) && cardsOf(r).length >= 1)) cards = rows.flatMap(cardsOf).filter((c) => !inFooter || !linkColumn(c));
        if (cards.length < 3) continue;
        const groups = new Map();
        for (const c of cards) { if (!groups.has(c.key)) groups.set(c.key, []); groups.get(c.key).push(c); }
        for (const [key, same] of groups) {
          if (same.length < 3) continue;
          // icon-led blocks read as cards even when stacked
          const short = key !== 'h' && !['ul', 'ol'].includes(parent.tag);
          if (short || same.every((c) => c.side) || same.every((c) => boxed(c.b, page))) { hit(parent.line, `${same.length} blocks shaped ${same[0].tag} with ${key === 'h' ? 'a heading' : 'an icon'}`, key === 'named icon' ? 'warn' : 'error'); break; }
        }
      }
    },
  },

  {
    id: 'page-card-in-card', group: 'shape',
    line: 'No boxed element inside another boxed element.',
    why: `a card inside a card: two frames around one thing. a page sheet or a coloured band with only a fill is not counted as the outer frame. a small inline mark (a pill, a key cap, an avatar), a progress fill or a search field is not counted as the inner card. ${SEEN}`,
    fix: 'keep one box and drop the inner frame',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      for (const el of page.all) {
        if (isHidden(el, page) || !boxed(el, page)) continue;
        // the inner box holds words or a picture. a phrasing tag or a box in a line of text set inline (a
        // pill, a key cap, an avatar) is a mark, not a card, unless it fills the width; so is a box holding only a number (a progress fill) or only
        // form controls (a search field)
        const picture = descendants(el).some((d) => ['img', 'picture', 'video', 'svg', 'canvas'].includes(d.tag));
        const holds = picture || (visibleText(el, page) && !NUMBER_TOKEN.test(visibleText(el, page)));
        const fullWidth = /^100%$/.test((declsFor(el, page).map.width || { value: '' }).value.trim());
        const inLine = INLINE.has(el.tag) || (el.parent && el.parent.children.some((c) => c.type === 'text' && /\p{L}/u.test(c.text)));
        const inline = /^inline/.test(displayOf(el, page)) && !fullWidth && inLine;
        const controls = descendants(el).some((d) => ['input', 'select', 'textarea'].includes(d.tag) && !('readonly' in d.attrs)) && descendants(el).every((d) => ['input', 'select', 'textarea', 'button', 'label', 'option', 'svg', 'path', 'span', 'i'].includes(d.tag));
        if (!holds || inline || controls) continue;
        const outer = ancestor(el, (a) => { const b = boxedParts(a, page); return b && (b.border || b.shadow || b.radius); });
        if (outer) hit(el.line, `<${el.tag}> inside <${outer.tag}> (line ${outer.line})`);
      }
    },
  },

  {
    id: 'page-left-border', group: 'shape', replaces: ['side-stripe-card'],
    line: 'No coloured bar on the left edge of a block.',
    why: `a decorative left-edge bar, however it is drawn: a left border, a shadow, a gradient stop, a narrow first column or a ::before strip. a light grey rule between columns is a divider and a matching grey rule on both sides is a frame, not a bar. ${SEEN}`,
    fix: 'remove the bar; let spacing or a heading group the block',
    said: SAID.bars,
    check(ctx, hit) {
      const { page } = ctx;
      for (const el of page.all) {
        if (isHidden(el, page) || ['html', 'body'].includes(el.tag)) continue;
        const d = declsFor(el, page);
        const m = d.map;
        const v = (p) => (m[p] ? m[p].value.trim().toLowerCase() : '');
        const ln = (p) => (m[p] ? m[p].line : el.line);
        // a rule (hr) is a divider unless it is pinned to the left edge as a bar
        if (el.tag === 'hr') { if (pseudoBar({ ...m, content: m.content || { value: '""' } }, false)) hit(el.line, '<hr> drawn as a bar'); continue; }
        // the left side as the cascade leaves it, from every border form; a matching rule on the right
        // in grey or black makes a pair of side rules (a poem set between two lines), not a bar
        const each = borderSides(m);
        const drawnSide = (x) => x.w >= 2 && !/none|hidden/.test(x.style) && (barColour(x.colour) || x.colour === 'currentcolor' || !!v('border-image') || /gradient|url\(/.test(v('border-image-source')));
        const L = each.left, R = each.right;
        if (drawnSide(L) && !(drawnSide(R) && R.w === L.w && R.colour === L.colour && colourNeutral(L.colour) !== false)) { hit(L.line || el.line, `border-left: ${L.w}px ${L.style} ${L.colour}`); continue; }
        // a hard edge of shadow on the left, inside or outside the box
        // (a blur no wider than the bar still reads as a bar)
        const bar = shadows(v('box-shadow')).find((sh) => Math.abs(sh.y) <= 2 && sh.blur <= Math.max(2, Math.abs(sh.x)) && sh.spread <= 0 && barColour(sh.colour) && ((sh.inset && sh.x >= 2) || (!sh.inset && sh.x <= -2)));
        if (bar) { hit(ln('box-shadow'), `box-shadow: ${v('box-shadow')}`); continue; }
        // a gradient that stops a few pixels from the left, or a solid strip sized to a few pixels on the left
        const bgv = `${v('background')} ${v('background-image')}`;
        const g = gradientBar(bgv);
        if (g) { hit(ln(m.background ? 'background' : 'background-image'), `background: ${g}`); continue; }
        const strip = solidGradient(bgv);
        const size = (/\/\s*(\S+)\s+100%/.exec(bgv) || [])[1] || (/^(\S+)\s+100%/.exec(v('background-size')) || [])[1];
        if (strip && size && pxValue(size) >= BAR_PX.min && pxValue(size) <= BAR_PX.max && !/\bright\b/.test(bgv + v('background-position')) && /no-repeat|repeat-y/.test(bgv + v('background-repeat')) && barColour(strip[1])) { hit(ln(m.background ? 'background' : 'background-image'), `background: ${strip[0]} sized ${size}`); continue; }
        // a narrow first column or flex item holding nothing but paint: an empty element or the ::before
        const cols = splitTop((v('grid-template-columns') || (v('grid-template').split('/')[1] || '')).trim(), ' ').map((x) => x.text).filter(Boolean);
        const flex = /flex/.test(v('display')) && !/column/.test(v('flex-direction'));
        // the item shown first: in a grid the one placed in column 1, else the first written
        const gridCol = (x) => parseInt((declsFor(x, page).map['grid-column'] || declsFor(x, page).map['grid-column-start'] || { value: '' }).value, 10);
        const first = (/grid/.test(v('display')) && kids(el, page).find((x) => gridCol(x) === 1)) || kids(el, page)[0];
        // an empty painted item, or an svg holding only a painted shape
        const svgBar = (x) => x.tag === 'svg' && descendants(x).length && descendants(x).every((y) => ['rect', 'line', 'path'].includes(y.tag)) && descendants(x).some((y) => barColour(y.attrs.fill || y.attrs.stroke || ''));
        const emptyPaint = (x) => x && !visibleText(x, page) && ((!kids(x, page).length && barColour(fillOf(declsFor(x, page).map))) || svgBar(x));
        // a column width: a length, or the most a minmax() or fit-content() lets it grow
        const colPx = (c) => { const mm = /^(?:minmax\([^,]+,|fit-content\()\s*([\d.]+(?:px|rem|em))\s*\)$/.exec(c); return mm ? pxValue(mm[1]) : /^\d*\.?\d+(?:px|rem|em)$/.test(c) ? pxValue(c) : null; };
        const narrowCol = cols.length >= 2 && colPx(cols[0]) != null && colPx(cols[0]) >= BAR_PX.min && colPx(cols[0]) <= BAR_PX.max;
        if (narrowCol && /grid/.test(v('display')) && d.pseudo.before.content && barColour(fillOf(d.pseudo.before))) { hit(d.pseudo.before.content.line, `grid column of ${cols[0]} painted by ::before`); continue; }
        if (narrowCol && emptyPaint(first)) { hit(first.line, `grid column of ${cols[0]} painted ${fillOf(declsFor(first, page).map)}`); continue; }
        const firstW = first && pxValue((declsFor(first, page).map.width || { value: first.attrs.width || '' }).value);
        if (flex && emptyPaint(first) && (pseudoBar(declsFor(first, page).map, true) || (svgBar(first) && firstW != null && firstW >= BAR_PX.min && firstW <= BAR_PX.max))) { hit(first.line, `<${first.tag}> drawn as a bar`); continue; }
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
];
