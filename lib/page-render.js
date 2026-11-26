'use strict';

// The rendered check. The source check reads a page as text. It cannot see text a script
// builds at run time, a box that overflows on a phone, or something still moving after the page
// settles. This opens the page in an installed headless browser at each width, lets it settle,
// and reads back what a small probe measured. Zero packages: the browser runs with --dump-dom
// and the probe writes its measurements into the page as JSON.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { checkPage } = require('./page-rules');
const { parsePage, visibleText } = require('./page-scan');
const { makeProfileDir, removeProfileDir, headlessArgs, findBrowser } = require('./headless-chrome');

// page time the probe waits after load before it measures and the budget the browser runs to
const SETTLE_MS = 3000;
const BUDGET_MS = SETTLE_MS + 1000;
// a browser that hangs on one page must not hang the check; one page takes about a second here
const KILL_MS = 30000;
const PHONE_MAX = 600;
const OUT_ID = 'atris-render-probe';

const RULES = [
  { id: 'render-page-rules', why: 'the page rules found this only once scripts had run. The source check could not see it', fix: 'write this text and these blocks as plain HTML in the page, then fix them by the named rule' },
  { id: 'render-overflow', why: 'the page scrolls sideways at this width', fix: 'let the named element wrap or shrink: max-width 100%, flexible columns, no fixed widths wider than a phone' },
  { id: 'render-clipped-text', why: 'text is cut off or hidden by its box', fix: 'let the box grow with its text: drop the fixed height, overflow hidden or the ellipsis' },
  { id: 'render-long-content', why: 'with three times longer headings, buttons, links, cells, labels and list items, the page scrolls sideways or cuts text off', fix: 'let these boxes wrap and grow, since real names and labels run long' },
  { id: 'render-still-moving', why: 'an animation never ends. The page keeps moving after it settles', fix: 'run the animation a set number of times, or drop it' },
  { id: 'render-hidden-text', why: 'text below the first screen stays invisible until a scroll shows it. Anyone who does not scroll the same way never sees it', fix: 'show the text as written: drop the opacity 0 or visibility hidden reveal' },
  { id: 'render-small-target', why: 'a button smaller than 44 by 44 CSS pixels is hard to tap on a phone', fix: 'give the button at least 44 by 44 pixels with padding or a min-height and min-width' },
];

// Runs inside the page. Kept as a plain function so it can be sent as source.
/* eslint-disable no-undef */
function probe(cfg) {
  const run = () => {
    const vw = innerWidth, vh = innerHeight;
    const cs = (el) => getComputedStyle(el);
    const name = (el) => {
      let s = el.tagName.toLowerCase();
      if (el.id) s += '#' + el.id;
      else if (el.classList && el.classList.length) s += '.' + [...el.classList].slice(0, 2).join('.');
      return s;
    };
    const whole = (el) => el === document.body || el === document.documentElement;
    const item = (el, extra) => (whole(el) ? { el: 'the page', id: '', text: '', ...extra }
      : { el: name(el), id: el.id || '', text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120), ...extra });
    const all = () => [...document.querySelectorAll('body *')];

    // elements that reach past the right edge with no clipping box above them, outermost only
    const wide = () => {
      const de = document.documentElement;
      // with overflow hidden on the page itself it cannot scroll; the cut text is a clipping finding
      if ([de, document.body].some((el) => el && /hidden|clip/.test(cs(el).overflowX))) return [];
      if (Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0) <= vw + 1) return [];
      const out = [];
      const sticks = (el) => el.getBoundingClientRect().right > vw + 1 && cs(el).position !== 'fixed';
      for (const el of all()) {
        if (!sticks(el)) continue;
        let clipped = false, p = el.parentElement, parentSticks = false;
        if (p && p !== document.body && sticks(p)) parentSticks = true;
        for (; p && p !== document.body; p = p.parentElement) if (cs(p).overflowX !== 'visible') { clipped = true; break; }
        if (!clipped && !parentSticks) out.push(el);
      }
      return out.length ? out : [document.body];
    };

    // boxes with overflow hidden or clip whose text runs past their padding box, or an ellipsis in use
    const clipped = () => {
      const found = new Set();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.nodeValue.trim() || n.parentElement.closest('script,style,noscript,template')) continue;
        range.selectNodeContents(n);
        const b = range.getBoundingClientRect();
        if (!b.width && !b.height) continue;
        for (let el = n.parentElement; el; el = el.parentElement) {
          const s = cs(el);
          const x = /hidden|clip/.test(s.overflowX), y = /hidden|clip/.test(s.overflowY);
          if (!x && !y) continue;
          // a box of one pixel is screen reader text, hidden on purpose
          if (el.clientWidth <= 1 || el.clientHeight <= 1) break;
          const r = el.getBoundingClientRect();
          const left = r.left + el.clientLeft, top = r.top + el.clientTop;
          const cutX = x && (b.left < left - 1 || b.right > left + el.clientWidth + 1);
          const cutY = y && (b.top < top - 1 || b.bottom > top + el.clientHeight + 1);
          const dots = x && s.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1;
          // the page itself clipping: name the text that is cut, not the whole page
          if (cutX || cutY || dots) { found.add(whole(el) ? n.parentElement : el); break; }
        }
      }
      return [...found];
    };

    const before = { wide: wide(), clipped: clipped() };

    // stretch the text of labels and names three times, measure again, then put it back
    const saved = [];
    for (const el of document.querySelectorAll('h1,h2,h3,h4,h5,h6,button,a,td,th,label,li')) {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (!n.nodeValue.trim() || saved.some((s) => s.n === n)) continue;
        saved.push({ n, v: n.nodeValue });
        const t = n.nodeValue.trim();
        n.nodeValue = n.nodeValue.replace(t, [t, t, t].join(' '));
      }
    }
    const after = { wide: wide(), clipped: clipped() };
    for (const s of saved) s.n.nodeValue = s.v;

    const moving = [];
    for (const a of document.getAnimations()) {
      const t = a.effect && a.effect.getComputedTiming();
      if (a.playState !== 'running' || !t || t.iterations !== Infinity || !a.effect.target) continue;
      if (!moving.some((m) => m.target === a.effect.target)) moving.push({ target: a.effect.target, what: a.animationName || 'a script animation' });
    }

    const gone = (s) => s.opacity === '0' || s.visibility === 'hidden';
    const hidden = all().filter((el) => {
      const s = cs(el);
      if (!gone(s) || /absolute|fixed/.test(s.position) || !(el.textContent || '').trim()) return false;
      if (el.parentElement && gone(cs(el.parentElement))) return false;
      if (el.closest('details:not([open]),dialog:not([open])')) return false;
      const r = el.getBoundingClientRect();
      return r.height > 0 && r.top >= vh;
    });

    const small = [];
    if (cfg.phone) {
      const drawn = (s) => (s.backgroundImage !== 'none' || !/^(?:transparent|rgba\([^)]*,\s*0\))$/.test(s.backgroundColor) || ['Top', 'Right', 'Bottom', 'Left'].every((k) => s['border' + k + 'Style'] !== 'none' && parseFloat(s['border' + k + 'Width']) > 0));
      for (const el of document.querySelectorAll('button,[role=button],input[type=submit],input[type=button],input[type=reset],a[href]')) {
        if (el.tagName === 'A' && el.getAttribute('role') !== 'button' && !drawn(cs(el))) continue;
        const r = el.getBoundingClientRect();
        if (r.width && r.height && (r.width < 44 || r.height < 44)) small.push(item(el, { size: Math.round(r.width) + ' by ' + Math.round(r.height) }));
      }
    }

    return {
      vw, vh,
      overflow: before.wide.map((el) => item(el)),
      clipped: before.clipped.map((el) => item(el)),
      long: [...after.wide.filter((el) => !before.wide.includes(el)).map((el) => item(el, { how: 'scrolls sideways' })),
        ...after.clipped.filter((el) => !before.clipped.includes(el)).map((el) => item(el, { how: 'cuts text off' }))],
      moving: moving.map((m) => item(m.target, { what: m.what })),
      hidden: hidden.map((el) => item(el)),
      small,
    };
  };
  addEventListener('load', () => setTimeout(() => {
    let res;
    try { res = run(); } catch (err) { res = { error: String(err && err.message || err) }; }
    parent.postMessage({ [cfg.out]: { res, dom: document.documentElement.outerHTML } }, '*');
  }, cfg.settle));
}
/* eslint-enable no-undef */

// The probe copy: a <base> so relative files still load from the page's own folder, or from where
// the page's own <base href> points, read against that folder. The browser takes the first base with
// an href. This one goes first. The probe script goes at the end. Both carry data-atris-probe so
// they can be taken out of the rendered page.
function injectProbe(html, dir, { phone = false, settle = SETTLE_MS } = {}) {
  const folder = pathToFileURL(dir.endsWith(path.sep) ? dir : dir + path.sep).href;
  const own = parsePage(html).all.find((el) => el.tag === 'base' && (el.attrs.href || '').trim());
  let href = folder;
  try { if (own) href = new URL(own.attrs.href.trim(), folder).href; } catch { /* an href the browser cannot read either */ }
  const base = `<base data-atris-probe href="${href.replace(/"/g, '%22')}">`;
  const cfg = JSON.stringify({ phone, settle, out: OUT_ID });
  const script = `<script data-atris-probe>(${probe.toString()})(${cfg});</script>`;
  const top = /<head\b[^>]*>/i.exec(html) || /<html\b[^>]*>/i.exec(html) || /<!doctype[^>]*>/i.exec(html);
  if (!top) return base + html + script;
  const at = top.index + top[0].length;
  return html.slice(0, at) + base + html.slice(at) + script;
}

// Headless Chrome will not open a window narrower than 500 pixels. The page runs in a frame of
// the asked width inside a wider window. The probe posts what it measured, with the page as
// rendered, to this frame page, which writes it out as JSON for --dump-dom.
function framePage(width, height) {
  return `<!doctype html><body style="margin:0"><iframe src="page.html" style="border:0;display:block;width:${width}px;height:${height}px"></iframe>`
    + `<script>addEventListener('message', (e) => { const d = e.data && e.data['${OUT_ID}']; if (!d) return;`
    + ` const s = document.createElement('script'); s.type = 'application/json'; s.id = '${OUT_ID}';`
    + ` s.textContent = JSON.stringify(d).replace(/</g, '\\\\u003c'); document.body.appendChild(s); });</script>`;
}

// Reads the dumped frame page: the probe's measurements and the page as rendered without the probe.
function readDump(dom) {
  const m = new RegExp(`<script[^>]*id="${OUT_ID}"[^>]*>([\\s\\S]*?)</script>`).exec(dom || '');
  let got = null;
  if (m) { try { got = JSON.parse(m[1]); } catch { got = null; } }
  if (!got) return { probed: null, page: '' };
  const page = String(got.dom || '')
    .replace(/<script data-atris-probe[^>]*>[\s\S]*?<\/script>/, '')
    .replace(/<base data-atris-probe[^>]*>/, '');
  return { probed: got.res || null, page };
}

function killTree(child) {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f']);
    else process.kill(-child.pid, 'SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
}

// One width: write the probe copy, run the browser, read stdout, always clean up.
function renderOnce(browser, html, dir, width, phone) {
  const tmp = makeProfileDir('atris-render-');
  const height = phone ? 844 : 800;
  return new Promise((resolve) => {
    let child, timer, out = '', done = false;
    // a browser started in its own process group does not hear a Ctrl-C at the terminal. An
    // interrupted check stops it and removes its profile before this process ends
    const stop = () => { if (child) killTree(child); removeProfileDir(tmp); };
    const onSignal = (sig) => { stop(); process.exit(sig === 'SIGINT' ? 130 : 143); };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    process.once('exit', stop);
    const finish = (res) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const [sig, fn] of [['SIGINT', onSignal], ['SIGTERM', onSignal], ['exit', stop]]) process.removeListener(sig, fn);
      removeProfileDir(tmp);
      resolve(res);
    };
    try {
      fs.writeFileSync(path.join(tmp, 'page.html'), injectProbe(html, dir, { phone }));
      const file = path.join(tmp, 'index.html');
      fs.writeFileSync(file, framePage(width, height));
      const args = headlessArgs(path.join(tmp, 'profile'), [
        '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
        `--window-size=${Math.max(width, 800)},${height + 100}`, `--virtual-time-budget=${BUDGET_MS}`, '--dump-dom', pathToFileURL(file).href,
      ]);
      child = spawn(browser, args, { stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
    } catch (err) {
      finish({ error: `the browser could not start: ${err.message}` });
      return;
    }
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', (err) => finish({ error: `the browser could not start: ${err.message}` }));
    let killed = false;
    child.on('close', (code, signal) => { if (!killed) finish({ dom: out, code, signal }); });
    timer = setTimeout(() => {
      killed = true;
      killTree(child);
      // the browser's helpers may still hold files for a moment after the kill
      setTimeout(() => finish({ error: `the browser did not finish within ${KILL_MS / 1000} seconds` }), 500);
    }, KILL_MS);
  });
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// The line in the source that holds this text or id, else 1 when a script built it.
function sourceLine(source, { text, id }) {
  const lines = source.split('\n');
  const probes = [id && `id="${id}"`, id && `id='${id}'`, norm(text).slice(0, 30)].filter((p) => p && p.length >= 4);
  for (const p of probes) {
    const i = lines.findIndex((l) => norm(l).includes(p));
    if (i >= 0) return i + 1;
  }
  return 1;
}

async function renderCheck(file, options = {}) {
  const widths = options.widths || [390, 1280];
  const blank = (reason) => ({ ran: false, reason, drewText: false, findings: [], results: [] });
  const browser = findBrowser(options.env, options.platform);
  if (!browser) return blank('no browser found on this computer. install Chrome, Chromium, Edge or Brave, or set CHROME_PATH');
  let source;
  try { source = fs.readFileSync(file, 'utf8'); } catch (err) { return blank(`the page could not be read: ${err.message}`); }
  const abs = path.resolve(file);
  const label = file;
  // a finding's text may name a line, which differs between the source and the rendered page
  const key = (f) => `${f.rule}\n${norm(f.text).replace(/\(line \d+\)/g, '')}`;
  const sourceSeen = new Set(checkPage(source, label, { file: abs, root: options.root }).findings.map(key));

  const found = new Map(RULES.map((r) => [r.id, []]));
  const seen = new Set();
  const add = (rule, width, it, text) => {
    const key = `${rule}\n${it.el}\n${norm(text)}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.get(rule).push({ rule, level: 'error', file: label, line: sourceLine(source, it), text: norm(text).slice(0, 80), width });
  };
  const anyPhone = widths.some((w) => w < PHONE_MAX);
  // drewText says the browser saw words on the page at some width: a script-drawn page was read
  let drewText = false;

  for (const width of widths) {
    const phone = width < PHONE_MAX;
    let res, dump;
    // about one run in fifty ended without the probe's report on this Mac. A width gets one more try
    for (let tries = 0; tries < 2 && !(dump && dump.probed); tries++) {
      res = await renderOnce(browser, source, path.dirname(abs), width, phone);
      if (res.error) return blank(`${res.error} at ${width}px`);
      dump = readDump(res.dom);
    }
    const { probed, page } = dump;
    // a browser that printed nothing on both tries failed itself, not the page
    if (!probed && !String(res.dom || '').trim()) return blank(`the browser ${browser} stopped with ${res.code === null ? `signal ${res.signal}` : `code ${res.code}`} and printed nothing. check CHROME_PATH`);
    if (!probed) return blank(`the page did not finish loading within ${BUDGET_MS / 1000} seconds of page time at ${width}px`);
    if (probed.error) return blank(`the measuring script failed at ${width}px: ${probed.error}`);
    if (probed.vw !== width) return blank(`the browser opened ${probed.vw}px wide when ${width}px was asked`);
    const drawn = parsePage(page);
    if (visibleText(drawn.root, drawn).replace(/\s+/g, '')) drewText = true;

    for (const f of checkPage(page, label, { file: abs, root: options.root }).findings) {
      // a note for the reviewer never fails a page, drawn or not
      if (f.level === 'warn' || sourceSeen.has(key(f))) continue;
      const text = f.text.replace(/\s*\(line \d+\)/g, '');
      add('render-page-rules', width, { el: f.rule, text }, `${f.rule}: ${text}`);
    }
    const desc = (it, tail) => `${it.el}${it.text ? ` "${it.text}"` : ''}${tail ? ` ${tail}` : ''}`;
    for (const it of probed.overflow) add('render-overflow', width, it, desc(it, 'reaches past the edge'));
    for (const it of probed.clipped) add('render-clipped-text', width, it, desc(it));
    for (const it of probed.long) add('render-long-content', width, it, desc(it, it.how));
    for (const it of probed.moving) add('render-still-moving', width, it, desc(it, `runs ${it.what} forever`));
    for (const it of probed.hidden) add('render-hidden-text', width, it, desc(it));
    for (const it of probed.small) add('render-small-target', width, it, desc(it, `is ${it.size}`));
  }

  const when = `Seen at ${widths.join(' and ')} pixels wide after ${SETTLE_MS / 1000} seconds of page time, not for all time.`;
  const findings = [];
  const results = [];
  for (const r of RULES) {
    const why = `${r.why}. ${when}`;
    const list = found.get(r.id).map((f) => ({ ...f, text: `at ${f.width}px: ${f.text}`, why, fix: r.fix }));
    findings.push(...list);
    if (r.id === 'render-small-target' && !anyPhone) results.push({ id: r.id, ok: null, why: 'no phone width was rendered' });
    else results.push({ id: r.id, ok: list.length === 0 });
  }
  return { ran: true, reason: '', drewText, findings, results };
}

module.exports = { renderCheck, injectProbe, framePage, readDump, RENDER_RULES: RULES };
