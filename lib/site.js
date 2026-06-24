// Static site generator — point it at a folder of markdown (docs, your wiki,
// memory) and get a beautiful, navigable HTML site in the design system.
// Builds on lib/deck-from-md (parse) + lib/html-render (render).
//
// buildSite(input, opts) -> { outDir, indexPath, pages }. Pure file I/O.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { parseMarkdownToSpec } = require('./deck-from-md');
const { renderHtml, THEMES } = require('./html-render');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage', '.cache']);
const MD_EXTS = new Set(['.md', '.mdx']);

function collectMd(input) {
  const stat = fs.statSync(input);
  if (stat.isFile()) return MD_EXTS.has(path.extname(input)) ? [input] : [];
  const out = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name.startsWith('.')) continue;
      const full = path.join(dir, name);
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) walk(full); }
      else if (MD_EXTS.has(path.extname(name))) out.push(full);
    }
  })(input);
  return out;
}

function slugFor(file, root) {
  // base = the dir the site was built from (root may be a dir or a single .md file)
  const base = MD_EXTS.has(path.extname(root)) ? path.dirname(root) : root;
  const rel = path.relative(base, file).replace(/\.[^.]+$/, '');
  return rel.replace(/[\\/]+/g, '-').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'page';
}

function firstHeading(md) {
  const m = md.match(/^#{1,2}\s+(.+)$/m);
  return m ? m[1].replace(/\*\*/g, '').trim() : null;
}
function firstParagraph(md) {
  const body = md.replace(/^---\n[\s\S]*?\n---\n/, '');
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t || /^[#<>]/.test(t) || /^[-*+]/.test(t) || /^\|/.test(t) || /^```/.test(t)) continue;
    return t.replace(/\*\*/g, '');
  }
  return '';
}
function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; }
function titleFromSlug(slug) { return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); }

function buildSite(input, opts = {}) {
  const theme = THEMES[opts.theme] ? opts.theme : 'atris';
  const siteTitle = opts.title || 'Atris';
  const accent = opts.accent || '.';
  const outDir = opts.out || 'dist';
  const files = collectMd(input);
  fs.mkdirSync(outDir, { recursive: true });
  const nav = { home: 'index.html', label: siteTitle, accent };

  const pages = [];
  const seen = new Set();
  for (const file of files) {
    const md = fs.readFileSync(file, 'utf8');
    const spec = parseMarkdownToSpec(md, { theme });
    if (!THEMES[spec.theme]) spec.theme = theme;
    let slug = slugFor(file, input);
    while (seen.has(slug)) slug += '-1';
    seen.add(slug);
    const title = firstHeading(md) || titleFromSlug(slug);
    const summary = firstParagraph(md);
    const outFile = path.join(outDir, slug + '.html');
    fs.writeFileSync(outFile, renderHtml(spec, { title, nav }));
    pages.push({ src: file, out: outFile, href: slug + '.html', title, summary });
  }

  const indexSpec = {
    theme, brand: { name: siteTitle, accent },
    slides: [
      { type: 'title', headline: opts.headline || `${siteTitle} **docs**`, sub: opts.sub || `${pages.length} page${pages.length === 1 ? '' : 's'}, one design system.` },
      { type: 'toc', heading: 'Pages', items: pages.map((p) => ({ href: p.href, title: p.title, summary: clip(p.summary, 120) })) },
      { type: 'close', tagline: opts.tagline || 'One workspace, one design system.', footer: siteTitle },
    ],
  };
  const indexPath = path.join(outDir, 'index.html');
  fs.writeFileSync(indexPath, renderHtml(indexSpec, { title: siteTitle }));
  return { outDir, indexPath, pages };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

// minimal static preview server for a built site dir (no deps)
function serveSite(dir, port = 4321) {
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent((req.url || '/').split('?')[0]);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, url: `http://localhost:${port}` })));
}

module.exports = { buildSite, serveSite, collectMd, slugFor, firstHeading, firstParagraph };
