// The content page: a page an agent writes as plain html starting at <main>, with no class, style
// or script. The agent owns the words. The tool owns the look: compilePage wraps the content in plain
// or in a theme the owner picked (atris theme pick, kept in .atris/theme.json).
// Each grammar rule is a yes/no check with a line number. A content page must also pass every page
// rule in lib/page-rules.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parsePage, visibleText } = require('./page-scan');
const { PAGE_RULES, checkPage, pageMode, rulesProblem } = require('./page-rules');
const { esc, THEMES } = require('./html-render');
const { mergedThemes, readThemePicks, recordThemePick } = require('./theme');

const TAGS = new Set('main header section article aside footer nav address h1 h2 h3 p blockquote hr a ul ol li dl dt dd details summary table caption thead tbody tr th td form label input textarea select option button output cite img picture source figure time code pre kbd q strong em abbr sub sup'.split(' '));
// Attributes that hand the page a look or a behaviour. Every other attribute is the page's own:
// links, forms, tables, language and the words a screen reader says.
const LOOK_ATTRS = new Set(['class', 'style']);
const BEHAVIOUR_ATTRS = new Set('slot part is contenteditable srcdoc hidden inert popover popovertarget popovertargetaction tabindex autofocus draggable accesskey align valign bgcolor background color face border cellpadding cellspacing nowrap'.split(' '));
const HEADINGS = new Set(['h1', 'h2', 'h3']);
const SECTIONS = new Set(['section', 'article', 'aside']);
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
// A note (a guess at a statistic) is left to that rule's own note.
function statistics(text, label) {
  const page = parsePage(text);
  for (const el of [...page.all]) {
    if (!page.all.includes(el)) continue;
    if (el.tag === 'cite' || /^(?:sources?|data|via)\s*:/i.test(textOf(el, page))) detach(page, el);
  }
  const rule = PAGE_RULES.find((r) => r.id === 'page-unsourced-number');
  const found = [];
  rule.check({ page, label }, (line, matched, level = 'error') => { if (level === 'error') found.push({ line, text: matched }); });
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
    what: 'a tag not on the allowed list', fix: `write it with these tags: ${[...TAGS].join(' ')}`,
    check({ page }, hit) { for (const el of page.all) if (!TAGS.has(el.tag)) hit(el.line, `<${el.tag}>`); },
  },
  {
    id: 'lang-attrs', line: 'No class, style, script, on handlers or data- attributes, and nothing else that sets a look or a behaviour (slot, part, is, contenteditable, srcdoc, hidden, tabindex, align, color and the like). Every other attribute is fine.',
    what: 'an attribute that sets a look or a behaviour', fix: 'remove it. a content page holds words and structure only',
    check({ page }, hit) {
      for (const el of page.all) {
        for (const [name, value] of Object.entries(el.attrs)) {
          if (LOOK_ATTRS.has(name)) hit(el.line, `${name} on <${el.tag}>`, 'remove it. the look is not yours to set');
          else if (BEHAVIOUR_ATTRS.has(name) || /^(?:on|data-)/.test(name) || /^\s*javascript:/i.test(String(value))) hit(el.line, `${name} on <${el.tag}>`);
        }
      }
    },
  },
  {
    id: 'lang-heading', line: 'Exactly one h1, and it is the first heading in main. If main has a header, the h1 is in it.',
    what: 'a page without one h1 as its first heading', fix: 'keep one h1 and put it before every other heading',
    check({ page }, hit) {
      const main = firstEl(page.root);
      if (!main || main.tag !== 'main') return;
      const h1s = page.all.filter((el) => el.tag === 'h1');
      if (!h1s.length) hit(main.line, 'no h1');
      for (const h of h1s.slice(1)) hit(h.line, 'a second h1');
      const first = under(main).find((n) => n.type === 'el' && HEADINGS.has(n.tag));
      if (first && first.tag !== 'h1') hit(first.line, `<${first.tag}> before the h1`);
      for (const header of els(main).filter((el) => el.tag === 'header')) {
        if (!under(header).includes(h1s[0])) hit(header.line, 'a header without the h1');
      }
    },
  },
  {
    id: 'lang-source', line: 'A section, article or aside that shows a statistic names its source in a <cite> holding a web address or a file that exists.',
    what: 'a statistic with no source in its section', fix: 'add <cite> with the web address or the file it came from, or drop the number',
    check({ page, text, label, dir, root }, hit) {
      const sections = page.all.filter((el) => SECTIONS.has(el.tag)).map((el) => ({ el, from: el.line, to: endLine(el) }));
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
    id: 'lang-form', line: 'Every input, textarea and select has a <label for>. A form has one submit button and the words shown when it fails, in an <output> or a role="alert" or aria-live element inside the form or right after it.',
    what: 'a field with no label', fix: 'add a <label for> that names it',
    check({ page }, hit) {
      const labelled = new Set(page.all.filter((el) => el.tag === 'label' && el.attrs.for).map((el) => el.attrs.for));
      // a button, a hidden field or a picture button shows no field to name
      const unnamed = (el) => el.tag === 'input' && /^(?:submit|button|reset|hidden|image)$/i.test(el.attrs.type || '');
      for (const el of page.all) if (FIELDS.has(el.tag) && !unnamed(el) && !(el.attrs.id && labelled.has(el.attrs.id))) hit(el.line, `<${el.tag}>`);
      const says = (el) => el.tag === 'output' || el.attrs.role === 'alert' || 'aria-live' in el.attrs;
      for (const form of page.all.filter((el) => el.tag === 'form')) {
        const inside = under(form).filter((n) => n.type === 'el');
        const submits = inside.filter((el) => (el.tag === 'button' && !['button', 'reset'].includes((el.attrs.type || 'submit').toLowerCase())) || (el.tag === 'input' && /^submit$/i.test(el.attrs.type || '')));
        const sibling = els(form.parent)[els(form.parent).indexOf(form) + 1];
        const messages = [...inside, ...(sibling ? [sibling] : [])].filter(says);
        if (submits.length !== 1) hit(form.line, `${submits.length} submit buttons`, 'keep one submit button', 'a form without exactly one submit button');
        // words in the source that never show (a hidden element) are no words to a reader
        const written = messages.some((el) => under(el).some((n) => n.type === 'text' && n.text.trim()));
        if (!messages.some((el) => textOf(el, page))) hit(form.line, '<form>', 'write what went wrong in an <output>, or in an element with role="alert", inside the form or right after it', written ? 'a form whose failure words never show' : 'a form that does not say what went wrong when it fails');
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
    rule.check(ctx, (line, matched, fix = rule.fix, what = rule.what) => {
      if (seen.has(line)) return;
      seen.add(line);
      findings.push({ rule: rule.id, kind: 'content', level: 'error', file: label, line, text: String(matched).replace(/\s+/g, ' ').trim().slice(0, 80), why: what, fix });
    });
    results.push({ id: rule.id, ok: !seen.size });
  }
  const rules = checkPage(text, label, { root, file, siteRoot: options.siteRoot });
  findings.push(...rules.findings);
  findings.sort((a, b) => a.line - b.line);
  return { kind: 'content', findings, results: [...results, ...rules.results], off: rules.off, notChecked: rules.notChecked };
}

// --- themes ---------------------------------------------------------------------------

// Plain is the absence of a theme: black on white, the system font, a readable measure, table lines,
// and buttons big enough to tap on a phone.
const PLAIN_CSS = 'body{margin:0;background:#fff;color:#000;font:17px/1.5 system-ui,sans-serif}main{max-width:40em;margin:0 auto;padding:2em 1em}table{border-collapse:collapse}th,td{border:1px solid #000;padding:.25em .5em;text-align:left}img{max-width:100%;height:auto}a{color:#000}button,input[type=submit]{min-height:44px;min-width:44px;padding:.5em 1em}';

// A theme from atris theme list (built in or in .atris/theme.json) styles a content page through
// elements only: its colours and fonts on top of plain. A value cannot close the rule it sits in.
function themeCss(root, name = 'plain') {
  if (name === 'plain') return PLAIN_CSS;
  // the name goes in the built page's atris-page line, which reads lowercase letters, digits and hyphens
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`theme name must use lowercase letters, digits and hyphens: ${name}`);
  const t = mergedThemes(THEMES, root)[name];
  if (!t) throw new Error(`no theme named ${name}. atris theme list shows the themes`);
  const v = (x) => String(x).replace(/[{};<>]/g, '');
  const { color: c, fonts: f } = t;
  return `${PLAIN_CSS}body{background:${v(c.bg)};color:${v(c.ink)};font-family:${v(f.body)},system-ui,sans-serif}h1,h2,h3{font-family:${v(f.display)},system-ui,sans-serif}a{color:${v(c.accent)}}th,td{border-color:${v(c.line)}}code,pre{font-family:${v(f.mono)}}`;
}

function recordPick(root, name, today = new Date().toISOString().slice(0, 10)) {
  return recordThemePick(root, name, sha256(themeCss(root, name)), today);
}
const isPicked = (root, name, css) => name === 'plain' ? css === PLAIN_CSS : (readThemePicks(root)[name] || {}).sha256 === sha256(css);
// What atris theme list says about a theme for content pages
function pickState(root, name) {
  const p = readThemePicks(root)[name];
  if (!p) return 'not picked';
  let css;
  try { css = themeCss(root, name); } catch (e) { return e.message; }
  return p.sha256 === sha256(css) ? `picked ${p.picked_on}` : 'changed after its pick, not picked';
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

// A built page must still be the page that was built, in plain or a theme the owner picked.
function builtProblems(text, root) {
  const page = parsePage(text);
  const meta = page.all.find((el) => el.tag === 'meta' && el.attrs.name === 'atris-page');
  if (!meta) return [];
  const m = /^([a-z0-9][a-z0-9-]*) sha256:([0-9a-f]{64})$/.exec(meta.attrs.content || '');
  const style = /<style>([\s\S]*?)<\/style>/.exec(text);
  const css = style ? style[1] : '';
  const out = [];
  // the page is built again from its own main and css: any byte that differs is an edit
  if (!m || compilePage(text, { look: m[1], lookCss: css }) !== String(text).replace(/\r\n?/g, '\n')) {
    out.push({ rule: 'built-edited', line: meta.line, text: '', why: 'edited after it was built', fix: 'rebuild it from the content page' });
  } else if (!isPicked(root, m[1], css)) {
    out.push({ rule: 'built-look-unpicked', line: meta.line, text: '', why: `theme ${m[1]} has no pick on record in .atris/theme.json`, fix: 'only the owner picks a theme for content pages, with atris theme pick <name> at a terminal' });
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
// The one verdict on a page's text: the content page grammar and the page rules for a page that
// starts at <main>, the page rules alone for any other page. atris slop detect --kind screen uses it too.
const checkText = (text, label, opts) => (parsePage(text).isContentPage ? checkContentPage : checkPage)(text, label, opts);

function checkFile(file, { root = process.cwd(), label = file, built = false, siteRoot = null } = {}) {
  const text = fs.readFileSync(file, 'utf8');
  const res = checkText(text, label, { root, file, siteRoot });
  if (built) {
    for (const f of builtProblems(text, root)) res.findings.push({ kind: 'built', level: 'error', file: label, ...f });
    // a style sheet missing from a folder about to go live is almost always a typo
    for (const m of res.notChecked.filter((n) => n.missing)) res.findings.push({ rule: 'built-missing-sheet', kind: 'built', level: 'error', file: label, line: m.line, text: m.what, why: 'a style sheet that is not in the folder', fix: 'point the link at the file, or remove it' });
  }
  const notChecked = res.notChecked.filter((n) => !(built && n.missing)).map((n) => n.said);
  // rendered says whether the browser rules ran. only atris site check --render sets it true.
  return { file: label, kind: res.kind, ok: mustFix(res).length === 0, rendered: false, results: res.results, findings: res.findings, off: res.off, notChecked };
}

// --- reporting and the upload gate ------------------------------------------------------

// a must-fix line fails a page. a note for the reviewer (level warn) never does
const mustFix = (res) => (res.findings || []).filter((f) => f.level !== 'warn');
const notes = (res) => (res.findings || []).filter((f) => f.level === 'warn');

const shown = (file) => { const rel = path.relative(process.cwd(), file); return !rel ? path.basename(file) : rel.startsWith('..') ? file : rel; };
const sentence = (s) => String(s || '').trim().replace(/[.\s]+$/, '');

const what = (f) => `${sentence(String(f.why).split(/:\s|\.\s/)[0])}${f.text ? `: "${f.text}"` : ''}`;
// One line per must-fix finding: what is wrong, then the fix. A watching check would refuse, it does not.
function refusal(res, verb = 'refused') {
  const n = mustFix(res).length;
  const out = [`${verb} ${res.file} (${n} thing${n === 1 ? '' : 's'} to fix)`];
  for (const f of mustFix(res)) out.push(`line ${f.line}: ${what(f)}. ${sentence(f.fix)}.`);
  return out.join('\n');
}
// A note for the reviewer: what was seen and why it may be fine. It never fails the page.
const noteLines = (res) => notes(res).map((f) => `${res.file}:${f.line} for the reviewer: ${what(f)}. it may be fine: ${sentence(f.maybe || 'this is a guess from words or names')}.`);

// What a plain run prints for one file. --json carries the same words in each file's text.
// A path as a shell reads it. One that starts with a dash gets ./ in front so it is not read as a flag.
// A posix shell gets single quotes when the path holds a space or a shell character, or starts with
// = or ~. windows cmd reads only double quotes and a plain backslash path needs none.
function quoted(file, platform = process.platform) {
  const f = String(file).startsWith('-') ? `./${file}` : String(file);
  if (platform === 'win32') return /^[\w@+=:,./\\-]+$/.test(f) ? f : `"${f}"`;
  return /^[\w@%+=:,./-]+$/.test(f) && !/^[=~]/.test(f) ? f : `'${f.replace(/'/g, `'\\''`)}'`;
}

// A pass that did not open the page in a browser says so and names the command that does.
// reason is set when --render was asked and the browser could not run; then that is said instead.
function linesFor(res, verb, platform) {
  const missed = res.notChecked || [];
  const unrun = res.rendered !== false ? '' : res.reason ? '. the browser rules did not run' : `. the browser rules did not run: atris site check ${quoted(res.file, platform)} --render runs them`;
  const pass = missed.length ? `ok ${res.file}: no rule failed. not checked: ${missed.join('; ')}${unrun}`
    : unrun ? `ok ${res.file}: every page rule passes${unrun}` : `ok ${res.file}: every rule passes`;
  const out = [!res.ok ? refusal(res, verb) : pass, ...noteLines(res)];
  if (res.off && res.off.length) out.push(`switched off in .atris/slop.rules.json: ${res.off.join(', ')}`);
  if (res.reason) out.push(`the browser check did not run on ${res.file}: ${res.reason}`);
  return out.join('\n');
}

// Exit 1 when a page fails or when --render was asked and the browser check did not run.
function report(files, { json, log = console.log, err = console.error, platform } = {}) {
  if (json) log(JSON.stringify({ files: files.map((res) => ({ ...res, text: linesFor(res, undefined, platform) })) }, null, 2));
  else for (const res of files) (res.ok && !res.reason ? log : err)(linesFor(res, undefined, platform));
  return files.every((r) => r.ok && !r.reason) ? 0 : 1;
}

const BLOCK_LINE = 'to turn blocking on, put "pages": "block" in .atris/slop.rules.json';

// Every html page in a folder about to be uploaded, checked after any build and before anything
// leaves this machine. The project's mode decides what a failing page does: in watch mode (the
// default) the check says on stderr what would fail and these lines do not stop the upload. In block
// mode each page marked would refuse stops it and nothing is uploaded. Every mode names what the check
// could not read. Returns { refused, check }; check is what --json output carries.
// The mode, the off list and the theme picks are read from the folder the command runs in, the same
// folder the build reads. A rules file there that cannot be read refuses the upload, since the
// owner's choice of mode is then unknown.
function checkBeforeUpload(dir, { files = htmlFilesIn(dir), root = process.cwd(), json = false, log = console.log, err = console.error } = {}) {
  const problem = rulesProblem(root);
  if (problem) {
    err(`${problem}. nothing was uploaded: fix the file or remove it`);
    return { refused: true, check: { mode: 'unknown', ok: false, off: [], files: [], error: problem } };
  }
  const siteRoot = path.resolve(dir);
  const mode = pageMode(root);
  const results = files.map((file) => checkFile(file, { root, label: shown(file), built: true, siteRoot }));
  const bad = results.filter((r) => !r.ok);
  const verb = mode === 'block' ? 'refused' : 'would refuse';
  const off = [...new Set(results.flatMap((r) => r.off || []))];
  const unread = results.filter((r) => r.notChecked.length);
  const check = { mode, ok: !bad.length, off, files: bad.map((r) => ({ file: r.file, findings: r.findings, text: linesFor(r, verb) })), not_checked: unread.map((r) => ({ file: r.file, lines: r.notChecked })) };
  // what was not read and the notes on passing pages, said whether or not another page failed
  const rest = [...unread.map((r) => `${r.file}: not checked: ${r.notChecked.join('; ')}`), ...results.filter((r) => r.ok).flatMap(noteLines)];
  if (!bad.length) {
    const lines = unread.length ? [`page check in ${mode} mode: no rule failed.`, ...rest] : rest;
    // a pass says which rules were switched off, since a page may pass only because one is off
    if (off.length) lines.push(`page check in ${mode} mode: switched off in .atris/slop.rules.json: ${off.join(', ')}`);
    if (lines.length) err(lines.join('\n'));
    return { refused: false, check };
  }
  if (mode !== 'block') {
    err(['page check in watch mode: these lines do not stop the upload. in block mode each page marked would refuse stops it.', ...check.files.map((f) => f.text), ...rest, BLOCK_LINE].join('\n'));
    return { refused: false, check };
  }
  report(bad, { json, log, err });
  if (rest.length) err(rest.join('\n'));
  err('page check in block mode: nothing was uploaded.');
  return { refused: true, check };
}

module.exports = { mustFix, GRAMMAR, PLAIN_CSS, checkContentPage, compilePage, themeCss, recordPick, isPicked, pickState, builtProblems, htmlFilesIn, checkText, checkFile, checkBeforeUpload, report, shown, sha256, BLOCK_LINE };
