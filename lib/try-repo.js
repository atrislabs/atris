'use strict';

// Try page: someone pastes a public GitHub link and sees their repo's atris map.
// The repo is shallow-cloned into a throwaway folder with no git credentials,
// `atris init --minimal` runs there, a map with file:line refs is built from the
// tree, and the folder is deleted. Nothing is ever pushed or written to GitHub.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { detectProjectContext } = require('../commands/init');

const LIMITS = Object.freeze({ timeoutMs: 60_000, maxBytes: 200 * 1024 * 1024 });
const ATRIS_BIN = path.join(__dirname, '..', 'bin', 'atris.js');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'atris', '.atris', 'vendor', 'dist', 'build', 'target', '__pycache__', '.venv', 'venv', '.next', 'coverage']);
const LANGUAGES = {
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.py': 'Python', '.go': 'Go', '.rs': 'Rust',
  '.rb': 'Ruby', '.java': 'Java', '.kt': 'Kotlin', '.swift': 'Swift', '.c': 'C', '.h': 'C',
  '.cc': 'C++', '.cpp': 'C++', '.hpp': 'C++', '.cs': 'C#', '.php': 'PHP', '.ex': 'Elixir',
  '.exs': 'Elixir', '.scala': 'Scala', '.sh': 'Shell', '.vue': 'Vue', '.svelte': 'Svelte',
};
const SYMBOL_PATTERNS = {
  JavaScript: [/^\s*export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, /^\s*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/, /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/, /^\s*export\s+const\s+([A-Za-z_$][\w$]*)/],
  Python: [/^(?:async\s+)?def\s+([A-Za-z_]\w*)/, /^class\s+([A-Za-z_]\w*)/],
  Go: [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[([]/, /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/],
  Rust: [/^\s*pub(?:\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait)\s+([A-Za-z_]\w*)/, /^fn\s+([A-Za-z_]\w*)/],
  Ruby: [/^\s*(?:class|module)\s+([A-Z]\w*)/, /^\s*def\s+(?:self\.)?([a-z_]\w*[?!]?)/],
  Java: [/^\s*public\s+(?:final\s+|abstract\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/],
  Kotlin: [/^\s*(?:data\s+|sealed\s+|open\s+)?(?:class|object|interface)\s+([A-Za-z_]\w*)/, /^fun\s+([A-Za-z_]\w*)/],
};
SYMBOL_PATTERNS.TypeScript = SYMBOL_PATTERNS.JavaScript;
const ENTRY_NAMES = /^(?:index|main|app|server|cli|lib|mod|__main__|manage)\.[a-z]+$/i;

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Accepts https://github.com/o/r, github.com/o/r, git@github.com:o/r.git, or o/r.
// Anything else is refused before a single network call.
function parseRepoUrl(input) {
  let text = String(input || '').trim();
  if (!text) throw fail('Paste a public GitHub link, like github.com/owner/repo.', 'bad_url');
  text = text.replace(/^git@github\.com:/i, 'github.com/').replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  const parts = text.split(/[?#]/)[0].split('/').filter(Boolean);
  if (parts.length > 2 || /\./.test(parts[0] || '')) {
    if (!/^github\.com$/i.test(parts[0] || '')) throw fail('Only public GitHub links work here.', 'bad_host');
    parts.shift();
  }
  const owner = parts[0] || '';
  const repo = (parts[1] || '').replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo) || /^\.+$/.test(repo)) {
    throw fail('That does not look like a GitHub repo link. Try github.com/owner/repo.', 'bad_url');
  }
  const slug = `${owner}/${repo}`;
  return { owner, repo, slug, webUrl: `https://github.com/${slug}`, cloneUrl: `https://github.com/${slug}.git` };
}

function getJson(url, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'atris-try', Accept: 'application/vnd.github+json' }, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { if (body.length < 1_000_000) body += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(fail('GitHub took too long to answer.', 'timeout')));
    req.on('error', reject);
  });
}

// Asks GitHub without credentials. A private repo answers 404 here, and the
// reported size lets us refuse a huge repo before cloning. A rate-limited or
// unreachable API returns null; the clone itself still has no credentials and
// a live size watch, so the caps hold either way.
async function checkPublicRepo(slug, { fetchJson = getJson, maxBytes = LIMITS.maxBytes } = {}) {
  let res;
  try {
    res = await fetchJson(`https://api.github.com/repos/${slug}`);
  } catch {
    return null;
  }
  if (res.status === 404) throw fail('That repo is private or does not exist. Only public repos work here.', 'not_public');
  if (res.status !== 200 || !res.json) return null;
  if (res.json.private) throw fail('That repo is private. Only public repos work here.', 'not_public');
  const sizeBytes = Number(res.json.size || 0) * 1024;
  if (sizeBytes > maxBytes) throw fail(reasonText('too_big', maxBytes), 'too_big');
  return { sizeBytes, defaultBranch: res.json.default_branch || null, stars: res.json.stargazers_count || 0 };
}

// Built from scratch, never copied from process.env, so no token on the host
// can reach git or atris. Isolated git config means no credential helper runs.
function sandboxEnv(home) {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: home,
    USER: 'visitor',
    LANG: 'C.UTF-8',
    TMPDIR: home,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_ASKPASS: 'false',
    CI: '1',
  };
}

function dirBytes(dir, stopAt = Infinity) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try { total += fs.lstatSync(full).size; } catch {}
        if (total > stopAt) return total;
      }
    }
  }
  return total;
}

// Runs a command and kills its whole process group at the deadline or when the
// watched folder grows past maxBytes.
function runBounded(cmd, args, { cwd, env, deadline, watchDir, maxBytes }) {
  return new Promise((resolve) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return resolve({ code: null, reason: 'timeout', stderr: '' });
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stderr = '';
    let reason = null;
    child.stdout.on('data', () => {});
    child.stderr.on('data', (chunk) => { if (stderr.length < 4000) stderr += chunk; });
    const kill = (why) => {
      if (reason) return;
      reason = why;
      try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch {}
    };
    const timer = setTimeout(() => kill('timeout'), remaining);
    const watch = watchDir && maxBytes ? setInterval(() => {
      if (dirBytes(watchDir, maxBytes) > maxBytes) kill('too_big');
    }, 250) : null;
    child.on('error', (error) => { stderr += String(error.message || error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (watch) clearInterval(watch);
      resolve({ code, reason, stderr });
    });
  });
}

function walkRepo(root, { maxFiles = 20_000 } = {}) {
  const files = [];
  const stack = [''];
  while (stack.length && files.length < maxFiles) {
    const rel = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) stack.push(childRel);
      } else if (entry.isFile()) {
        let size = 0;
        try { size = fs.lstatSync(path.join(root, childRel)).size; } catch {}
        files.push({ rel: childRel, size });
        if (files.length >= maxFiles) break;
      }
    }
  }
  return files;
}

function findSymbols(root, rel, language, limit) {
  const patterns = SYMBOL_PATTERNS[language];
  if (!patterns) return [];
  let text;
  try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return []; }
  const symbols = [];
  const seen = new Set();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && symbols.length < limit; i++) {
    for (const pattern of patterns) {
      const match = lines[i].match(pattern);
      if (match && !seen.has(match[1])) {
        seen.add(match[1]);
        symbols.push({ file: rel, line: i + 1, name: match[1] });
        break;
      }
    }
  }
  return symbols;
}

// Examples, docs, and fixtures are real files but not where the program lives,
// so they never count as a place to start reading.
function isSidePath(rel) {
  return rel.split('/').slice(0, -1).some((part) => /^(examples?|samples?|docs?|demos?|benchmarks?|bench|fixtures?|testdata)$/i.test(part));
}

function isTestPath(rel) {
  return /(^|\/)(tests?|__tests__|spec)(\/|\.[a-z]+$|$)|[._-](test|spec)\.[a-z]+$|_test\.go$|^test_.*\.py$|\/test_[^/]*\.py$/i.test(rel);
}

// The map itself: what the repo is made of, where to start reading, and the
// first named things in the files that matter most, each with a file:line ref.
function buildRepoMap(root, { maxSymbolFiles = 12, symbolsPerFile = 5 } = {}) {
  const files = walkRepo(root);
  const profile = detectProjectContext(root);
  const byLanguage = new Map();
  const byDir = new Map();
  const codeByDir = new Map();
  let bytes = 0;
  let testFiles = 0;
  for (const file of files) {
    bytes += file.size;
    const language = LANGUAGES[path.extname(file.rel).toLowerCase()];
    if (language) byLanguage.set(language, (byLanguage.get(language) || 0) + 1);
    const top = file.rel.includes('/') ? `${file.rel.split('/')[0]}/` : '(top level)';
    byDir.set(top, (byDir.get(top) || 0) + 1);
    if (isTestPath(file.rel)) testFiles++;
    else if (language && !isSidePath(file.rel) && top !== '(top level)') codeByDir.set(top, (codeByDir.get(top) || 0) + 1);
  }
  const languages = [...byLanguage.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, files: count }));
  const topDirs = [...byDir.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, count]) => ({ name, files: count }));
  const codeDirs = [...codeByDir.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, files: count }));
  const codeFiles = files.filter((file) => LANGUAGES[path.extname(file.rel).toLowerCase()] && file.size < 512 * 1024 && !isTestPath(file.rel) && !isSidePath(file.rel));
  const depth = (rel) => rel.split('/').length;
  const entryPoints = codeFiles
    .filter((file) => ENTRY_NAMES.test(path.basename(file.rel)) && depth(file.rel) <= 3)
    .sort((a, b) => depth(a.rel) - depth(b.rel) || a.rel.localeCompare(b.rel))
    .slice(0, 6)
    .map((file) => file.rel);
  const ranked = [
    ...entryPoints,
    ...codeFiles
      .filter((file) => !entryPoints.includes(file.rel))
      .sort((a, b) => depth(a.rel) - depth(b.rel) || b.size - a.size)
      .map((file) => file.rel),
  ];
  const symbols = [];
  for (const rel of ranked) {
    if (symbols.length >= maxSymbolFiles * symbolsPerFile) break;
    const found = findSymbols(root, rel, LANGUAGES[path.extname(rel).toLowerCase()], symbolsPerFile);
    if (found.length) symbols.push(...found);
    if (new Set(symbols.map((s) => s.file)).size >= maxSymbolFiles) break;
  }
  const readme = files.find((file) => /^readme(\.|$)/i.test(file.rel));
  return {
    files: files.length,
    bytes,
    testFiles,
    type: profile.type,
    framework: profile.framework,
    testCommand: profile.testCommand,
    languages,
    topDirs,
    codeDirs,
    entryPoints,
    readme: readme ? readme.rel : null,
    symbols,
  };
}

// Three moves atris would make first, picked from what the map shows.
function nextMoves(map) {
  const moves = [];
  const biggest = (map.codeDirs || [])[0];
  moves.push(biggest
    ? `Fill in the map for ${biggest.name}, the biggest code folder with ${biggest.files} files, so any agent finds code there in one hop.`
    : 'Fill in the map with line refs for every file, so any agent finds code in one hop.');
  moves.push(map.testFiles
    ? `Run your ${map.testFiles} test files before every change and block the change if they fail.`
    : 'Add a first test so every change has a check that can fail.');
  moves.push(map.entryPoints.length
    ? `Start the task list from ${map.entryPoints[0]}, where the program begins.`
    : 'Start a task list from the readme, one small change at a time.');
  return moves;
}

function renderMapMarkdown(map, repo) {
  const lines = [`# MAP.md`, '', `> Built by the atris try page from ${repo.webUrl}.`, ''];
  lines.push(`## What this is`, '', `- ${map.files} files, ${map.languages.map((l) => `${l.name} (${l.files})`).join(', ') || 'no code files found'}`);
  if (map.type !== 'unknown') lines.push(`- project type: ${map.type}${map.framework && !['none', map.type].includes(map.framework) ? ` (${map.framework})` : ''}`);
  lines.push(`- test files: ${map.testFiles}`, '');
  if (map.entryPoints.length) lines.push('## Start here', '', ...map.entryPoints.map((rel) => `- \`${rel}:1\``), '');
  lines.push('## Folders', '', ...map.topDirs.map((dir) => `- \`${dir.name}\` ${dir.files} files`), '');
  if (map.symbols.length) {
    lines.push('## Where things live', '');
    for (const symbol of map.symbols) lines.push(`- \`${symbol.file}:${symbol.line}\` \`${symbol.name}\``);
    lines.push('');
  }
  return lines.join('\n');
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

const PAGE_STYLE = 'body{font:16px/1.5 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#111}code,pre{font:14px ui-monospace,monospace}pre{background:#f5f5f4;padding:16px;overflow:auto;border-radius:6px}input{font:inherit;padding:8px;width:70%}button{font:inherit;padding:8px 14px}.err{color:#a1260d}';

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head><body>${body}</body></html>`;
}

function renderFormHtml({ error = '', value = '' } = {}) {
  return page('see your repo through atris', `<h1>see your repo through atris</h1>
<p>paste a public github link. in about a minute you get the map atris would build for your code.</p>
<form action="/try" method="get"><input name="repo" placeholder="github.com/owner/repo" value="${escapeHtml(value)}" required> <button>map it</button></form>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}`);
}

function renderResultHtml(result) {
  if (!result.ok) return renderFormHtml({ error: result.error, value: result.input || '' });
  const { map, repo } = result;
  const found = `${map.files} files, mostly ${map.languages.slice(0, 3).map((l) => l.name).join(', ') || 'docs and config'}, with ${map.testFiles} test files.`;
  return page(`${repo.slug} through atris`, `<h1>${escapeHtml(repo.slug)}</h1>
<h2>what atris found in your code</h2>
<p>${escapeHtml(found)}</p>
<pre>${escapeHtml(result.markdown)}</pre>
<h2>three moves atris would make next</h2>
<ol>${result.moves.map((move) => `<li>${escapeHtml(move)}</li>`).join('')}</ol>
<p>run it on your machine:</p>
<pre>npm i -g atris</pre>
<p><small>mapped in ${(result.ms / 1000).toFixed(1)}s. the copy was deleted after mapping. nothing was written to github.</small></p>`);
}

function reasonText(reason, maxBytes) {
  if (reason === 'too_big') return `That repo is over ${Math.max(1, Math.round(maxBytes / 1048576))} MB. The try page maps smaller repos.`;
  return 'That repo took longer than a minute to map. Try a smaller one.';
}

async function tryRepo(input, opts = {}) {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs || LIMITS.timeoutMs;
  const maxBytes = opts.maxBytes || LIMITS.maxBytes;
  const deadline = started + timeoutMs;
  let sandbox = null;
  try {
    const repo = parseRepoUrl(input);
    await checkPublicRepo(repo.slug, { fetchJson: opts.fetchJson, maxBytes });
    sandbox = fs.mkdtempSync(path.join(opts.tmpRoot || os.tmpdir(), 'atris-try-'));
    const home = path.join(sandbox, 'home');
    const dir = path.join(sandbox, 'repo');
    fs.mkdirSync(home);
    const env = sandboxEnv(home);
    const clone = await runBounded('git', ['clone', '--quiet', '--depth', '1', '--single-branch', '--no-tags', '--', opts.cloneUrl || repo.cloneUrl, dir], { cwd: sandbox, env, deadline, watchDir: sandbox, maxBytes });
    if (clone.reason) throw fail(reasonText(clone.reason, maxBytes), clone.reason);
    if (clone.code !== 0) throw fail('Could not copy that repo. It may be private, empty, or gone.', 'clone_failed');
    if (dirBytes(dir, maxBytes) > maxBytes) throw fail(reasonText('too_big', maxBytes), 'too_big');
    const init = await runBounded(process.execPath, [ATRIS_BIN, 'init', '--minimal', '--yes', '--no-commit'], { cwd: dir, env, deadline });
    if (init.reason) throw fail(reasonText(init.reason, maxBytes), init.reason);
    if (init.code !== 0) throw fail('atris could not set up in that repo.', 'init_failed');
    const map = buildRepoMap(dir);
    const markdown = renderMapMarkdown(map, repo);
    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), markdown);
    const result = { ok: true, input, repo, map, markdown, moves: nextMoves(map), ms: Date.now() - started };
    result.html = renderResultHtml(result);
    return result;
  } catch (error) {
    const result = { ok: false, input, code: error.code || 'error', error: error.code ? error.message : 'Something went wrong mapping that repo.', ms: Date.now() - started };
    result.html = renderResultHtml(result);
    return result;
  } finally {
    if (sandbox && !opts.keep) fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

// Small public server. Each visitor gets one map at a time and a few per window,
// and the whole box runs a bounded number of maps at once.
function createTryServer({ run = tryRepo, perWindow = 5, windowMs = 10 * 60_000, maxConcurrent = 2, trustProxy = false } = {}) {
  const visits = new Map();
  const busy = new Set();
  let running = 0;
  const send = (res, status, html) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  };
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET') return send(res, 405, renderFormHtml({ error: 'Use the form.' }));
    if (url.pathname === '/') return send(res, 200, renderFormHtml());
    if (url.pathname !== '/try') return send(res, 404, renderFormHtml({ error: 'Nothing here.' }));
    const forwarded = trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
    const ip = forwarded || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const recent = (visits.get(ip) || []).filter((t) => now - t < windowMs);
    if (busy.has(ip) || recent.length >= perWindow) {
      return send(res, 429, renderFormHtml({ error: 'You have mapped a few repos already. Try again in a few minutes.' }));
    }
    if (running >= maxConcurrent) return send(res, 503, renderFormHtml({ error: 'The page is busy right now. Try again in a minute.' }));
    recent.push(now);
    visits.set(ip, recent);
    busy.add(ip);
    running++;
    try {
      const result = await run(url.searchParams.get('repo') || '');
      send(res, result.ok ? 200 : 400, result.html);
    } finally {
      busy.delete(ip);
      running--;
    }
  });
}

// Host the page: `PORT=8080 TRY_TRUST_PROXY=1 node lib/try-repo.js`.
// Trust the proxy header only behind a proxy you run, or visitors can fake it.
function startTryServer(env = process.env) {
  const port = Number(env.PORT) || 8787;
  const host = env.HOST || '0.0.0.0';
  const server = createTryServer({ trustProxy: env.TRY_TRUST_PROXY === '1' });
  server.listen(port, host, () => console.log(`try page listening on http://${host}:${server.address().port}`));
  return server;
}

if (require.main === module) startTryServer();

module.exports = {
  parseRepoUrl,
  checkPublicRepo,
  sandboxEnv,
  buildRepoMap,
  renderMapMarkdown,
  renderResultHtml,
  nextMoves,
  tryRepo,
  createTryServer,
};
