// Page rules about the look of the page: motion, glows, glass, gradients, fonts and texture.

const { cssRules, declsFor, visibleText, pseudoText, isHidden, classList, matchesSelector, compileSelector, splitTop } = require('../page-scan');
const { SAID, ICON_PX, DOT_PX, GLOW_PX, hasClassWord, kids, descendants, words, clip, ancestor, inside, lookDecls, stripJsComments, targets, pxValue, DYNAMIC_SEL, shadows, hardEdged, glowShadow, glowShadows, clearColour, fillOf, backdrop } = require('./shared');

// A minute of motion is about how long a reader stays on one screen; a repeat count that runs past it loops for them.
// Set by hand.
const LOOP_SECONDS = 60;

// What every rule here can see.
const SEEN = 'found in the page source, its style sheets and its scripts as written: an effect a script builds another way is not seen';

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
    maybe: 'only a name (a class such as visible or fade-in, or a data attribute such as data-aos) marked this as a reveal on scroll and the name may mean something else, or a scroll library such as ScrollTrigger was named with nothing starting hidden and may only track the scroll',
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
        // ScrollTrigger and sal( also run progress bars and other code: with nothing that starts hidden, a note
        if (lib) { hit(lineAt(sc, code, lib.index), lib[0], startsHidden || !/ScrollTrigger|sal/.test(lib[0]) ? 'error' : 'warn'); return; }
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
        const onTarget = observed && /\.target\s*\.\s*(?:style\b|animate\()/.test(code);
        // a class named for being shown is a guess at a reveal: a note
        const namedShow = observed && /\.target\s*\.\s*(?:classList\.(?:add|toggle|replace)\(\s*|className\s*\+?=\s*)["'`]\s*(?:is-)?(?:on|open|active|visible|shown|show|in|seen|revealed|in-?view|animated?|appear(?:ed)?|fade-?in)["'`\s]/.test(code);
        // a style a scroll handler sets counts only on content: content that starts hidden, or blocks of words
        // the script picks out by selector (a back-to-top link is not content)
        const picked = [...code.matchAll(/querySelector(?:All)?\(\s*(["'`])([^"'`]+)\1/g)].some((x) => { const c = compileSelector(x[2]); return c && page.all.some((el) => matchesSelector(el, c) && !['a', 'button'].includes(el.tag) && (el.tag === 'section' || words(visibleText(el, page)).length >= 3)); });
        if ((fades && (observed || startsHidden || picked)) || onTarget || ((changes || removed) && (observed || startsHidden))) { hit(lineAt(sc, code, trigger.index), trigger[0]); return; }
        if (namedShow) hit(lineAt(sc, code, trigger.index), trigger[0], 'warn');
      }
      const attrTrigger = page.all.find((el) => el.attrs.onscroll);
      if (attrTrigger && startsHidden) { hit(attrTrigger.line, `onscroll="${attrTrigger.attrs.onscroll.slice(0, 40)}"`); return; }
      for (const el of page.all) {
        const a = Object.keys(el.attrs).find((k) => /^data-(?:aos|sal|animate-on-scroll|scroll-reveal|sr)$/.test(k));
        if (a) { hit(el.line, a, 'warn'); return; }
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
          hit(d.line, `${d.selector} { opacity: 0 }`, 'warn');
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
    maybe: 'only a class or file name such as noise or grain marked this as a texture and a photo of a grain silo is named the same way',
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
        if (/^background(?:-image)?$|^mask(?:-image)?$|^content$/.test(d.prop) && /url\([^)]*(?:noise|grain|dither)[^)]*\)/i.test(d.value) && !(targets(d, page).length && targets(d, page).every((el) => el.attrs.role === 'img' || el.attrs['aria-label']))) { hit(d.line, `${d.prop}: ${d.value}`, 'warn'); continue; }
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
        if (cls || file) { hit(el.line, el.attrs.class || el.attrs.src, 'warn'); return; }
      }
    },
  },
];
