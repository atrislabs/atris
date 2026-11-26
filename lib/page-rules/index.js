// Page rules for `atris slop detect --kind screen` on html pages. Each rule is data plus a
// check that reads the page structure and the resolved style declarations (lib/page-scan.js),
// never class names alone, so a renamed class or a card drawn with a plain div is still seen.
// Every rule is a yes/no error. A project can switch one off in .atris/slop.rules.json
// ({ "off": ["page-glow"] }); a switched-off rule is reported in `off`, never dropped silently.
// The rules live by group: words.js, shape.js and look.js. shared.js reads the page for all of them.

const fs = require('fs');
const path = require('path');
const { parsePage, isHidden } = require('../page-scan');
const { clip, inside } = require('./shared');

const PAGE_RULES = [...require('./words'), ...require('./shape'), ...require('./look')];

// --- running ----------------------------------------------------------------------

function switchedOff(root) {
  if (!root) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, '.atris', 'slop.rules.json'), 'utf8'));
    return Array.isArray(raw && raw.off) ? raw.off.filter((id) => PAGE_RULES.some((r) => r.id === id)) : [];
  } catch { return []; }
}

// Style sheets the page links from its own folder are read as part of the page. Their rules
// report the line of the link, since the finding is about this page.
// A sheet that cannot be read (remote, missing, imported, or built by a style script such as the
// tailwind play cdn) marks the page as styled by rules the check does not see.
function linkedSheets(page, file) {
  let dir;
  try { if (file && fs.statSync(file).isFile()) dir = path.dirname(file); } catch { /* no folder to read from */ }
  page.unreadSheet = page.styles.some((s) => /@import\b/i.test(s.text)) || page.all.some((el) => el.tag === 'script' && /tailwind|unocss|twind/i.test(el.attrs.src || ''));
  for (const el of page.links) {
    const href = el.attrs.href || '';
    if (!/\bstylesheet\b/i.test(el.attrs.rel || '') || !href) continue;
    if (!dir || /^(?:[a-z]+:|\/\/|data:)/i.test(href)) { page.unreadSheet = true; continue; }
    try { page.styles.push({ el, text: fs.readFileSync(path.resolve(dir, href.split(/[?#]/)[0]), 'utf8').replace(/\n/g, ' '), line: el.line }); } catch { page.unreadSheet = true; }
  }
}

function checkPage(text, label = 'page.html', options = {}) {
  const page = parsePage(text);
  linkedSheets(page, options.file || (label && label !== '-' ? path.resolve(label) : null));
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
    results.push({ id: rule.id, ok: count === 0 });
  }
  for (const id of off) results.push({ id, ok: null, off: true });
  findings.sort((a, b) => a.line - b.line);
  return { kind: page.isContentPage ? 'content' : 'raw', findings, results, off };
}

function ruleSheet() {
  const groups = {};
  for (const r of PAGE_RULES) (groups[r.group] = groups[r.group] || []).push({ id: r.id, line: r.line, why: r.why, said: r.said });
  return groups;
}

module.exports = { PAGE_RULES, checkPage, ruleSheet };
