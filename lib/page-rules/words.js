// Page rules about the words on the page: what is written and how it is set.

const { cssRules, declsFor, visibleText, pseudoText, isHidden, classList, sheetFor, splitTop, INLINE } = require('../page-scan');
const { SAID, HEADING, TABLE_PARTS, ICON_TAGS, BODY_PX, H1_PX, H2_PX, SMALLER, LABEL_WORDS, TITLE_WORDS, PROSE_WORDS, ICON_PX, DOT_PX, PLACEHOLDER, classWords, hasClassWord, kids, nextEl, prevEl, descendants, textOnly, headingLike, words, ancestor, inside, codeLike, readText, textNodes, english, flow, displayOf, lineOf, lookDecls, targets, pxValue, hasSource, borderWidth, boxed, shownAbove, smallIcon, iconFontName, isButton, hasArrow, drawnChevron, drawnShape, iconLike, drawnDot, SPARKLE, DOT_CHARS, emojiAt, EMOJI_RUN, NUMBER_TOKEN, ABBR } = require('./shared');

const LIST_MARK = /^(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\.$/i;

// What every rule here can see.
const SEEN = 'found in the page source: words a script writes after the page loads are not read';

module.exports = [
  {
    id: 'page-subtitle', group: 'words',
    line: 'No line of supporting text right under a heading.',
    why: `subtitle under a heading: the heading alone carries it, so cut the line. a heading followed by two or more paragraphs of prose (a paragraph of two sentences or twenty words, then another) is an article and passes. a byline, a one-sentence dateline and a line that ends in a colon before its list pass. a heading reaches only to the end of its section. a form label is part of its form. ${SEEN}`,
    fix: 'delete the supporting line, or make it the content itself',
    maybe: 'only a class name such as sub, lede or desc marked this line as a subtitle and the class may name something else',
    said: SAID.subtitle,
    check(ctx, hit) {
      const { page } = ctx;
      const ROLE = ['sub', 'subtitle', 'subhead', 'subheading', 'lede', 'lead', 'tagline', 'kicker', 'desc', 'description', 'caption', 'intro', 'summary', 'why', 'meta', 'eyebrow'];
      const all = flow(page);
      const rank = (it) => (it.big ? 1 : +it.el.tag[1] || 2);
      const isParagraph = (it) => it && it.kind === 'text' && (it.el.tag === 'p' || it.el.tag === 'blockquote' || inside(it.el, new Set(['blockquote'])));
      const SECTIONS = new Set(['section', 'article', 'aside', 'main', 'header', 'footer']);
      for (let j = 0; j < all.length; j++) {
        const h = all[j];
        if (h.kind !== 'heading' || rank(h) > 3) continue;
        // a heading reaches only to the end of its own section: what follows the section is not under it
        const box = ancestor(h.el, (a) => SECTIONS.has(a.tag));
        const mine = box && new Set([box, ...descendants(box)]);
        const end = box ? all.findIndex((it, k) => k > j && !mine.has(it.el)) : -1;
        const items = all.slice(j, end < 0 ? all.length : end), i = 0;
        const next = items[i + 1], after = items[i + 2];
        if (!next) continue;
        // a lower heading right under the h1 that has nothing of its own under it
        // or a lower heading set light, not bold, right under the h1: a subtitle written as a heading
        const light = (x) => /^(?:[1-4]00|normal|lighter)$/.test((declsFor(x.el, page).map['font-weight'] || { value: '' }).value.trim());
        if (next.kind === 'heading' && rank(h) === 1 && rank(next) > 1 && !next.big && (!after || ['action', 'nav'].includes(after.kind) || (after.kind === 'heading' && rank(after) <= rank(next)) || (after.kind === 'content' && light(next)))) {
          hit(next.line, next.text);
          continue;
        }
        if (next.kind !== 'text' || !/\p{L}{2}/u.test(next.text)) continue;
        // a byline or a dateline (By Ana Lee; Last updated November 1, 2026) says who and when, not what
        // the page is. figures and length alone do not clear a line: the owner's labelled pages hold
        // long and numbered subtitles
        const DATE = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{4}-\d{2}-\d{2}\b/i;
        if (/^by\s+\p{Lu}/u.test(next.text) || (DATE.test(next.text) && (next.text.match(/[.!?](?:\s|$)/g) || []).length <= 1)) continue;
        // the element right after the heading names the role, whether it is the line or wraps it
        const sib = nextEl(h.el, page);
        const named = hasClassWord(next.el, ROLE) || (sib && descendants(sib).includes(next.el) && hasClassWord(sib, ROLE));
        // a paragraph, not a stat made of label pieces: a p, its own running text, or one inline piece
        // a line the structure clears is still shown to the reviewer when its class names it a subtitle
        const pass = () => { if (named) hit(next.line, next.text, 'warn'); };
        if (!next.paragraph) { pass(); continue; }
        // a line that ends in a colon opens the list or table after it
        if (after && after.kind === 'content' && /:$/.test(next.text)) { pass(); continue; }
        // two or more paragraphs of prose under a heading are the content, not a subtitle
        const prose = (it) => (it.text.match(/[.!?](?:\s|$)/g) || []).length >= 2 || words(it.text).length >= PROSE_WORDS;
        // under an h1, short paragraphs that lead into a call to action or straight into content (a table,
        // a form) are a hero line, not an article
        const run = items.slice(i + 1).findIndex((it) => !isParagraph(it));
        const leadsToAction = run >= 0 && ['action', 'content'].includes(items[i + 1 + run].kind);
        const article = rank(h) > 1 || words(next.text).length >= PROSE_WORDS || !leadsToAction;
        if (article && isParagraph(next) && isParagraph(after) && prose(next) && next.el.parent && descendants(next.el.parent).includes(after.el)) { pass(); continue; }
        if (rank(h) === 1) { hit(next.line, next.text); continue; }
        // a grid of blocks with their own headings after the line counts as content
        const grid = after && after.kind === 'heading' && rank(after) > rank(h) && ancestor(after.el, (a) => !descendants(a).includes(next.el) && kids(a, page).length >= 2 && /grid|flex/.test(displayOf(a, page)) && !/column/.test((declsFor(a, page).map['flex-direction'] || { value: '' }).value));
        if (after && (after.kind === 'content' || grid)) hit(next.line, next.text);
        else pass();
      }
    },
  },
  {
    id: 'page-explanatory', group: 'words', level: 'warn',
    line: 'No text that talks about the page itself instead of being the content.',
    why: `text about the page or a helper caption: the screen should explain itself. this catches named openers (this page, this section, here you can, the following, use this to, welcome to, below is, click a row), helper classes and caption classes only. other self-talk can slip through. a page whose content is itself instructions or a greeting (a help page that says click the Export button, a rule list that opens with the following) is named too. so every hit is a note for the reviewer. ${SEEN}`,
    fix: 'cut the line, or replace it with the actual content it describes',
    maybe: 'a phrase or a class name picked this line and on a help page, a rule list or a greeting those words are the content',
    said: SAID.explain,
    check(ctx, hit) {
      const { page } = ctx;
      const PART = '(?:page|section|screen|site|dashboard|view|report|table|chart|list|panel|tab|form|tool|app)';
      // the page itself: this page, this screen or this section and whatever it does (not "this section
      // of the orchard"). a dashboard or a table can also be a thing you buy. those count only with a
      // verb that describes a screen. a window screen sold on a page reads the same and is caught
      const SELF = '(?:page|screen|section)';
      const UI = '(?:row|rows|button|link|card|name|item|tab|icon|field|cell|column|header|chart|bar|tile|entry|box|dot|line|arrow|menu|toggle|checkbox|switch)';
      // the days, seasons and years that follow are time in a story, not a list below
      const LATER = '(?:day|days|night|morning|afternoon|evening|week|weeks|weekend|month|months|year|years|season|spring|summer|autumn|fall|winter|decade|century|time|monday|tuesday|wednesday|thursday|friday|saturday|sunday)';
      const OPENER = new RegExp(`(?:^|[.!?:,;]\\s+)(?:[\\p{Extended_Pictographic}\\uFE0F\\u200D]+\\s*)?(this ${SELF}'s\\b|this ${SELF}\\s+(?!of\\b|in\\b|on\\b|at\\b|from\\b|by\\b|and\\b|or\\b|was\\b|were\\b|had\\b)\\p{L}|this ${PART}\\s+(?:shows|lists|displays|contains|lets|gives|explains|covers|summari[sz]es|includes|helps|tracks|collects|walks|will (?:show|list|help|walk|let|give)|is (?:where|for|your|here))\\b|(?:on|in) this ${PART}\\b|here,? you(?:'ll| will)? (?:can|find|see)\\b|below,? you\\b|below (?:is|are)\\b|the following (?!${LATER}\\b)\\p{L}|use this (?:(?:${PART}|${UI}) )?to\\b|(?:(?:hello|hi|hey),? (?:and )?)?welcome to\\b|as you can see\\b|everything (?:below|here|on this page)\\b|(?:click|double-click|right-click|hover over) (?:a|an|the|on|any|each|here|and)\\b|(?:tap|drag|swipe) (?:on )?(?:(?:a|an|the|any|each) )?(?:\\p{L}+ )?${UI}\\b|tap here\\b)`, 'iu');
      for (const b of readText(page).blocks) {
        const m = OPENER.exec(b.text.replace(/[’‘]/g, "'"));
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
    why: `the word quiet: say what actually happens. ${SEEN}`,
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
    why: `the word real: it promises without showing. real estate and real-time are fine, real-world and keep-it-real are not. a capitalised Real beside another capitalised word inside a sentence is read as a name (El Camino Real), unless the whole line is set in title case. a capitalised phrase like Real Answers in mid sentence slips through. a name that opens a sentence (Real Madrid) is caught. ${SEEN}`,
    fix: 'drop the word, or show what makes it true. product text you quote goes in <q>',
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
    why: `a one or two word sentence: it reads as a slogan. a number word that opens its line (One. Two.) numbers a list and passes. ${SEEN}`,
    fix: 'join it to the sentence next to it, or cut it. product text you quote goes in <q>',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      for (const b of readText(page).blocks) {
        if (TABLE_PARTS.has(b.el.tag) || inside(b.el, TABLE_PARTS) || b.el.tag === 'time' || inside(b.el, new Set(['pre', 'code']))) continue;
        if (b.attr) continue;
        // a citation ends on its publisher: Caro, R. (1974). The Power Broker. Knopf.
        if (/\(\d{4}[a-z]?\)\./.test(b.text) || b.el.tag === 'cite' || inside(b.el, new Set(['cite']))) continue;
        const text = b.text.replace(/[．。\u2024\ufe52]/g, '.');
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
        for (const [i, s] of sentences.entries()) {
          const t = s.trim();
          if (!/[\p{L}\p{N}]\.["'”’)*†‡]*$/u.test(t)) continue;
          // a number word that opens its line marks an item of a list numbered in words (One. Read the plan.)
          if (i === 0 && LIST_MARK.test(t)) continue;
          const w = words(t);
          if (w.length < 1 || w.length > 2) continue;
          if (ABBR.test(t) || /\b[a-z]\.[a-z]\.$/i.test(t) || /(?:^|\s)v?\d+(?:\.\d+)+\.$/i.test(t) || /^v?\d+(?:\.\d+)*\.$/i.test(t) || /^\p{Lu}\.$/u.test(t) || /^(\p{Lu})\1\.$/u.test(t)) continue;
          hit(lineOf(b, t), t);
        }
      }
    },
  },
  {
    id: 'page-dot-separator', group: 'words',
    line: 'No middle dots or bullets between words.',
    why: `a dot used as a separator between words. a dot inside a word (col·legi) or between two single letters (a · b) is not a separator. ${SEEN}`,
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
        const sm = declsFor(el, page).map;
        const circle = el.tag === 'svg' && ['width', 'height'].every((x) => { const n = pxValue(sm[x] ? sm[x].value : el.attrs[x]); return n != null && n <= DOT_PX; }) && descendants(el).length && descendants(el).every((x) => ['circle', 'ellipse'].includes(x.tag));
        const drawn = circle || (!own && !el.children.some((c) => c.type === 'el') && drawnDot(sm));
        // drawn dots that also lead the line are keys to a chart (a legend), not separators
        const firstShown = el.parent && el.parent.children.find((c) => (c.type === 'text' ? c.text.trim() : !isHidden(c, page)));
        if (drawn && !circle && firstShown && firstShown !== el && firstShown.type === 'el' && firstShown.tag === el.tag && (firstShown.attrs.class || '').split(/\s+/)[0] === (el.attrs.class || '').split(/\s+/)[0] && !visibleText(firstShown, page)) continue;
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
    why: `an arrow in a button or a button-like link: an arrow character, a chevron drawn with css, an arrow from an icon font, or an icon after the label. an icon-only button is not judged, since the check cannot see what an unnamed svg draws. ${SEEN}`,
    fix: 'let the label carry it, for example "Book a fix"',
    maybe: 'an icon after the label may not be an arrow and a link named btn by its class may not be a button',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      for (const el of page.all) {
        const button = !isHidden(el, page) && isButton(el, page);
        if (!button) continue;
        // an arrow character or a css chevron is the fault itself. an icon is only a guess at an arrow
        const sure = button === 'name' ? 'warn' : 'error';
        const label = el.tag === 'input' ? (el.attrs.value || '') : visibleText(el, page);
        if (hasArrow(label)) { hit(el.line, label, sure); continue; }
        const d = declsFor(el, page);
        if (['before', 'after'].some((w) => drawnChevron(d.pseudo[w]))) { hit(el.line, `${label} with a chevron drawn by css`, sure); continue; }
        // an icon drawn after the label: a cut or masked shape, or a glyph from an icon font
        const after = d.pseudo.after;
        if (label && after.content && (drawnShape(after) || /\\(?:e[0-9a-f]{3}|f[0-8][0-9a-f]{2})\b|[\ue000-\uf8ff]/i.test(after.content.value))) { hit(el.line, `${label} with an icon drawn after it`, drawnShape(after) === true ? sure : 'warn'); continue; }
        const bg = (d.map['background-image'] || d.map.background || { value: '' }).value;
        if (label && /url\(/i.test(bg) && /\bright\b|\b(?:9\d|100)%/i.test(`${bg} ${(d.map['background-position'] || { value: '' }).value}`)) { hit(el.line, `${label} with an icon painted on its right edge`, 'warn'); continue; }
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
        // a reversed row or right-to-left direction shows the leaves the other way round
        if (/row-reverse/.test((d.map['flex-direction'] || d.map['flex-flow'] || { value: '' }).value) !== /rtl/.test((d.map.direction || { value: '' }).value)) leaves.reverse();
        // flex order, a grid column, a float to the right or a pin to the right edge move a leaf to the end
        // of the row; a leaf is placed by the child of the button that holds it
        const grid = /grid/.test(displayOf(el, page));
        const place = (leaf, i) => {
          let c = leaf;
          while (c.parent && c.parent !== el) c = c.parent;
          if (c.type !== 'el') return [grid ? i + 1 : 0, i];
          const m = declsFor(c, page).map;
          const pv = (p) => (m[p] ? m[p].value.trim().toLowerCase() : '');
          if (/right|inline-end/.test(pv('float')) || (/absolute/.test(pv('position')) && pv('right') && !pv('left'))) return [Infinity, i];
          // in a grid an item with no column of its own takes the next one in source order
          if (grid) { const col = parseInt(pv('grid-column') || pv('grid-column-start'), 10); return [col > 0 ? col : i + 1, i]; }
          return [parseFloat(pv('order')) || 0, i];
        };
        const keyed = leaves.map((c, i) => ({ c, k: place(c, i) }));
        keyed.sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1]);
        leaves.length = 0;
        leaves.push(...keyed.map((x) => x.c));
        const last = leaves[leaves.length - 1];
        const textBefore = leaves.slice(0, -1).some((c) => c.type === 'text' || (c.type === 'el' && visibleText(c, page) && !iconFontName(c, page)));
        if (last && last.type === 'el' && textBefore) {
          const lig = iconFontName(last, page);
          // a chevron or a triangle drawn with css is the arrow itself. an svg, a picture or an icon name is a guess at one
          const ld = declsFor(last, page);
          const shape = [ld.map, ld.pseudo.before, ld.pseudo.after].some((x) => drawnChevron(x) || drawnShape(x) === true);
          if (!lig || /arrow|chevron|east|navigate_next|forward|trending_flat|north_east|open_in_new|launch/.test(lig)) hit(last.line, `${label} <${last.tag}>`, shape && !lig ? sure : 'warn');
        }
      }
    },
  },

  {
    id: 'page-sparkle', group: 'words',
    line: 'No sparkle or star-burst icons.',
    why: `a sparkle icon: it says magic instead of showing the work. icons are caught by character, name, title or icon-font name, not by the shape an unnamed svg draws. a plain star in a rating (4.8 ★) is data. ${SEEN}`,
    fix: 'remove the icon',
    maybe: 'only a name (a class, an id, a title or an icon or file name such as stars or magic) marked this icon and the name may not be what it draws',
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
        if (lig && NAME.test(lig)) { hit(el.line, lig, 'warn'); continue; }
        // an icon: an icon tag, a custom element or an empty span, or a wrapper that holds only an icon
        const empty = !visibleText(el, page);
        const iconTag = ICON_TAGS.has(el.tag) || el.tag === 'use' || /(?:^|-)icon(?:-|$)/.test(el.tag) || (el.tag.includes('-') && empty);
        const wrapper = empty && kids(el, page).length > 0 && kids(el, page).every((k) => ICON_TAGS.has(k.tag) || k.tag.includes('-'));
        const iconish = iconTag || wrapper || (el.tag === 'span' && empty) || 'data-lucide' in el.attrs || 'data-icon' in el.attrs;
        if (!iconish) continue;
        // a photo of stars is not an icon: an img counts by its file name only when it is icon sized or an svg
        const src = el.tag === 'img' && !(smallIcon(el, page) || /\.svg\b/i.test(el.attrs.src || '')) ? '' : el.attrs.src;
        // an svg named by its own title, directly or through aria-labelledby
        const byId = (id) => id && page.all.find((x) => x.attrs.id === id);
        // and through a use that points at a symbol with a title of its own
        const used = el.tag === 'svg' ? descendants(el).filter((d) => d.tag === 'use').map((u) => byId((u.attrs.href || u.attrs['xlink:href'] || '').replace(/^#/, ''))).filter(Boolean) : [];
        const titled = el.tag === 'svg' ? [...descendants(el).filter((d) => d.tag === 'title'), ...used.flatMap((x) => [x, ...descendants(x)].filter((d) => d.tag === 'title')), ...(el.attrs['aria-labelledby'] || '').split(/\s+/).map(byId).filter(Boolean)].map((t) => t.children.map((c) => c.text || '').join(' ')) : [];
        const names = [el.tag.includes('-') ? el.tag : '', el.attrs.class, el.attrs.id, el.attrs.href, el.attrs['xlink:href'], el.attrs['aria-label'], el.attrs['data-lucide'], el.attrs['data-icon'], el.attrs['data-name'], el.attrs.title, el.attrs.icon, el.attrs.name, src, ...titled]
          .filter(Boolean).map(split).join(' ');
        // an emoji image (twemoji) shows the character in its alt text or the code point in its file name
        const point = /(?:^|\/)([0-9a-f]{4,5})(?:-fe0f)?\.(?:svg|png)(?:[?#]|$)/i.exec(src || '');
        const drawn = el.tag === 'img' && (SPARKLE.test(el.attrs.alt || '') || (point && SPARKLE.test(String.fromCodePoint(parseInt(point[1], 16)))));
        // a rating label (4.5 out of 5 stars) names data, not a sparkle
        if ((NAME.test(names) && !/\d(?:\.\d+)?\s*(?:out of\s*\d+\s*)?stars?\b/i.test(names)) || drawn) hit(el.line, drawn ? el.attrs.alt || src : names, drawn ? 'error' : 'warn');
      }
      // an icon painted as a background image: an svg, or a picture on an icon sized element; a photo
      // shown as a labelled picture (role img or an aria-label) is not an icon
      for (const d of lookDecls(page)) {
        const u = /url\(\s*["']?([^)"']*)/i.exec(d.value);
        if (!/^(?:background(?:-image)?|mask(?:-image)?|-webkit-mask(?:-image)?|list-style(?:-image)?|content)$/.test(d.prop) || !u || !NAME.test(split(u[1].split('/').pop()))) continue;
        const els = targets(d, page);
        const picture = els.length && els.every((el) => el.attrs.role === 'img' || el.attrs['aria-label']);
        const small = /\.svg\b/i.test(u[1]) || !/^background/.test(d.prop) || (d.rule && d.rule.selector && /::?(?:before|after)/.test(d.rule.selector)) || els.some((el) => { const m = declsFor(el, page).map; return pxValue((m.width || { value: '' }).value) != null && pxValue(m.width.value) <= ICON_PX; });
        if (!picture && small) { hit(d.line, `${d.prop}: ${d.value}`, 'warn'); break; }
      }
    },
  },

  {
    id: 'page-label-above-heading', group: 'words',
    line: 'No small label, tag or pill right above a heading.',
    why: `a label above the heading: the heading says it. a line written above it counts, and so does one css moves above it. a row of links (breadcrumbs, tabs), a status message and a page banner are not labels. ${SEEN}`,
    fix: 'cut the label; if it matters, put it in the heading',
    maybe: 'only a class name such as eyebrow, pill or tag marked the line above the heading as a label and the class may name something else',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      const ROLE = ['eyebrow', 'kicker', 'overline', 'pill', 'badge', 'tag', 'chip', 'label'];
      const short = (t) => words(t).length <= LABEL_WORDS;
      for (const h of page.all) {
        if (!(/^h[12]$/.test(h.tag) || (!HEADING.test(h.tag) && headingLike(h, page))) || isHidden(h, page)) continue;
        // a small line drawn as a block inside the heading, before its words
        const firstKid = h.children.find((c) => (c.type === 'text' ? c.text.trim() : !isHidden(c, page)));
        // on a line of its own: a block, a full-width inline box, or a small or framed piece before a line break
        const ownLine = (k) => {
          if (!INLINE.has(k.tag) || k.tag === 'small' || displayOf(k, page) === 'block') return true;
          const km = declsFor(k, page).map;
          if (/^inline-(?:block|flex|grid)/.test(displayOf(k, page)) && /^100%$/.test((km.width || { value: '' }).value.trim())) return true;
          const nextShown = h.children.slice(h.children.indexOf(k) + 1).find((c) => (c.type === 'text' ? c.text.trim() : !isHidden(c, page)));
          const hs = pxValue((declsFor(h, page).map['font-size'] || { value: '' }).value) || H1_PX;
          const small = km['font-size'] && ((/%|em$/.test(km['font-size'].value.trim()) ? parseFloat(km['font-size'].value) / (/%/.test(km['font-size'].value) ? 100 : 1) * hs : pxValue(km['font-size'].value)) < hs * SMALLER);
          if (!nextShown || nextShown.tag !== 'br') return false;
          return small || boxed(k, page) || !!borderWidth((km.border || { value: '' }).value) || (hasClassWord(k, ROLE) ? 'warn' : false);
        };
        const own = firstKid && firstKid.type === 'el' && h.children.slice(h.children.indexOf(firstKid) + 1).some((c) => (c.type === 'text' ? c.text.trim() : visibleText(c, page))) && ownLine(firstKid);
        if (own && short(visibleText(firstKid, page))) {
          hit(firstKid.line, visibleText(firstKid, page), own === 'warn' ? 'warn' : 'error');
          continue;
        }
        // a short line a ::before draws above its words: as a block, or placed above it, on the heading or on
        // a wrapper the heading opens
        const drawnAbove = (x) => {
          const b = declsFor(x, page).pseudo.before;
          const t = pseudoText(x, page, 'before');
          const pv = (p) => (b[p] ? b[p].value.trim() : '');
          const above = /^(?:block|flex|grid)/.test(pv('display')) || (/absolute|fixed/.test(pv('position')) && ((pxValue(pv('top')) != null && pxValue(pv('top')) < 0) || /^100%$/.test(pv('bottom'))));
          return above && /\p{L}/u.test(t) && short(t) ? { line: b.content ? b.content.line : x.line, t } : null;
        };
        let wrap = h, drawn = drawnAbove(h);
        while (!drawn && wrap.parent && wrap.parent.tag !== '#root' && wrap.parent.tag !== 'body' && kids(wrap.parent, page)[0] === wrap) { wrap = wrap.parent; drawn = drawnAbove(wrap); }
        if (drawn) { hit(drawn.line, drawn.t); continue; }
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
          const shape = HEADING.test(h.tag) && +prev.tag[1] > +h.tag[1] + 1 && short(text);
          if (role || shape) hit(prev.line, text, shape ? 'error' : 'warn');
          continue;
        }
        // first among the parent's children that carry text: a logo before it does not count. a lone
        // link or button before it (a back link) does not count either
        const texty = kids(at.parent, page).filter((k) => visibleText(k, page));
        const linkOnly = (k) => ['a', 'button'].includes(k.tag) || (kids(k, page).length === 1 && ['a', 'button'].includes(kids(k, page)[0].tag) && visibleText(k, page) === visibleText(kids(k, page)[0], page));
        const first = texty.slice(0, texty.indexOf(prev)).every(linkOnly) && texty.indexOf(prev) >= 0;
        const list = (['ul', 'ol'].includes(prev.tag) && kids(prev, page).length === 1) || (prev.tag === 'dl' && kids(prev, page).length === 1 && kids(prev, page)[0].tag === 'dt');
        const shape = first && short(text) && (textOnly(prev, page, { icons: true }) || list);
        if (shape || role) hit(prev.line, text, shape ? 'error' : 'warn');
      }
    },
  },

  {
    id: 'page-headline-accent', group: 'words',
    line: 'No single word styled differently inside a headline.',
    why: `part of the headline in italics, a slant, or another font. a heading set wholly in one style is fine. ${SEEN}`,
    fix: 'set the whole headline in one style',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      const SAME = /^(?:inherit|unset|revert)$/i;
      // a custom element styles itself from inside: the :host rule its script defines
      // (the class the define call names, written before or after the call)
      const hostDecls = (tag) => {
        for (const sc of page.scripts) {
          const def = new RegExp(`define\\(\\s*["'\`]${tag}["'\`]\\s*,\\s*([\\w$]+)?`).exec(sc.text);
          if (!def) continue;
          const cls = def[1] ? sc.text.search(new RegExp(`class\\s+${def[1].replace(/\$/g, '\\$')}\\b`)) : -1;
          const host = /:host\s*\{([^}]*)\}/.exec(sc.text.slice(cls >= 0 ? cls : def.index)) || /:host\s*\{([^}]*)\}/.exec(sc.text);
          if (host) return Object.fromEntries(((cssRules(`x{${host[1]}}`)[0] || { decls: [] }).decls).map((d) => [d.prop, d]));
        }
        return {};
      };
      // the family named in a font shorthand: what follows the last size (16px, 6vw, clamp(...), large)
      const familyOf = (m) => {
        if (m['font-family'] && !SAME.test(m['font-family'].value.trim())) return m['font-family'].value.trim();
        if (!m.font) return '';
        const toks = splitTop(m.font.value.trim().replace(/\s*\/\s*/g, '/'), ' ').map((x) => x.text).filter(Boolean);
        const size = toks.map((t) => /^(?:[\d.]+[a-z%]+|(?:clamp|min|max|calc)\(.*\)|(?:xx?-)?(?:small|large)|medium|larger|smaller)(?:\/\S+)?$/i.test(t)).lastIndexOf(true);
        return size >= 0 ? toks.slice(size + 1).join(' ').trim() : '';
      };
      for (const h of page.all) {
        const top = /^h[12]$/.test(h.tag) || (h.attrs.role === 'heading' && /^[12]$/.test(h.attrs['aria-level'] || '2')) || (!HEADING.test(h.tag) && headingLike(h, page));
        if (!top || isHidden(h, page)) continue;
        const hm = declsFor(h, page).map;
        const whole = visibleText(h, page).replace(/\s+/g, '');
        // a heading set inline runs on into the words beside it on the same line
        const runOn = /^inline/.test(displayOf(h, page)) ? kids(h.parent, page).slice(kids(h.parent, page).indexOf(h) + 1).filter((x) => INLINE.has(x.tag) && !/^block/.test(displayOf(x, page))) : [];
        for (const d of [...descendants(h), ...runOn]) {
          const t = visibleText(d, page);
          if (!/\p{L}/u.test(t) || isHidden(d, page) || iconFontName(d, page) || codeLike(d, page)) continue; // a command name in code is not an accent
          if (t.replace(/\s+/g, '') === whole) continue; // the whole heading in one style
          // svg text styled by its own attributes, a custom element by its :host rule
          const attrs = Object.fromEntries(['font-family', 'font-style'].filter((a) => d.attrs[a]).map((a) => [a, { value: d.attrs[a] }]));
          const m = { ...attrs, ...(d.tag.includes('-') ? hostDecls(d.tag) : {}), ...declsFor(d, page).map };
          const v = (p) => (m[p] ? m[p].value.toLowerCase() : '');
          const style = m['font-style'] ? v('font-style') : (['em', 'i', 'cite', 'var', 'dfn', 'address'].includes(d.tag) ? 'italic' : '');
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
    why: `numbered section labels: the order is already on the page. times, dates, versions, counts (2 bedrooms) and numbered terms the text refers back to are not decoration. a rank written as 1. before a name reads the same as a step number, so a plain 1. before a short label is a note for the reviewer. ${SEEN}`,
    fix: 'drop the numbers',
    maybe: 'a plain 1. 2. before short labels may be a ranking or a numbered list the reader needs',
    said: SAID.never,
    check(ctx, hit) {
      const { page } = ctx;
      const found = [];
      const MONTH = /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/i;
      // digits written another way read as digits: fullwidth ０１, roman numeral letters Ⅲ and the
      // circled and boxed dingbat digits ❶ ➀ ➊ ⓵ ⑴ ⒈
      const DINGBAT = [[0x2776, 10], [0x2780, 10], [0x278a, 10], [0x24f5, 10], [0x2474, 20], [0x2488, 20], [0x24eb, 10]];
      const ROMAN_CH = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
      const foldDigits = (t) => t.replace(/[\uff10-\uff19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xff10 + 48))
        .replace(/[\u2160-\u216b\u2170-\u217b]/g, (c) => ROMAN_CH[(c.charCodeAt(0) - 0x2160) % 16])
        .replace(/[\u2776-\u2793\u24f5-\u24fe\u2474-\u249b\u24eb-\u24f4]/g, (c) => { const n = c.charCodeAt(0); const r = DINGBAT.find(([s, k]) => n >= s && n < s + k); return r ? `${n - r[0] + 1 + (r[0] === 0x24eb ? 10 : 0)} ` : c; });
      // the number a label opens with: 01, 1., #1, Step 1, (1), a circled digit or a roman numeral before a mark
      const prefix = (raw) => {
        const text = foldDigits(raw);
        let m = /^[①-⑳]/.exec(text);
        if (m) return { n: m[0].charCodeAt(0) - 0x245f, zero: false };
        m = /^(I{1,3}|IV|VI{0,3}|IX|X)\s*(?:[./:)—–-]|\s\/)\s*\p{L}/u.exec(text);
        if (m) return { n: ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'].indexOf(m[1]) + 1, zero: false };
        m = /^(?:(?:step|phase|stage|part)\s+)?(?:#\s?|\/\s?)?[([]?(0?)(\d{1,2})(?![\d:.,]\d)[)\]]?(?:\s*[./)·:—–-]\s*|\s+\/\s*|\s+(?=\S)|(?=\p{Lu}))/iu.exec(text);
        if (!m) return null;
        const rest = text.slice(m[0].length);
        if (MONTH.test(rest) || /^(?:am|pm|a\.m|p\.m|%|x\b|k\b|min|hours?|days?|weeks?|years?)/i.test(rest)) return null;
        // a count of something (1 bedroom, 3 days) is a number then a lowercase word, with no mark between
        if (!m[1] && /^\s*$/.test(m[0].slice(m[0].search(/\d/) + m[2].length)) && /^\p{Ll}/u.test(rest) && !/^(?:step|phase|stage|part|#)/i.test(m[0])) return null;
        return { n: +m[2], zero: !!m[1], step: /^\p{L}/u.test(m[0]), rest: rest.trim().toLowerCase() };
      };
      const LONE = /^(?:#\s?)?(0?)(\d{1,2})\.?$/;
      const lone = (t) => LONE.exec(foldDigits(t).trim());
      const beside = (el) => [prevEl(el, page), nextEl(el, page)].find((x) => x && /\p{L}/u.test(visibleText(x, page)));
      // beside a heading, or beside a section block that opens with a short title line
      const besideHeading = (el) => {
        const x = beside(el);
        if (!x) return false;
        if (HEADING.test(x.tag) || descendants(x).some((d) => HEADING.test(d.tag))) return true;
        const k = kids(x, page);
        return k.length >= 2 && textOnly(k[0], page) && words(visibleText(k[0], page)).length <= TITLE_WORDS;
      };
      for (const el of page.all) {
        if (isHidden(el, page)) continue;
        const text = visibleText(el, page);
        if (!text) continue;
        const heading = HEADING.test(el.tag);
        // a number alone in its own element: 01 anywhere, or any number beside a heading
        const alone = lone(text);
        // a number inside a heading, first or last beside its words (Read the code 01)
        const inHeading = alone && !heading && HEADING.test((el.parent || {}).tag || '') && (() => { const shown = el.parent.children.filter((c) => (c.type === 'text' ? c.text.trim() : !isHidden(c, page))); return shown.length >= 2 && (shown[0] === el || shown[shown.length - 1] === el); })();
        if (inHeading) { found.push({ n: +alone[2], el, text: `${text} ${visibleText(el.parent, page).replace(text, '').trim()}` }); continue; }
        // an svg badge drawing one number counts as the number alone
        if (alone && !heading && (!kids(el, page).length || (el.tag === 'svg' && descendants(el).every((x) => ['circle', 'rect', 'ellipse', 'path', 'text', 'tspan', 'g'].includes(x.tag))))) {
          const row = TABLE_PARTS.has(el.tag) ? ancestor(el, (a) => a.tag === 'tr') : null;
          const tableHeading = row && descendants(row).some((d) => HEADING.test(d.tag));
          const firstInLine = el.parent && el.parent.children.find((c) => (c.type === 'text' ? c.text.trim() : true)) === el && /\p{L}/u.test(visibleText(el.parent, page).replace(text, ''));
          if (tableHeading || (!inside(el, TABLE_PARTS) && (besideHeading(el) || (alone[1] && (beside(el) || firstInLine))))) found.push({ n: +alone[2], el, text: `${text} ${visibleText(el.parent, page).replace(text, '').trim()}` });
          continue;
        }
        if (el.tag === 'li' || TABLE_PARTS.has(el.tag) || inside(el, TABLE_PARTS)) continue;
        const label = !heading && textOnly(el, page) && words(text).length <= LABEL_WORDS;
        if (!heading && !label) continue;
        if (ancestor(el, (a) => HEADING.test(a.tag))) continue;
        const p = prefix(text);
        if (!p) continue;
        if (!heading && !p.zero && !p.step && /^\d{1,2}\s*\p{L}/u.test(text)) continue;
        // a plain 1. before a short label reads the same as a rank: the guessed part
        found.push({ n: p.n, el, text, rest: p.rest, rank: !heading && !p.zero && !p.step });
      }
      // a number drawn by ::before from an attribute (data-n="01") beside a block that opens with a heading
      const opens = (x, depth = 0) => !!x && depth < 4 && (HEADING.test(x.tag) || opens(kids(x, page)[0], depth + 1));
      for (const el of page.all) {
        const t = pseudoText(el, page, 'before').trim();
        const n = t && lone(t);
        if (n && !isHidden(el, page) && opens(kids(el, page)[0])) found.push({ n: +n[2], el, text: `${t} ${visibleText(el, page).replace(t, '').trim()}` });
      }
      found.sort((a, b) => page.all.indexOf(a.el) - page.all.indexOf(b.el));
      // numbers the text refers back to (see section 3) are part of the content
      const all = readText(page).blocks.map((x) => x.text).join(' ');
      const cited = (n) => new RegExp(`\\b(?:section|clause|part|article|item|paragraph)s?\\s+${n}\\b`, 'i').test(all);
      if (found.some((f) => cited(f.n))) found.length = 0;
      let noted = false;
      for (let i = 0; i < found.length; i++) {
        // the same name with a different number (4 Harbor Lane, 5 Harbor Lane) is the number as content
        const next = found.slice(i + 1, i + 4).find((f) => f.n === found[i].n + 1 && !(f.rest && f.rest === found[i].rest));
        if (!next) continue;
        // a rank pair leaves one note and the search goes on for numbering that is the fault itself
        const rank = found[i].rank && next.rank;
        if (rank && noted) continue;
        hit(found[i].el.line, `${found[i].text.slice(0, 30)} / ${next.text.slice(0, 30)}`, rank ? 'warn' : 'error');
        if (!rank) return;
        noted = true;
      }
      // numbering drawn by css: a counter on a heading or on a block that holds or sits by one (or opens
      // with a bold title), a counter in a list marker, or 01 list markers from a padded counter style
      const padded = sheetFor(page).rules.filter((r) => r.at === 'counter-style' && r.decls.some((d) => (d.prop === 'pad' && /^\s*[2-9]\s+["']0["']/.test(d.value)) || (d.prop === 'system' && /decimal-leading-zero/.test(d.value)) || (d.prop === 'symbols' && /["']0\d["']/.test(d.value)))).map((r) => r.selector);
      const zeroStyle = (ls) => /decimal-leading-zero/.test(ls) || padded.some((n) => new RegExp(`(?:^|\\s)${n.replace(/[^\w-]/g, '')}(?:\\s|$)`).test(ls));
      const boldTitle = (x) => { const first = x.children.find((c) => (c.type === 'text' ? c.text.trim() : !isHidden(c, page))); return !!first && first.type === 'el' && (['b', 'strong'].includes(first.tag) ? words(visibleText(first, page)).length <= TITLE_WORDS : boldTitle(first)); };
      for (const el of page.all) {
        if (isHidden(el, page)) continue;
        const near = HEADING.test(el.tag) || kids(el, page).some((k) => HEADING.test(k.tag)) || (nextEl(el, page) && HEADING.test(nextEl(el, page).tag)) || boldTitle(el) || opens(kids(el, page)[0]);
        const p = declsFor(el, page).pseudo;
        for (const where of ['before', 'after', 'marker']) {
          if (near && p[where].content && /counters?\(/.test(p[where].content.value)) { hit(p[where].content.line, p[where].content.value); return; }
        }
        const m = declsFor(el, page).map;
        const ls = `${m['list-style'] ? m['list-style'].value : ''} ${m['list-style-type'] ? m['list-style-type'].value : ''}`;
        if (zeroStyle(ls) && ['ol', 'ul', 'li'].includes(el.tag)) { hit(el.line, `list-style: ${ls.trim()}`); return; }
        // the numbers of an ordered list made big beside items that open with headings: a list marker
        // set larger than body text is decoration, a plain one is the list
        const mk = p.marker['font-size'];
        if (el.tag === 'li' && el.parent && el.parent.tag === 'ol' && mk && (pxValue(mk.value) || 0) > BODY_PX && opens(kids(el, page)[0]) && !/none/.test(ls)) { hit(mk.line, `::marker font-size ${mk.value}`); return; }
      }
    },
  },

  {
    id: 'page-all-caps', group: 'words', replaces: ['eyebrow-caps'],
    line: 'No text shown in capitals.',
    why: `all caps reads as shouting: text styled in capitals (uppercase, small caps), three or more typed capital words in a row (TRY IT NOW), or two or more of four or more capitals (LIMITED OFFER). a single capital token, hyphens and all (a file name, a ticker, an acronym, a code like QWER-ASDF), passes. ${SEEN}`,
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
      // letters typed as small capitals (ꜱᴛᴀʀᴛ) show as capitals
      const SMALL = { 'ᴀ': 'A', 'ʙ': 'B', 'ᴄ': 'C', 'ᴅ': 'D', 'ᴇ': 'E', 'ꜰ': 'F', 'ɢ': 'G', 'ʜ': 'H', 'ɪ': 'I', 'ᴊ': 'J', 'ᴋ': 'K', 'ʟ': 'L', 'ᴍ': 'M', 'ɴ': 'N', 'ᴏ': 'O', 'ᴘ': 'P', 'ꞯ': 'Q', 'ʀ': 'R', 'ꜱ': 'S', 'ᴛ': 'T', 'ᴜ': 'U', 'ᴠ': 'V', 'ᴡ': 'W', 'ʏ': 'Y', 'ᴢ': 'Z' };
      const SMALL_RE = new RegExp(`[${Object.keys(SMALL).join('')}]`, 'gu');
      // typed capitals shout when three or more capital words run together, whatever their length (TRY IT
      // NOW), or two or more of four or more capitals (LIMITED OFFER). one capital token alone, joined by
      // hyphens or not, is a file name, a ticker, an acronym or a code (README, USDC, QWER-ASDF) and passes
      const RUN = /(?<![\p{L}\p{N}-])(?:\p{Lu}+(?:-\p{Lu}+)*(?:\s+\p{Lu}+(?:-\p{Lu}+)*){2,}|\p{Lu}{4,}(?:\s+\p{Lu}{4,})+)(?![\p{L}\p{N}-])/u;
      for (const b of readText(page).blocks) {
        if (b.el.tag === 'td' || inside(b.el, new Set(['td']))) continue; // a ticker or a code in a table cell is data
        const text = b.text.replace(SMALL_RE, (c) => SMALL[c]);
        const run = RUN.exec(text);
        const found = run && run[0];
        if (found) hit(lineOf(b, b.text.slice(text.indexOf(found))), b.text.slice(text.indexOf(found), text.indexOf(found) + found.length));
      }
    },
  },

  {
    id: 'page-emoji-icon', group: 'words',
    line: 'No emoji used as icons.',
    why: `an emoji standing in for an icon: first in a heading, item, button, link or line of text, or alone beside a heading. an emoji in a table cell is data. ${SEEN}`,
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
        // or it sits above a short bold title: a card's icon over its name
        const title = nextEl(el, page);
        const leads = !!title && textOnly(title, page) && words(visibleText(title, page)).length <= TITLE_WORDS && (['b', 'strong'].includes(title.tag) || /^(?:[6-9]00|bold)/.test((declsFor(title, page).map['font-weight'] || { value: '' }).value));
        const iconSpot = INLINE.has(el.tag) || opensWithHeading(nextEl(el, page)) || leads;
        if (alone ? iconSpot : lead && startsEmoji) hit(el.line, text.slice(0, 20));
      }
    },
  },

  {
    id: 'page-placeholder', group: 'words',
    line: 'No lorem ipsum or placeholder text.',
    why: `placeholder copy left on the page: filler latin, "text goes here", template marks like {{name}} or [Company name], TBD, a sample name, a sample email or the town Anytown. ${SEEN}`,
    fix: 'write the real words or remove the block',
    maybe: 'a sample name such as John Doe may be a real person, TBD or Anytown may be the real value, a sample email may be the demo login and words like "your text here" may be a label asking for them',
    said: SAID.explain,
    check(ctx, hit) {
      const { page } = ctx;
      const re = PLACEHOLDER();
      // filler latin anywhere in a block, single or double brace template marks, a short [Company name],
      // TBD standing as a whole value, TKTK and sample addresses
      const LEFTOVER = /^lorem ipsum\b|\blorem ipsum (?:dolor|sed|amet|consectetur|adipiscing|elit|do|eiusmod|tempor|ut|labore|et)\b|\bsed ut perspiciatis\b|\bperspiciatis unde omnis\b|\beiusmod tempor\b|\bincididunt ut labore\b|\bnemo enim ipsam\b|\but enim ad minim\b|\bquis nostrud exercitation\b|\bullamco laboris\b|\bduis aute irure\b|\bexcepteur sint occaecat\b|\bvoluptate velit esse\b|\banytown\b|\{\{\s*[\w.-]+\s*\}\}|(?<![/\w])\{\s*[a-z][\w.]{2,}\s*\}|\[(?:company|business|product|first|last|full|your|insert|year|date|city|name|title|headline|phone|email|address|client|customer)\b(?:\s+[\w]+){0,2}\]|(?:^|:\s*)TBD\.?$|\bTKTK\b|\b(?:example|test|name|user|email|your\.?name)@(?:email|example|domain|company|yourcompany)\.com\b/i;
      // a pseudonym in a case name (John Doe v. the county) is the record, not a sample name
      // and "the Jane Doe of Coyote Hills" uses the name as a noun for an unknown person
      const caseName = (t, m) => /^\s*vs?\.\s/.test(t.slice(m.index + m[0].length)) || /\b(?:vs?\.|the|a|an)\s+$/i.test(t.slice(0, m.index));
      // filler latin, template marks and TKTK block. a sample name, TBD, Anytown, a sample email or a
      // "goes here" phrase may be the real words, so those are a note
      const guess = (t) => /doe$|here$|anytown|tbd\.?$|@/i.test(t);
      for (const b of readText(page).blocks) {
        if (b.attr || b.field) continue;
        const r = re.exec(b.text);
        const found = [r && !(/doe$/i.test(r[0]) && caseName(b.text, r)) ? r : null, LEFTOVER.exec(b.text)].filter(Boolean);
        const m = found.find((x) => !guess(x[0])) || found[0];
        if (m) hit(lineOf(b, m[0]), m[0], guess(m[0]) ? 'warn' : 'error');
      }
    },
  },

  {
    id: 'page-unsourced-number', group: 'words',
    line: 'No big statistic without a named source next to it.',
    why: `a number shown as a statistic with no source named. this proves a source is named, not that the number is true. ${SEEN}`,
    fix: 'add a cite element, a data-source or a Source: line next to the number, or drop the number',
    maybe: 'a heading with a phrase such as twice faster and no figure may not be a statistic',
    said: SAID.numbers,
    check(ctx, hit) {
      const { page } = ctx;
      const NO = new Set(['form', 'button', 'nav', 'time', 'code', 'pre', 'select', 'option', 'label', 'footer']);
      const CLAIM = /%|percent|\d\s?[x×](?![\w])|\+|\d\s?(?:k|m|b|bn)\b|billion|million|thousand|trillion|^#\d/i;
      // a price: a label that opens with how often it is paid, or says it is paid, billed or charged
      const PRICE_UNIT = /^for\b|^(?:a|an|per|each|every|\/)\s*(?:month|mo|year|yr|seat|user|person|team|week|day|hour)\b|^(?:monthly|yearly|annually|one time|once|billed|forever|plus tax|incl)|\b(?:paid|billed|charged)\s+(?:once|monthly|yearly|annually|up front|each|every|per|a)\b/i;
      const DATE = /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?$/i;
      const big = (el) => { for (let a = el; a && a.tag !== '#root'; a = a.parent) { const f = declsFor(a, page).map['font-size']; if (f) return pxValue(f.value) >= H2_PX || /x+-large|xxx/.test(f.value); } return HEADING.test(el.tag); };
      // a big number with one word beside it: 3x faster, Top 1%, Over 10k; or a big short line built round a
      // count (Over 12,000 teams)
      const COUNT = /[$€£]\d|\d{1,3}(?:,\d{3})+|\d(?:\.\d+)?\s?(?:%|x|×|\+|k|m|b|bn)(?![\p{L}])/iu;
      const token = (t, el) => NUMBER_TOKEN.test(t) || (big(el) && words(t).length === 2 && (/^[$€£]?\d[\d,.]*\s?(?:%|x|\+)?\s+\p{L}+$/u.test(t) || /^\p{L}+\s+[$€£]?\d[\d,.]*\s?(?:%|x|\+|k|m|b)?\+?$/iu.test(t))) || (big(el) && !HEADING.test(el.tag) && words(t).length <= 4 && COUNT.test(t) && textOnly(el, page));
      for (const el of page.all) {
        if (isHidden(el, page) || NO.has(el.tag) || inside(el, NO)) continue;
        // a heading that is only a number is the big number of a stat tile; read it like one below
        if (HEADING.test(el.tag) && !NUMBER_TOKEN.test(visibleText(el, page))) {
          const text = visibleText(el, page);
          // a discount (20% off) is an offer, not a statistic
          // a figure (40%, 3x) is the claim itself; a phrase (twice faster) is a guess at one
          const figure = /\d(?:\.\d+)?\s?(?:%|percent\b)|\b\d+(?:\.\d+)?\s?[x×](?![\w])/i.test(text);
          if (!/\d\s?%\s+off\b/i.test(text) && (figure || /\b(?:two|three|four|five|six|seven|eight|nine|ten|twice|\d+)\s+times\s+(?:faster|more|less|better|cheaper|higher|lower|quicker)\b/i.test(text)) && !hasSource(el, page)) hit(el.line, text, figure ? 'error' : 'warn');
          continue;
        }
        // the number: the element's own text, or a number its ::before draws over its text
        let own = visibleText(el, page), label = '', at = el;
        const drawn = pseudoText(el, page, 'before').trim();
        if (drawn && NUMBER_TOKEN.test(drawn) && own.replace(drawn, '').trim()) { label = own.replace(drawn, '').trim(); own = drawn; }
        if (!own || !token(own, el) || kids(el, page).some((k) => !INLINE.has(k.tag))) continue;
        // a table cell is data with its column heading, unless it is set big as a claim: a stat band built as a table
        if (TABLE_PARTS.has(el.tag)) {
          if (!['td', 'th'].includes(el.tag) || !big(el)) continue;
          const row = el.parent, col = kids(row, page).indexOf(el);
          // a big plain count counts when its whole row is big counts: a stat band, not a data row
          if (!CLAIM.test(own) && !kids(row, page).every((c) => NUMBER_TOKEN.test(visibleText(c, page)) && big(c))) continue;
          const rows = kids(row.parent, page);
          const near = [rows[rows.indexOf(row) + 1], rows[rows.indexOf(row) - 1]].map((r) => r && kids(r, page)[col]).find((c) => c && visibleText(c, page) && !NUMBER_TOKEN.test(visibleText(c, page)));
          if (near && !hasSource(ancestor(el, (a) => a.tag === 'table') || el, page)) hit(el.line, `${own} ${visibleText(near, page)}`.slice(0, 80));
          continue;
        }
        // not a statistic: a year, a time, a plain step number, a version
        if (/^(?:19|20)\d\d$/.test(own) || /^\d{1,2}:\d\d$/.test(own) || /^0\d\s?\/\s?0?\d+$/.test(own) || /^v?\d+\.\d+\.\d+$/.test(own)) continue;
        // a progress figure: the fill of a bar as wide as the percent it shows
        const pct = /^(\d+(?:\.\d+)?)%$/.exec(own);
        if (pct && [el, el.parent].some((x) => x && (declsFor(x, page).map.width || { value: '' }).value.trim() === `${pct[1]}%`)) continue;
        // a line holding two or more numbers in their own tags is a row of data (Fremont 21, Hayward 14;
        // prep 15 min, cook 40 min), not one stat with its label
        const line = el.parent;
        if (line && !big(el) && !CLAIM.test(own.replace(/^#/, '')) && kids(line, page).filter((k) => NUMBER_TOKEN.test(visibleText(k, page))).length >= 2 && /\p{L}/u.test(textNodes(line).map((n) => n.text).join(''))) continue;
        // a numbered entry in a list (#23 Maya Lin) where the items beside it carry their own numbers
        const item = ancestor(el, (a) => a.tag === 'li');
        if (item && !big(el) && !CLAIM.test(own.replace(/^#/, '')) && kids(item.parent, page).filter((li) => li !== item && descendants(li).some((x) => NUMBER_TOKEN.test(visibleText(x, page)))).length >= 2) continue;
        if (INLINE.has(el.tag) && displayOf(el, page) === 'inline' && el.parent && readText(page).blocks.some((b) => b.el === el.parent && words(b.text).length > TITLE_WORDS)) continue; // a number inside a sentence, longer than a title line
        if (!label) {
          // look up through wrappers that hold only the number
          while (at.parent && at.parent.tag !== '#root' && visibleText(at.parent, page) === own) at = at.parent;
          const sibs = kids(at.parent, page);
          const i = sibs.indexOf(at);
          const sibLabel = sibs.find((x) => x !== at && !HEADING.test(x.tag) && visibleText(x, page) && !token(visibleText(x, page), x));
          const parentRest = sibs.filter((x) => x !== at && (HEADING.test(x.tag) || token(visibleText(x, page), x))).reduce((t, x) => t.replace(visibleText(x, page), ''), visibleText(at.parent, page).replace(own, '')).trim();
          label = sibLabel ? visibleText(sibLabel, page) : (parentRest && words(parentRest).length <= TITLE_WORDS ? parentRest : '');
          if (!label) continue;
          // a label written before a plain number is a setting or a row (Seats 25); before an amount it is a
          // price or a total (Latte $4.50, Total $42.10). a big or bold count after its label still reads as a stat
          // a number after its label in the same size (Order #4821, Gate 12, Latest version 4.2) reads as a
          // field, bold or not; set larger than its label it is a stat tile
          const size = (x) => { for (let a = x; a && a.tag !== '#root'; a = a.parent) { const f = declsFor(a, page).map['font-size']; if (f && pxValue(f.value) != null) return pxValue(f.value); } return 16; };
          const labelFirst = sibLabel ? sibs.indexOf(sibLabel) < i : visibleText(at.parent, page).indexOf(own) > 0;
          if (labelFirst && !CLAIM.test(own.replace(/^#/, '')) && !big(el) && !(sibLabel && size(el) > size(sibLabel))) continue;
        }
        if (DATE.test(label.split(/\s+/)[0]) && /^\d{1,2}$/.test(own)) continue;
        if (/^[$€£]/.test(own) && PRICE_UNIT.test(label)) continue;
        if (/^(?:0\d|\d)\.?$/.test(own) && !/^(?:out of|of|in)\b/i.test(label)) continue; // a step number, not 9 out of 10
        if (!hasSource(at, page)) hit(el.line, `${own} ${label}`.slice(0, 80));
      }
    },
  },
];
