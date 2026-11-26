// Page rules for `atris slop detect --kind screen` on html pages. Each rule is data plus a
// check that reads the page structure and the resolved style declarations (lib/page-scan.js),
// so a renamed class or a card drawn with a plain div is still seen.
// A hit is an error, a must-fix line, when the file itself proves the fault: the character, the banned
// word, a css value, a shape of markup. A hit that decides what words mean or what an element is for
// from a list of phrases or of class, id or icon names is a guess: level warn, a note for the reviewer.
// A rule marks this with level: 'warn' when it is all guess, or by passing 'warn' as the third argument
// of hit for its guessed part. maybe says why a note may be fine. A note never fails a page.
// A project can switch a rule off in .atris/slop.rules.json
// ({ "off": ["page-glow"] }); a switched-off rule is reported in `off`, never dropped silently.
// The same file holds the upload mode: "pages": "block" makes publish, deploy and the landing gate
// refuse a failing page. Without it they watch: they say what fails and go ahead as before.
// The rules live by group: words.js, shape.js and look.js. shared.js reads the page for all of them.

const fs = require('fs');
const path = require('path');
const { parsePage, isHidden, visibleText } = require('../page-scan');
const { clip, inside } = require('./shared');

const PAGE_RULES = [...require('./words'), ...require('./shape'), ...require('./look')];

// --- running ----------------------------------------------------------------------

// The project's .atris/slop.rules.json, read from the folder the command runs in. A missing file
// is no rules at all. A file that is there and cannot be read gives error, since the owner's choice
// is then unknown: the check names it and the upload check refuses.
function readRules(root) {
  let text;
  try { text = fs.readFileSync(path.join(root, '.atris', 'slop.rules.json'), 'utf8'); } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { rules: {} };
    return { rules: {}, error: err.message };
  }
  try {
    const raw = JSON.parse(text);
    // a plain list is the form atris slop rules --add writes: slop rules only with no page settings
    if (Array.isArray(raw)) return { rules: {} };
    if (raw && typeof raw === 'object') {
      // a setting that parses and means nothing is the same quiet loss of the owner's choice
      if (raw.pages !== undefined && raw.pages !== 'block' && raw.pages !== 'watch') return { rules: {}, error: 'pages is neither "block" nor "watch"' };
      if (raw.off !== undefined && !Array.isArray(raw.off)) return { rules: {}, error: 'off is not a list of rule ids' };
      if (raw.renderSeconds !== undefined && !(typeof raw.renderSeconds === 'number' && raw.renderSeconds > 0)) return { rules: {}, error: 'renderSeconds is not a number of seconds above 0' };
      return { rules: raw };
    }
    return { rules: {}, error: 'it does not hold a json object' };
  } catch (err) { return { rules: {}, error: err.message }; }
}

// The one stderr line for a rules file that cannot be read, or '' when it reads or is missing.
function rulesProblem(root) {
  const { error } = readRules(root);
  return error ? `.atris/slop.rules.json could not be read: ${error.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase())}` : '';
}

function switchedOff(root) {
  const raw = root ? readRules(root).rules : {};
  return Array.isArray(raw.off) ? raw.off.filter((id) => PAGE_RULES.some((r) => r.id === id)) : [];
}

const pageMode = (root) => readRules(root).rules.pages === 'block' ? 'block' : 'watch';
// The owner's wait for the browser check on one page at one width, "renderSeconds" in the same file, or
// undefined when it is not set.
const renderSeconds = (root) => (root ? readRules(root).rules.renderSeconds : undefined);

// Style sheets the page links from its own folder are read as part of the page. Their rules
// report the line of the link, since the finding is about this page. A link is read the way the
// browser reads it: against the page's own <base href>. A link that starts with / is read against
// the folder being published (siteRoot).
// A sheet that cannot be read (remote, missing, imported, or built by a style script such as the
// tailwind play cdn) is named in page.unread. The check then says what it did not see.
function linkedSheets(page, file, siteRoot) {
  let dir;
  try { if (file && fs.statSync(file).isFile()) dir = path.dirname(file); } catch { /* no folder to read from */ }
  page.unread = [];
  for (const s of page.styles) if (/@import\b/i.test(s.text)) page.unread.push({ what: 'a style sheet it imports with @import' });
  for (const el of page.all) if (el.tag === 'script' && /tailwind|unocss|twind/i.test(el.attrs.src || '')) page.unread.push({ what: `the styles ${el.attrs.src} writes` });
  const base = page.all.find((el) => el.tag === 'base' && el.attrs.href);
  const remote = (href) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href);
  const baseHref = base ? base.attrs.href.trim() : '';
  for (const el of page.links) {
    const href = (el.attrs.href || '').trim();
    // a web font service's sheet only names font faces; the fonts in use are read from the page's own rules
    if (!/\bstylesheet\b/i.test(el.attrs.rel || '') || !href || /^https:\/\/fonts\.(?:googleapis\.com|bunny\.net)\/css2?\?/i.test(href)) continue;
    if (!dir || remote(href) || (!href.startsWith('/') && remote(baseHref))) { page.unread.push({ what: href }); continue; }
    const from = href.startsWith('/') ? (siteRoot || dir) : baseHref.startsWith('/') ? path.join(siteRoot || dir, baseHref) : path.resolve(dir, baseHref.split(/[?#]/)[0].replace(/[^/]*$/, ''));
    const target = path.join(from, href.replace(/^\/+/, '').split(/[?#]/)[0]);
    try { page.styles.push({ el, text: fs.readFileSync(target, 'utf8').replace(/\n/g, ' '), line: el.line, media: el.attrs.media || null }); } catch { page.unread.push({ what: href, missing: true }); }
  }
  page.unreadSheet = page.unread.length > 0;
}

function checkPage(text, label = 'page.html', options = {}) {
  const page = parsePage(text);
  linkedSheets(page, options.file || (label && label !== '-' ? path.resolve(label) : null), options.siteRoot);
  const off = switchedOff(options.root);
  const findings = [];
  const results = [];
  const ctx = { page, label };
  // a page a script draws: its words and look are only in the script
  const drawnByScript = page.scripts.length && !page.isContentPage && !visibleText(page.root, page).replace(/\s+/g, '');
  for (const rule of PAGE_RULES) {
    if (off.includes(rule.id) || (options.only && options.only !== rule.id)) continue;
    const seen = new Map();
    let count = 0;
    // one finding a line. a must-fix hit on a line that had a note makes it must-fix
    const hit = (line, matched, level = rule.level || 'error') => {
      const had = seen.get(line);
      if (had && (had.level === 'error' || level !== 'error')) return;
      if (had) { had.level = 'error'; delete had.maybe; count++; return; }
      const f = { rule: rule.id, kind: 'screen', level, file: label, line, text: clip(matched), why: rule.why, fix: rule.fix, said: rule.said };
      if (level !== 'error') f.maybe = rule.maybe;
      else count++;
      seen.set(line, f);
      findings.push(f);
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
        for (const f of inner.findings) hit(el.line, f.text, f.level);
      }
    }
    // every rule reads styles (what is hidden, how big, which font). one that passed without seeing every
    // style sheet, or on a page a script draws, did not really pass
    results.push({ id: rule.id, ok: count ? false : page.unreadSheet || drawnByScript ? null : true });
  }
  for (const id of off) results.push({ id, ok: null, off: true });
  findings.sort((a, b) => a.line - b.line);
  // what the check could not see: style sheets it could not read and a page a script draws
  const notChecked = page.unread.map((u) => ({ ...u, line: (page.links.find((el) => (el.attrs.href || '').trim() === u.what) || { line: 1 }).line, said: `${u.what} ${u.missing ? 'is not there' : 'could not be read'}. the page rules did not see it` }));
  if (drawnByScript) notChecked.push({ said: 'a script draws this page. its words and look were not read. run atris site check <file> --render' });
  return { kind: page.isContentPage ? 'content' : 'raw', findings, results, off, notChecked };
}

function ruleSheet() {
  const groups = {};
  // level says whether the rule blocks (error), only leaves notes (warn) or blocks with a part that is a note (mixed)
  for (const r of PAGE_RULES) (groups[r.group] = groups[r.group] || []).push({ id: r.id, line: r.line, why: r.why, said: r.said, level: r.level || (r.maybe ? 'mixed' : 'error'), ...(r.maybe ? { maybe: r.maybe } : {}) });
  return groups;
}

module.exports = { PAGE_RULES, checkPage, ruleSheet, pageMode, renderSeconds, switchedOff, rulesProblem };
