// The content page: a page an agent writes as plain html starting at <main>, with no class, style
// or script. The agent owns the words. The tool owns the look: compilePage wraps the content in a
// look, and a look is a stylesheet only the owner picks (atris/looks/picked.json).
// Each grammar rule is a yes/no check with a line number. A content page must also pass every page
// rule in lib/page-rules.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parsePage, cssRules, visibleText } = require('./page-scan');
const { PAGE_RULES, checkPage } = require('./page-rules');
const { esc } = require('./html-render');

const TAGS = new Set('main header section footer nav h1 h2 h3 p a ul ol li table caption thead tbody tr th td form label input textarea select option button output cite img figure time code pre strong'.split(' '));
const ATTRS = new Set('href src alt action method for id name type required value placeholder datetime colspan rowspan width height checked disabled'.split(' '));
const HEADER_TAGS = new Set(['h1', 'a', 'button', 'img', 'figure', 'form']);
const FIELDS = new Set(['input', 'textarea', 'select']);
const WEB = /^https?:\/\/\S+$/i;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const els = (el) => el.children.filter((c) => c.type === 'el');
const firstEl = (el) => els(el)[0] || null;
const under = (el) => { const out = []; const walk = (n) => { for (const c of n.children) { out.push(c); if (c.type === 'el') walk(c); } }; walk(el); return out; };
const endLine = (el) => Math.max(el.line, ...under(el).map((n) => n.line + (n.type === 'text' ? (n.text.match(/\n/g) || []).length : 0)));
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const textOf = (el, page) => visibleText(el, page).trim();

function detach(page, el) {
  el.parent.children = el.parent.children.filter((c) => c !== el);
  const gone = new Set([el, ...under(el)]);
  page.all = page.all.filter((x) => !gone.has(x));
}

// Where a statistic sits: the page-unsourced-number rule decides what a statistic is. It runs on a copy
// of the page with every cite and Source: line taken out, so each number it finds is a statistic.
function statistics(text, label) {
  const page = parsePage(text);
  for (const el of [...page.all]) {
    if (!page.all.includes(el)) continue;
    if (el.tag === 'cite' || /^(?:sources?|data|via)\s*:/i.test(textOf(el, page))) detach(page, el);
  }
  const rule = PAGE_RULES.find((r) => r.id === 'page-unsourced-number');
  const found = [];
  rule.check({ page, label }, (line, matched) => found.push({ line, text: matched }));
  return found;
}

const GRAMMAR = [
  {
    id: 'lang-root', line: 'One <main> wraps everything. Nothing outside it and no comments.',
    what: 'something outside the one <main>', fix: 'put it inside <main>, or delete it',
    check({ page, text }, hit) {
      if (!/^\s*<main[\s>]/i.test(text)) hit(1, text.trim().slice(0, 40));
      for (const c of page.root.children) {
        if (c.type === 'el' ? c !== firstEl(page.root) : /\S/.test(c.text)) hit(c.line, c.type === 'el' ? `<${c.tag}>` : c.text);
      }
      for (const el of page.all) if (el.tag === 'main' && el !== firstEl(page.root)) hit(el.line, '<main>');
      for (const c of page.comments) hit(c.line, `<!--${c.text}-->`);
    },
  },
  {
    id: 'lang-tags', line: `Only these tags: ${[...TAGS].join(' ')}.`,
    what: 'a tag a content page does not use', fix: 'write it with the allowed tags, see atris site rules',
    check({ page }, hit) { for (const el of page.all) if (!TAGS.has(el.tag)) hit(el.line, `<${el.tag}>`); },
  },
  {
    id: 'lang-attrs', line: `Only these attributes: ${[...ATTRS].join(' ')}. No class, style, script or on handlers.`,
    what: 'an attribute a content page does not use', fix: 'remove it. the look is not yours to set',
    check({ page }, hit) {
      for (const el of page.all) for (const name of Object.keys(el.attrs)) if (!ATTRS.has(name)) hit(el.line, `${name} on <${el.tag}>`);
    },
  },
  {
    id: 'lang-heading', line: 'Exactly one h1. It opens the header, and the header opens main. The header holds only h1, a, button, img, figure and form.',
    what: 'main opens with a header that holds the one h1 and only h1, a, button, img, figure or form', fix: 'start main with <header><h1>, and move any other line out of the header',
    check({ page }, hit) {
      const main = firstEl(page.root);
      if (!main || main.tag !== 'main') return;
      const h1s = page.all.filter((el) => el.tag === 'h1');
      for (const h of h1s.slice(1)) hit(h.line, 'a second h1');
      const header = firstEl(main);
      if (!header || header.tag !== 'header') { hit(header ? header.line : main.line, 'main does not open with <header>'); return; }
      const first = firstEl(header);
      if (!first || first.tag !== 'h1') hit(first ? first.line : header.line, 'the header does not open with the h1');
      for (const el of els(header)) if (!HEADER_TAGS.has(el.tag)) hit(el.line, `<${el.tag}> in the header`);
    },
  },
  {
    id: 'lang-source', line: 'A section that shows a statistic names its source in a <cite> holding a web address or a file that exists.',
    what: 'a statistic with no source in its section', fix: 'add <cite> with the web address or the file it came from, or drop the number',
    check({ page, text, label, dir, root }, hit) {
      const sections = page.all.filter((el) => el.tag === 'section').map((el) => ({ el, from: el.line, to: endLine(el) }));
      const real = (cite) => { const t = textOf(cite, page); return !!t && (WEB.test(t) || isFile(path.resolve(dir, t)) || isFile(path.resolve(root, t))); };
      for (const stat of statistics(text, label)) {
        const home = sections.filter((s) => s.from <= stat.line && stat.line <= s.to).sort((a, b) => b.from - a.from)[0];
        if (!home) { hit(stat.line, `${stat.text} (outside a section)`); continue; }
        if (!under(home.el).some((n) => n.type === 'el' && n.tag === 'cite' && real(n))) hit(stat.line, stat.text);
      }
    },
  },
  {
    id: 'lang-image', line: 'Every <img> has alt text and a src that is a web address or a file beside the page.',
    what: 'an image with no alt text or no file', fix: 'add alt words that say what it shows, and point src at a file that exists',
    check({ page, dir }, hit) {
      for (const el of page.all) {
        if (el.tag !== 'img') continue;
        const src = (el.attrs.src || '').trim();
        if (!(el.attrs.alt || '').trim() || !src || !(WEB.test(src) || isFile(path.resolve(dir, src)))) hit(el.line, `<img src="${src}">`);
      }
    },
  },
  {
    id: 'lang-form', line: 'Every input, textarea and select has a <label for>. A form has one submit button and one <output> with the words shown when it fails.',
    what: 'a field with no label, or a form without one submit button and one failure message', fix: 'label every field, keep one submit button, and write the failure words in one <output>',
    check({ page }, hit) {
      const labelled = new Set(page.all.filter((el) => el.tag === 'label' && el.attrs.for).map((el) => el.attrs.for));
      // a button, a hidden field or a picture button shows no field to name
      const unnamed = (el) => el.tag === 'input' && /^(?:submit|button|reset|hidden|image)$/i.test(el.attrs.type || '');
      for (const el of page.all) if (FIELDS.has(el.tag) && !unnamed(el) && !(el.attrs.id && labelled.has(el.attrs.id))) hit(el.line, `<${el.tag}> with no label`);
      for (const form of page.all.filter((el) => el.tag === 'form')) {
        const inside = under(form).filter((n) => n.type === 'el');
        const submits = inside.filter((el) => (el.tag === 'button' && !['button', 'reset'].includes((el.attrs.type || 'submit').toLowerCase())) || (el.tag === 'input' && /^submit$/i.test(el.attrs.type || '')));
        const outputs = inside.filter((el) => el.tag === 'output');
        if (submits.length !== 1) hit(form.line, `${submits.length} submit buttons`);
        if (outputs.length !== 1 || !textOf(outputs[0], page)) hit(form.line, outputs.length === 1 ? 'an empty <output>' : `${outputs.length} <output> elements`);
      }
    },
  },
];

function checkContentPage(text, label = 'page.html', options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const file = options.file || null;
  const dir = path.resolve(options.dir || (file ? path.dirname(file) : root));
  const page = parsePage(text);
  const ctx = { page, text: page.text, label, dir, root };
  const findings = [], results = [];
  for (const rule of GRAMMAR) {
    const seen = new Set();
    rule.check(ctx, (line, matched) => {
      if (seen.has(line)) return;
      seen.add(line);
      findings.push({ rule: rule.id, kind: 'content', level: 'error', file: label, line, text: String(matched).replace(/\s+/g, ' ').trim().slice(0, 80), why: rule.what, fix: rule.fix });
    });
    results.push({ id: rule.id, ok: !seen.size });
  }
  const rules = checkPage(text, label, { root, file, siteRoot: options.siteRoot });
  findings.push(...rules.findings);
  findings.sort((a, b) => a.line - b.line);
  return { kind: 'content', findings, results: [...results, ...rules.results], off: rules.off, notChecked: rules.notChecked };
}

// --- looks ---------------------------------------------------------------------------

// Plain is the absence of a look: black on white, the system font, a readable measure, table lines,
// and buttons big enough to tap on a phone.
const PLAIN_CSS = 'body{margin:0;background:#fff;color:#000;font:17px/1.5 system-ui,sans-serif}main{max-width:40em;margin:0 auto;padding:2em 1em}table{border-collapse:collapse}th,td{border:1px solid #000;padding:.25em .5em;text-align:left}img{max-width:100%;height:auto}a{color:#000}button,input[type=submit]{min-height:44px;min-width:44px;padding:.5em 1em}';

function readLook(root, name = 'plain') {
  if (name === 'plain') return PLAIN_CSS;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`look name must use lowercase letters, digits and hyphens: ${name}`);
  const file = path.join(root, 'atris', 'looks', `${name}.css`);
  if (!isFile(file)) throw new Error(`no look named ${name}. looks live at atris/looks/<name>.css`);
  return fs.readFileSync(file, 'utf8');
}

// A look reaches content only through elements, attributes, pseudo-classes and combinators.
function lookSelectorProblems(css) {
  const out = [];
  for (const rule of cssRules(css)) {
    if (rule.at && rule.at !== 'media') continue;
    const bare = rule.selector.replace(/\[[^\]]*\]/g, '[]').replace(/"[^"]*"|'[^']*'/g, '""');
    if (/[.#]/.test(bare)) out.push({ line: rule.line, text: rule.selector });
  }
  return out;
}

function picksFile(root) { return path.join(root, 'atris', 'looks', 'picked.json'); }
function readPicks(root) {
  try { const raw = JSON.parse(fs.readFileSync(picksFile(root), 'utf8')); return raw && typeof raw === 'object' ? raw : {}; } catch { return {}; }
}
function recordPick(root, name, today = new Date().toISOString().slice(0, 10)) {
  const picks = readPicks(root);
  picks[name] = { name, sha256: sha256(readLook(root, name)), picked_on: today };
  fs.mkdirSync(path.dirname(picksFile(root)), { recursive: true });
  fs.writeFileSync(picksFile(root), `${JSON.stringify(picks, null, 2)}\n`);
  return picks[name];
}
const isPicked = (root, name, css) => name === 'plain' ? css === PLAIN_CSS : !!readPicks(root)[name] && readPicks(root)[name].sha256 === sha256(css);

function listLooks(root) {
  const dir = path.join(root, 'atris', 'looks');
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.css')).map((f) => f.slice(0, -4)).sort(); } catch { /* no project looks */ }
  const picks = readPicks(root);
  return [{ name: 'plain', state: 'built in' }, ...names.map((name) => {
    const css = readLook(root, name);
    const state = !picks[name] ? 'not picked' : picks[name].sha256 === sha256(css) ? `picked ${picks[name].picked_on}` : 'changed after its pick, not picked';
    return { name, state };
  })];
}

// --- compile ---------------------------------------------------------------------------

const mainOf = (text) => { const a = text.search(/<main[\s>]/i), b = text.toLowerCase().lastIndexOf('</main>'); return a < 0 || b < a ? '' : text.slice(a, b + 7); };

function compilePage(text, { look = 'plain', lookCss = PLAIN_CSS } = {}) {
  const main = mainOf(String(text).replace(/\r\n?/g, '\n'));
  const page = parsePage(main);
  const h1 = page.all.find((el) => el.tag === 'h1');
  const title = h1 ? textOf(h1, page) : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="atris-page" content="${esc(look)} sha256:${sha256(lookCss + main)}">
<style>${lookCss}</style>
</head>
<body>
${main}
</body>
</html>
`;
}

// A built page must still be the page that was built, in plain or a look the owner picked.
function builtProblems(text, root) {
  const page = parsePage(text);
  const meta = page.all.find((el) => el.tag === 'meta' && el.attrs.name === 'atris-page');
  if (!meta) return [];
  const m = /^([a-z0-9][a-z0-9-]*) sha256:([0-9a-f]{64})$/.exec(meta.attrs.content || '');
  const style = /<style>([\s\S]*?)<\/style>/.exec(text);
  const css = style ? style[1] : '';
  const out = [];
  if (!m || sha256(css + mainOf(page.text)) !== m[2]) {
    out.push({ rule: 'built-edited', line: meta.line, text: '', why: 'edited after it was built', fix: 'rebuild it from the content page' });
  } else if (!isPicked(root, m[1], css)) {
    out.push({ rule: 'built-look-unpicked', line: meta.line, text: '', why: `look ${m[1]} has no pick on record`, fix: 'only the owner picks a look' });
  }
  return out;
}

// --- files ---------------------------------------------------------------------------

function htmlFilesIn(target) {
  const out = [];
  const walk = (p) => {
    let st;
    try { st = fs.statSync(p); } catch { return; }
    if (st.isFile()) { if (/\.html?$/i.test(p)) out.push(p); return; }
    if (!st.isDirectory()) return;
    for (const name of fs.readdirSync(p).sort()) if (!name.startsWith('.') && name !== 'node_modules') walk(path.join(p, name));
  };
  walk(path.resolve(target));
  return out;
}

// One file, as `atris site check` and the landing gate read it. built: also hold a built page to its
// recorded look and pick, as publish does. notChecked names what the check could not see.
function checkFile(file, { root = process.cwd(), label = file, built = false, siteRoot = null } = {}) {
  const text = fs.readFileSync(file, 'utf8');
  const res = parsePage(text).isContentPage
    ? checkContentPage(text, label, { root, file, siteRoot })
    : checkPage(text, label, { root, file, siteRoot });
  if (built) {
    for (const f of builtProblems(text, root)) res.findings.push({ kind: 'built', level: 'error', file: label, ...f });
    // a style sheet missing from a folder about to go live is almost always a typo
    for (const m of res.notChecked.filter((n) => n.missing)) res.findings.push({ rule: 'built-missing-sheet', kind: 'built', level: 'error', file: label, line: m.line, text: m.what, why: 'a style sheet that is not in the folder', fix: 'point the link at the file, or remove it' });
  }
  const notChecked = res.notChecked.filter((n) => !(built && n.missing)).map((n) => n.said);
  return { file: label, kind: res.kind, ok: res.findings.length === 0, results: res.results, findings: res.findings, off: res.off, notChecked };
}

// --- reporting and the upload gate ------------------------------------------------------

const shown = (file) => { const rel = path.relative(process.cwd(), file); return !rel ? path.basename(file) : rel.startsWith('..') ? file : rel; };
const sentence = (s) => String(s || '').trim().replace(/[.\s]+$/, '');

// One line per finding: what is wrong, then the fix.
function refusal(res) {
  const lines = new Set(res.findings.map((f) => f.line)).size;
  const out = [`refused ${res.file} (${lines} line${lines === 1 ? '' : 's'} to fix)`];
  for (const f of res.findings) {
    const what = sentence(String(f.why).split(/:\s|\.\s/)[0]);
    out.push(`line ${f.line}: ${what}${f.text ? `: "${f.text}"` : ''}. ${sentence(f.fix)}.`);
  }
  return out.join('\n');
}

function report(files, { json, log = console.log, err = console.error } = {}) {
  if (json) log(JSON.stringify({ files }, null, 2));
  for (const res of files) {
    const say = res.ok ? log : err;
    const missed = res.notChecked || [];
    if (!json) say(!res.ok ? refusal(res) : missed.length ? `ok ${res.file}: no rule failed, but not checked: ${missed.join('; ')}` : `ok ${res.file}: every rule passes`);
    if (res.off && res.off.length) say(`switched off in .atris/slop.rules.json: ${res.off.join(', ')}`);
  }
  return files.every((r) => r.ok) ? 0 : 1;
}

// Every html page in a folder about to be uploaded, checked after any build and before anything
// leaves this machine. Returns 0 when every page passes, else 1 after saying why.
function checkBeforeUpload(dir, { files = htmlFilesIn(dir), root = process.cwd(), json = false, log = console.log, err = console.error } = {}) {
  const siteRoot = path.resolve(dir);
  const results = files.map((file) => checkFile(file, { root, label: shown(file), built: true, siteRoot }));
  const bad = results.filter((r) => !r.ok);
  if (!bad.length) {
    for (const r of results) if (r.notChecked.length) log(`${r.file}: not checked: ${r.notChecked.join('; ')}`);
    return 0;
  }
  report(bad, { json, log, err });
  err('nothing was uploaded.');
  return 1;
}

module.exports = { GRAMMAR, PLAIN_CSS, checkContentPage, compilePage, readLook, lookSelectorProblems, readPicks, recordPick, isPicked, listLooks, builtProblems, htmlFilesIn, checkFile, checkBeforeUpload, report, shown, sha256 };
