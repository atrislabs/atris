// Page rules for `atris slop detect --kind screen` on html pages. Each rule is data plus a
// check that reads the page structure and the resolved style declarations (lib/page-scan.js),
// so a renamed class or a card drawn with a plain div is still seen.
// Every rule is a yes/no error. A project can switch one off in .atris/slop.rules.json
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
    if (raw && typeof raw === 'object') return { rules: raw };
    return { rules: {}, error: 'it does not hold a json object' };
  } catch (err) { return { rules: {}, error: err.message }; }
}

// The one stderr line for a rules file that cannot be read, or '' when it reads or is missing.
function rulesProblem(root) {
  const { error } = readRules(root);
  return error ? `.atris/slop.rules.json could not be read: ${error.charAt(0).toLowerCase()}${error.slice(1)}` : '';
}

function switchedOff(root) {
  const raw = root ? readRules(root).rules : {};
  return Array.isArray(raw.off) ? raw.off.filter((id) => PAGE_RULES.some((r) => r.id === id)) : [];
}

const pageMode = (root) => readRules(root).rules.pages === 'block' ? 'block' : 'watch';

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
  for (const rule of PAGE_RULES) {
    if (off.includes(rule.id) || (options.only && options.only !== rule.id)) continue;
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
    // a page shown inside an iframe srcdoc is read as part of this page, at the iframe's line
    if (!options.inner) {
      for (const el of page.all) {
        if (el.tag !== 'iframe' || !el.attrs.srcdoc || isHidden(el, page)) continue;
        const inner = checkPage(el.attrs.srcdoc, label, { ...options, inner: true, only: rule.id });
        for (const f of inner.findings) hit(el.line, f.text);
      }
    }
    // a look rule that passed without seeing every style sheet did not really pass
    results.push({ id: rule.id, ok: count ? false : rule.group === 'look' && page.unreadSheet ? null : true });
  }
  for (const id of off) results.push({ id, ok: null, off: true });
  findings.sort((a, b) => a.line - b.line);
  // what the check could not see: style sheets it could not read and a page a script draws
  const notChecked = page.unread.map((u) => ({ ...u, line: (page.links.find((el) => (el.attrs.href || '').trim() === u.what) || { line: 1 }).line, said: `${u.what} ${u.missing ? 'is not there' : 'could not be read'}. the look rules did not see it` }));
  if (page.scripts.length && !page.isContentPage && !visibleText(page.root, page).replace(/\s+/g, '')) notChecked.push({ said: 'a script draws this page. its words and look were not read. run atris site check <file> --render' });
  return { kind: page.isContentPage ? 'content' : 'raw', findings, results, off, notChecked };
}

function ruleSheet() {
  const groups = {};
  for (const r of PAGE_RULES) (groups[r.group] = groups[r.group] || []).push({ id: r.id, line: r.line, why: r.why, said: r.said });
  return groups;
}

module.exports = { PAGE_RULES, checkPage, ruleSheet, pageMode, switchedOff, rulesProblem };
