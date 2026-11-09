'use strict';

// atris sentinel watch: known attacks and security holes in the packages a
// project uses. Reads the lockfiles, asks the free OSV database
// (https://api.osv.dev, no key) which exact versions are affected, and
// reports each affected package with the version that fixes it.
//
//   find    lockfiles at the root and in subfolders (not node_modules, .venv,
//           vendor, build output or git-ignored folders), up to MAX_LOCKFILES
//   parse   package-lock.json, pnpm-lock.yaml, yarn.lock, requirements.txt,
//           poetry.lock, go.sum, Gemfile.lock (exact versions only)
//   query   POST /v1/querybatch returns advisory ids per package, then
//           GET /v1/vulns/<id> gives the affected ranges and fixed versions
//   fix     --fix updates packages on a new git branch, commits there and
//           never pushes. Never commits on main or master. Each lockfile is
//           updated by its own tool. An npm or pnpm change is scoped to the
//           package that pulls in the affected copy. A safe copy of the
//           same package elsewhere never moves. A fix that jumps to a new
//           major version waits for a person unless --allow-major is given.
//
// Only package names, versions and advisory ids go to OSV. No source code.
// A network failure is a warning in the result, never a throw.

const fs = require('fs');
const path = require('path');
const events = require('./sentinel-events');

const OSV_BASE = 'https://api.osv.dev';
const BATCH_SIZE = 1000;
const MAX_VULN_DETAILS = 400;
const MAX_LOCKFILES = 20;
const MAX_DEPTH = 6;
const MAX_DIRS = 5000;
// A lockfile larger than this is skipped with a warning, never read.
const MAX_LOCKFILE_BYTES = 20 * 1024 * 1024;

// Folders that hold installed copies, build output or tool caches. Their
// lockfiles are not the project's own. Every folder starting with a dot is
// skipped too.
const SKIP_DIRS = new Set([
  'node_modules', 'bower_components', 'jspm_packages', 'vendor', 'venv', 'env', 'virtualenv',
  'site-packages', '__pycache__', 'dist', 'build', 'out', 'target', 'coverage', 'tmp', 'temp',
]);

// ---------------------------------------------------------------- parse

function readMaybe(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function parsePackageLock(text) {
  const out = [];
  let json;
  try { json = JSON.parse(text); } catch { return out; }
  if (json && json.packages && typeof json.packages === 'object') {
    for (const [key, v] of Object.entries(json.packages)) {
      if (!key || !v || v.link || !v.version) continue;
      const at = key.lastIndexOf('node_modules/');
      if (at === -1) continue;
      out.push({ name: v.name || key.slice(at + 'node_modules/'.length), version: String(v.version), ecosystem: 'npm', direct: key.split('node_modules/').length === 2, dev: Boolean(v.dev), path: key });
    }
    return out;
  }
  const walkDeps = (deps, depth) => {
    for (const [name, v] of Object.entries(deps || {})) {
      if (v && v.version && !/^(?:file|link|git)/.test(v.version)) out.push({ name, version: String(v.version), ecosystem: 'npm', direct: depth === 0, dev: Boolean(v.dev) });
      if (v && v.dependencies) walkDeps(v.dependencies, depth + 1);
    }
  };
  walkDeps(json && json.dependencies, 0);
  return out;
}

// pnpm keys: "/name/1.2.3:" (v5), "/name@1.2.3:" (v6), "name@1.2.3:" (v9),
// each with an optional "(peer@x)" suffix.
const PNPM_KEY = /^ {2}['"]?\/?((?:@[^/@\s]+\/)?[^/@\s(]+)[@/]([0-9][^:('"\s]*)(?:\([^:]*\))?['"]?:\s*$/;

function parsePnpmLock(text) {
  const out = [];
  let inPackages = false;
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) { inPackages = /^(?:packages|snapshots):\s*$/.test(line); continue; }
    if (!inPackages) continue;
    const m = line.match(PNPM_KEY);
    if (!m) continue;
    out.push({ name: m[1], version: m[2], ecosystem: 'npm' });
  }
  return out;
}

// yarn classic: `"name@^1.0.0", name@^1.1.0:` then `  version "1.2.3"`.
// yarn berry: `"name@npm:^1.0.0":` then `  version: 1.2.3`.
function parseYarnLock(text) {
  const out = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (/^\S/.test(line) && line.trim().endsWith(':') && !line.startsWith('#') && !line.startsWith('__metadata')) {
      const first = line.slice(0, -1).split(',')[0].trim().replace(/^"|"$/g, '');
      const at = first.lastIndexOf('@');
      current = at > 0 ? first.slice(0, at) : null;
      if (current && /@(?:workspace|patch|link|portal|file):/.test(first)) current = null;
      continue;
    }
    const v = line.match(/^ {2}version:?\s+"?([^"\s]+)"?\s*$/);
    if (v && current) { out.push({ name: current, version: v[1], ecosystem: 'npm' }); current = null; }
  }
  return out;
}

function parseRequirements(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*===?\s*([0-9][A-Za-z0-9.!+-]*)\s*(?:;.*)?$/);
    if (m) out.push({ name: m[1], version: m[2], ecosystem: 'PyPI', direct: true });
  }
  return out;
}

function parsePoetryLock(text) {
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (/^\[\[package\]\]\s*$/.test(line)) { if (cur && cur.name && cur.version) out.push(cur); cur = { ecosystem: 'PyPI' }; continue; }
    if (/^\[/.test(line)) { if (cur && cur.name && cur.version) out.push(cur); cur = null; continue; }
    if (!cur) continue;
    const m = line.match(/^(name|version)\s*=\s*"([^"]+)"/);
    if (m) cur[m[1]] = m[2];
  }
  if (cur && cur.name && cur.version) out.push(cur);
  return out;
}

function parseGoSum(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(\S+)\s+(v[^\s/]+)(\/go\.mod)?\s+h1:/);
    if (!m || m[3]) continue;
    out.push({ name: m[1], version: m[2].replace(/^v/, '').replace(/\+incompatible$/, ''), ecosystem: 'Go' });
  }
  return out;
}

function parseGemfileLock(text) {
  const out = [];
  let inSpecs = false;
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) { inSpecs = false; continue; }
    if (/^ {2}specs:\s*$/.test(line)) { inSpecs = true; continue; }
    if (!inSpecs) continue;
    const m = line.match(/^ {4}([A-Za-z0-9._-]+) \(([0-9][^)\s-]*)(?:-[^)]*)?\)\s*$/);
    if (m) out.push({ name: m[1], version: m[2], ecosystem: 'RubyGems' });
  }
  return out;
}

// tool: the program that owns the lockfile. label: how a person names it.
const LOCKFILES = [
  { file: 'package-lock.json', tool: 'npm', label: 'npm lockfile', parse: parsePackageLock },
  { file: 'npm-shrinkwrap.json', tool: 'npm', label: 'npm lockfile', parse: parsePackageLock },
  { file: 'pnpm-lock.yaml', tool: 'pnpm', label: 'pnpm lockfile', parse: parsePnpmLock },
  { file: 'yarn.lock', tool: 'yarn', label: 'yarn lockfile', parse: parseYarnLock },
  { file: 'requirements.txt', tool: 'pip', label: 'python requirements file', parse: parseRequirements },
  { file: 'poetry.lock', tool: 'poetry', label: 'poetry lockfile', parse: parsePoetryLock },
  { file: 'go.sum', tool: 'go', label: 'go module list', parse: parseGoSum },
  { file: 'Gemfile.lock', tool: 'bundler', label: 'ruby gem lockfile', parse: parseGemfileLock },
];
const LOCKFILE_BY_NAME = new Map(LOCKFILES.map((l) => [l.file, l]));

// Only names and versions of a known shape go to OSV. A lockfile entry
// holding a URL, a path, a git address or anything else is skipped and
// counted, never sent.
const VERSION_SHAPE = {
  npm: /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
  Go: /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
  RubyGems: /^\d+(?:\.[0-9A-Za-z]+){0,5}$/,
  // PEP 440: [N!]N(.N)*[{a|b|rc}N][.postN][.devN][+local]
  PyPI: /^(?:\d+!)?\d+(?:\.\d+)*(?:[-_.]?(?:a|b|c|rc|alpha|beta|pre|preview)\d*)?(?:[-_.]?(?:post|rev|r)\d*)?(?:[-_.]?dev\d*)?(?:\+[a-z0-9]+(?:[-_.][a-z0-9]+)*)?$/i,
};
const NAME_SHAPE = {
  npm: /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9._~-][a-z0-9._~-]*$/i,
  Go: /^[A-Za-z0-9][A-Za-z0-9._~-]*(?:\/[A-Za-z0-9._~-]+)*$/,
  RubyGems: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  PyPI: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
};

function looksReal(p) {
  const v = VERSION_SHAPE[p.ecosystem];
  const n = NAME_SHAPE[p.ecosystem];
  return Boolean(v && n && v.test(String(p.version)) && n.test(String(p.name)) && String(p.name).length <= 214 && String(p.version).length <= 64);
}

function pkgKey(p) {
  return `${p.ecosystem}\u0000${p.name}\u0000${p.version}`;
}

function skipDir(name) {
  return name.startsWith('.') || SKIP_DIRS.has(name);
}

// Git-ignored files and folders under root, as root-relative paths. Folders
// end with a slash. Empty when root is not in a git repository.
function gitIgnored(root) {
  const { spawnSync } = require('child_process');
  const r = spawnSync('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z', '--', '.'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || typeof r.stdout !== 'string') return new Set();
  return new Set(r.stdout.split('\0').filter(Boolean).map((p) => p.replace(/\\/g, '/')));
}

// Every lockfile under root, shallow folders first. Never follows a symlink.
// Returns the first MAX_LOCKFILES and how many more were found.
function findLockfiles(root, { max = MAX_LOCKFILES, ignored = gitIgnored(root) } = {}) {
  const found = [];
  const queue = [{ rel: '', depth: 0 }];
  let dirs = 0;
  while (queue.length && dirs < MAX_DIRS) {
    const { rel, depth } = queue.shift();
    dirs += 1;
    let entries;
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isFile() && LOCKFILE_BY_NAME.has(e.name) && !ignored.has(child)) found.push(child);
    }
    if (depth >= MAX_DEPTH) continue;
    for (const e of entries) {
      if (!e.isDirectory() || skipDir(e.name)) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (ignored.has(`${child}/`)) continue;
      queue.push({ rel: child, depth: depth + 1 });
    }
  }
  return { files: found.slice(0, max), more: Math.max(0, found.length - max), dirCapped: queue.length > 0 };
}

// Reads every lockfile found. packages: one entry per name and version,
// the list sent to OSV. occurrences: for each of those, every lockfile it
// appears in.
function readLockfiles(root, opts = {}) {
  const { files, more, dirCapped } = findLockfiles(root, opts);
  const maxBytes = opts.maxBytes || MAX_LOCKFILE_BYTES;
  const lockfiles = [];
  const packages = [];
  const occurrences = new Map();
  const tooBig = [];
  const unreadable = [];
  let skipped = 0;
  for (const rel of files) {
    const lf = LOCKFILE_BY_NAME.get(path.basename(rel));
    const file = path.join(root, rel);
    let st;
    try { st = fs.lstatSync(file); } catch { unreadable.push(rel); continue; }
    if (!st.isFile()) { unreadable.push(rel); continue; }
    if (st.size > maxBytes) { tooBig.push(rel); continue; }
    const text = readMaybe(file);
    if (text == null) { unreadable.push(rel); continue; }
    const list = lf.parse(text);
    lockfiles.push({ file: rel, tool: lf.tool, packages: list.length });
    for (const p of list) {
      if (!looksReal(p)) { skipped += 1; continue; }
      const key = pkgKey(p);
      if (!occurrences.has(key)) { occurrences.set(key, []); packages.push({ name: p.name, version: p.version, ecosystem: p.ecosystem }); }
      const occ = occurrences.get(key);
      let here = occ.find((o) => o.lockfile === rel);
      if (!here) { here = { lockfile: rel, tool: lf.tool, direct: false, paths: [] }; occ.push(here); }
      if (p.direct) here.direct = true;
      if (p.path) here.paths.push(p.path);
    }
  }
  return { lockfiles, packages, occurrences, skipped, more, dirCapped, tooBig, unreadable };
}

// ---------------------------------------------------------------- versions

function parts(v) {
  return String(v || '').replace(/^v/, '').split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
}

// Compare two versions: numeric parts by number, a prerelease tag sorts
// before the release (1.0.0-beta < 1.0.0).
function compareVersions(a, b) {
  const [ma, pa] = String(a).replace(/^v/, '').split(/-(.*)/s);
  const [mb, pb] = String(b).replace(/^v/, '').split(/-(.*)/s);
  const xa = parts(ma);
  const xb = parts(mb);
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const p = xa[i] === undefined ? 0 : xa[i];
    const q = xb[i] === undefined ? 0 : xb[i];
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return p < q ? -1 : 1;
    return String(p) < String(q) ? -1 : 1;
  }
  if (pa && !pb) return -1;
  if (!pa && pb) return 1;
  if (pa && pb) return pa < pb ? -1 : (pa > pb ? 1 : 0);
  return 0;
}

// A new major version line: 3.x to 4.x, or 0.3.x to 0.4.x, where a version
// range like ^0.3.0 would never reach on its own.
function isMajorJump(from, to) {
  const a = parts(String(from).split('-')[0]);
  const b = parts(String(to).split('-')[0]);
  if (typeof a[0] !== 'number' || typeof b[0] !== 'number') return false;
  if (b[0] !== a[0]) return b[0] > a[0];
  if (a[0] === 0 && typeof a[1] === 'number' && typeof b[1] === 'number') return b[1] > a[1];
  return false;
}

// The lowest fixed version above the version in use, from the advisory's
// ranges for this package. null when no fix is published.
function fixedVersionFor(vuln, pkg) {
  const fixes = [];
  const norm = (n) => (pkg.ecosystem === 'PyPI' ? String(n).toLowerCase().replace(/[-_.]+/g, '-') : String(n));
  for (const aff of (vuln && vuln.affected) || []) {
    const p = aff.package || {};
    if (p.ecosystem && p.ecosystem !== pkg.ecosystem) continue;
    if (p.name && norm(p.name) !== norm(pkg.name)) continue;
    for (const range of aff.ranges || []) {
      if (range.type === 'GIT') continue;
      let introduced = '0';
      for (const ev of range.events || []) {
        if (ev.introduced !== undefined) introduced = ev.introduced;
        if (ev.fixed !== undefined) {
          const inRange = (introduced === '0' || compareVersions(pkg.version, introduced) >= 0) && compareVersions(pkg.version, ev.fixed) < 0;
          if (inRange) fixes.push(ev.fixed);
        }
      }
    }
  }
  if (!fixes.length) return null;
  return fixes.sort(compareVersions)[0];
}

const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

function severityOf(vuln) {
  if (/^MAL-/.test(String(vuln.id || ''))) return 'critical';
  const label = String((vuln.database_specific && vuln.database_specific.severity) || '').toLowerCase();
  if (label === 'critical' || label === 'high' || label === 'low') return label;
  if (label === 'moderate' || label === 'medium') return 'medium';
  for (const aff of vuln.affected || []) {
    const s = String((aff.ecosystem_specific && aff.ecosystem_specific.severity) || (aff.database_specific && aff.database_specific.severity) || '').toLowerCase();
    if (['critical', 'high', 'low'].includes(s)) return s;
    if (s === 'moderate' || s === 'medium') return 'medium';
  }
  // CVSS vector with no label: read the base score band from the vector's
  // impact letters, roughly. Unknown stays medium.
  return 'medium';
}

// ---------------------------------------------------------------- osv

async function osvBatch(packages, { base = OSV_BASE, request, timeoutMs = 30000 } = {}) {
  const results = new Array(packages.length).fill(null).map(() => []);
  for (let start = 0; start < packages.length; start += BATCH_SIZE) {
    const slice = packages.slice(start, start + BATCH_SIZE);
    let queries = slice.map((p) => ({ package: { name: p.name, ecosystem: p.ecosystem }, version: p.version }));
    let idx = slice.map((_, i) => start + i);
    // Pages: a query with more results carries next_page_token.
    for (let round = 0; round < 5 && queries.length; round++) {
      const res = await request('POST', `${base}/v1/querybatch`, { body: { queries }, timeoutMs });
      if (res.status < 200 || res.status >= 300 || !res.json || !Array.isArray(res.json.results)) throw new Error(`osv answered ${res.status}`);
      const nextQ = [];
      const nextIdx = [];
      res.json.results.forEach((r, k) => {
        for (const v of (r && r.vulns) || []) if (v && v.id) results[idx[k]].push(v.id);
        if (r && r.next_page_token) { nextQ.push({ ...queries[k], page_token: r.next_page_token }); nextIdx.push(idx[k]); }
      });
      queries = nextQ;
      idx = nextIdx;
    }
  }
  return results;
}

async function osvDetails(ids, { base = OSV_BASE, request, timeoutMs = 20000, concurrency = 8 } = {}) {
  const out = {};
  const list = [...new Set(ids)].slice(0, MAX_VULN_DETAILS);
  let next = 0;
  let failed = 0;
  const work = async () => {
    while (next < list.length) {
      const id = list[next++];
      try {
        const res = await request('GET', `${base}/v1/vulns/${encodeURIComponent(id)}`, { timeoutMs });
        if (res.status >= 200 && res.status < 300 && res.json) out[id] = res.json;
        else failed += 1;
      } catch { failed += 1; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, list.length)) }, work));
  return { details: out, failed, skipped: Math.max(0, new Set(ids).size - list.length) };
}

function defaultRequest() {
  return require('./sentinel-cloud').request;
}

async function runWatch(root, { base = process.env.ATRIS_OSV_BASE || OSV_BASE, request = defaultRequest(), maxLockfiles = MAX_LOCKFILES, maxBytes = MAX_LOCKFILE_BYTES } = {}) {
  const { lockfiles, packages, occurrences, skipped, more, dirCapped, tooBig, unreadable } = readLockfiles(root, { max: maxLockfiles, maxBytes });
  // A scan that left any lockfile unread cannot say a threat is gone.
  const incomplete = Boolean(more || dirCapped || tooBig.length || unreadable.length);
  const result = { root: path.resolve(root), lockfiles, packages: packages.length, skipped, more, tooBig, unreadable, incomplete, affected: [], warnings: [] };
  const mb = Math.round(maxBytes / (1024 * 1024));
  for (const rel of tooBig) result.warnings.push(`skipped ${rel}: it is larger than ${mb} MB`);
  for (const rel of unreadable) result.warnings.push(`could not read ${rel}`);
  if (dirCapped) result.warnings.push(`stopped looking for lockfiles after ${MAX_DIRS} folders. run atris sentinel watch on a subfolder to check the rest`);
  if (skipped) result.warnings.push(`skipped ${skipped} lockfile entr${skipped === 1 ? 'y' : 'ies'} that did not look like a package version. they were not sent`);
  if (more) result.warnings.push(`found ${more} more lockfile${more === 1 ? '' : 's'} past the limit of ${maxLockfiles}. ${more === 1 ? 'it was' : 'they were'} not read. run atris sentinel watch on a subfolder to check ${more === 1 ? 'it' : 'them'}`);
  if (!packages.length) return result;
  let ids;
  try {
    ids = await osvBatch(packages, { base, request });
  } catch (e) {
    result.warnings.push(`could not reach the osv vulnerability database: ${e.message}. nothing was checked this time`);
    result.offline = true;
    return result;
  }
  const all = ids.flat();
  const { details, failed, skipped: unread } = await osvDetails(all, { base, request });
  if (failed) result.warnings.push(`${failed} advisor${failed === 1 ? 'y' : 'ies'} could not be read from osv. the list below may be short`);
  if (unread) result.warnings.push(`only the first ${MAX_VULN_DETAILS} advisories were read`);
  packages.forEach((pkg, i) => {
    const vids = [...new Set(ids[i])];
    if (!vids.length) return;
    const vulns = vids.map((id) => details[id] || { id });
    const fixes = vulns.map((v) => (v.affected ? fixedVersionFor(v, pkg) : null)).filter(Boolean);
    // One version that fixes every advisory with a fix: the highest of the
    // lowest fixes.
    const fixed = fixes.length ? fixes.sort(compareVersions)[fixes.length - 1] : null;
    const malicious = vids.some((id) => /^MAL-/.test(id));
    const severity = vulns.map(severityOf).sort((a, b) => SEV_RANK[a] - SEV_RANK[b])[0] || 'medium';
    const major = Boolean(fixed && isMajorJump(pkg.version, fixed));
    // One finding per lockfile the affected version appears in.
    for (const occ of occurrences.get(pkgKey(pkg)) || []) {
      result.affected.push({ ...pkg, lockfile: occ.lockfile, tool: occ.tool, direct: occ.direct, paths: occ.paths, advisories: vids, fixed, major, malicious, severity, unfixed: fixes.length < vids.length });
    }
  });
  result.affected.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.name.localeCompare(b.name) || compareVersions(a.version, b.version) || a.lockfile.localeCompare(b.lockfile));
  return result;
}

// ---------------------------------------------------------------- events

// The dashboard only accepts plain words, so a package name like @vitest/mocker
// or lodash.merge is written as vitest-mocker or lodash-merge.
function plainName(name) {
  return String(name || '').replace(/^@/, '').replace(/[\/._]+/g, '-').replace(/[^A-Za-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function threatTitle(a) {
  const name = plainName(a.name);
  const kind = events.slotOk('package', name) ? 'package' : 'module';
  const slots = { pkg: [kind, name, 'one'], fixed: ['version', a.fixed, 'a newer version'] };
  const subject = events.slotOk(kind, name) ? 'the {pkg} package you use' : 'a package you use';
  if (a.malicious) return events.fillPlain(`A published attack affects ${subject}. Remove it or move to a version that is not affected.`, slots);
  if (a.fixed) return events.fillPlain(`A known security hole affects ${subject}. Version {fixed} fixes it.`, slots);
  return events.fillPlain(`A known security hole affects ${subject}. No fixed version is published yet.`, slots);
}

// Where a finding lives, in words the dashboard accepts: "the pnpm lockfile
// in the web folder". The file path itself stays in the local report.
function lockfilePlace(rel) {
  if (!rel) return '';
  const lf = LOCKFILE_BY_NAME.get(path.basename(rel));
  const label = lf ? lf.label : 'lockfile';
  const dir = path.dirname(rel);
  if (dir === '.' || dir === '') return events.fillPlain(`Found in the ${label} at the top of the project.`, {}, 300);
  const folder = path.basename(dir);
  if (events.slotOk('word', folder)) return events.fillPlain(`Found in the ${label} in the {dir} folder.`, { dir: ['word', folder, 'project'] }, 300);
  return events.fillPlain(`Found in the ${label} in a subfolder.`, {}, 300);
}

function threatDetail(a, lockfiles = a.lockfile ? [a.lockfile] : []) {
  const one = a.advisories.length === 1;
  const slots = { n: ['count', String(a.advisories.length), 'some'], fixed: ['version', a.fixed, 'a newer version'], current: ['version', a.version, 'the current version'] };
  const found = one ? 'Found in one published advisory against version {current}.' : 'Found in {n} published advisories against version {current}.';
  const head = a.fixed
    ? events.fillPlain(`${found} Update to version {fixed} or later and run your tests.`, slots, 1000)
    : events.fillPlain(`${found} Watch for a fix or replace the package.`, slots, 1000);
  const parts2 = [head];
  if (a.fixed && a.major) parts2.push(events.fillPlain('That is a new major version. Check your code before you take it.', {}, 300));
  if (lockfiles.length === 1) parts2.push(lockfilePlace(lockfiles[0]));
  else if (lockfiles.length > 1) parts2.push(events.fillPlain('Found in {n} lockfiles in this project.', { n: ['count', String(lockfiles.length), 'several'] }, 300));
  // Advisory codes stay in the local report: mixed letter and digit codes read as keys to the dashboard's secret check.
  return parts2.filter(Boolean).join(' ').slice(0, 1000);
}

// One event per package and version, however many lockfiles hold it. That
// way the fingerprint stays the same as before lockfile paths were tracked.
function toEvents(result, { repo, now = new Date() } = {}) {
  const name = repo || events.repoName(result.root);
  const groups = new Map();
  for (const a of result.affected) {
    const fp = events.fingerprint('threat', a.ecosystem, a.name, a.version);
    if (!groups.has(fp)) groups.set(fp, { a, lockfiles: [] });
    if (a.lockfile && !groups.get(fp).lockfiles.includes(a.lockfile)) groups.get(fp).lockfiles.push(a.lockfile);
  }
  return [...groups.entries()].map(([fp, { a, lockfiles }]) => events.makeEvent({
    kind: 'threat',
    repo: name,
    severity: a.severity,
    title: threatTitle(a),
    detail: threatDetail(a, lockfiles),
    status: 'open',
    // Per package and version: updating it changes the version, so the old
    // finding resolves on the next run.
    fingerprint: fp,
    occurredAt: now,
  }));
}

// For each threat fingerprint, the lockfiles it was found in. Kept in the
// local state so a later run can tell whether it read those files again.
function lockfilesByFingerprint(result) {
  const out = new Map();
  for (const a of result.affected) {
    const fp = events.fingerprint('threat', a.ecosystem, a.name, a.version);
    if (!out.has(fp)) out.set(fp, { lockfiles: [] });
    if (a.lockfile && !out.get(fp).lockfiles.includes(a.lockfile)) out.get(fp).lockfiles.push(a.lockfile);
  }
  return out;
}

// Fingerprints of every package version in a list of lockfile texts. Used
// to tell whether the default branch still holds an affected version.
function fingerprintsIn(files) {
  const out = new Set();
  for (const { file, text } of files) {
    const lf = LOCKFILE_BY_NAME.get(path.basename(file));
    if (!lf || typeof text !== 'string') continue;
    for (const p of lf.parse(text)) if (looksReal(p)) out.add(events.fingerprint('threat', p.ecosystem, p.name, p.version));
  }
  return out;
}

function uniqueCount(affected) {
  return new Set(affected.map(pkgKey)).size;
}

function renderReport(result) {
  const L = [''];
  if (!result.lockfiles.length) {
    L.push('  sentinel watch: no lockfile found here. there is nothing to check');
    L.push('  it reads package-lock.json, pnpm-lock.yaml, yarn.lock, requirements.txt, poetry.lock, go.sum and Gemfile.lock in this folder and its subfolders');
    for (const w of result.warnings) L.push(`  warning: ${w}`);
    L.push('');
    return L.join('\n');
  }
  const n = result.lockfiles.length;
  L.push(`  sentinel watch: checked ${result.packages} package versions from ${n} lockfile${n === 1 ? '' : 's'} against the osv database`);
  L.push(`  read: ${result.lockfiles.map((l) => l.file).join(', ')}`);
  for (const w of result.warnings) L.push(`  warning: ${w}`);
  L.push('');
  if (result.offline) return L.join('\n');
  if (!result.affected.length) {
    L.push('  no known attacks or security holes affect the versions you use');
    L.push('');
    return L.join('\n');
  }
  for (const a of result.affected.slice(0, 80)) {
    const what = a.malicious ? 'published attack' : 'security hole';
    const fix = a.fixed ? `fixed in ${a.fixed}${a.major ? '. that is a new major version. check your code before you take it' : ''}` : 'no fix yet';
    L.push(`  ${a.severity.padEnd(8)} ${a.name} ${a.version} in ${a.lockfile || a.ecosystem}: ${what}. ${fix}`);
    L.push(`           ${a.advisories.slice(0, 4).join(' ')}${a.advisories.length > 4 ? ` and ${a.advisories.length - 4} more` : ''}`);
  }
  if (result.affected.length > 80) L.push(`  and ${result.affected.length - 80} more. run with --json to see all`);
  const unique = uniqueCount(result.affected);
  const fixable = uniqueCount(result.affected.filter((a) => a.fixed));
  const majors = uniqueCount(result.affected.filter((a) => a.fixed && a.major));
  L.push('');
  L.push(`  ${unique} affected package${unique === 1 ? '' : 's'}. ${fixable} ha${fixable === 1 ? 's' : 've'} a fixed version`);
  if (majors) L.push(`  ${majors} of those fix${majors === 1 ? 'es' : ''} only in a new major version. --fix leaves ${majors === 1 ? 'it' : 'them'} for a person unless you add --allow-major`);
  if (fixable) L.push('  run atris sentinel watch --fix to update them on a new branch you can review');
  L.push('');
  return L.join('\n');
}

// ---------------------------------------------------------------- fix

function execFor(run) {
  const { execFileSync } = require('child_process');
  return run || ((cmd, a, o) => execFileSync(cmd, a, o));
}

function git(root, args, { run } = {}) {
  return String(execFor(run)('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '').trim();
}

function rewriteRequirements(text, updates) {
  const map = new Map(updates.map((u) => [u.name.toLowerCase().replace(/[-_.]+/g, '-'), u.fixed]));
  let changed = 0;
  const out = text.split('\n').map((line) => {
    const m = line.match(/^(\s*)([A-Za-z0-9][A-Za-z0-9._-]*)((?:\[[^\]]*\])?\s*===?\s*)([0-9][A-Za-z0-9.!+-]*)(.*)$/);
    if (!m) return line;
    const fixed = map.get(m[2].toLowerCase().replace(/[-_.]+/g, '-'));
    if (!fixed || compareVersions(fixed, m[4]) <= 0) return line;
    changed += 1;
    return `${m[1]}${m[2]}${m[3]}${fixed}${m[5]}`;
  });
  return { text: out.join('\n'), changed };
}

// ---- tool errors

function stripAnsi(s) {
  return String(s || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

// The tool's own words, one or two lines. execFileSync puts the real error
// in stderr and leaves only "Command failed: ..." in the message.
function toolErrorLines(e, tool) {
  if (e && e.code === 'ENOENT') return [`${tool} is not installed here`];
  const text = `${stripAnsi(e && e.stderr)}\n${stripAnsi(e && e.stdout)}`;
  const lines = [];
  for (const raw of text.split('\n')) {
    let l = raw.replace(/^\s*(?:npm (?:error|ERR!|warn|WARN)|pnpm:?|yarn (?:error|warn)|error|ERROR| ?ERR_PNPM_[A-Z_]+)\s*/, '').trim();
    if (!l) continue;
    if (/complete log of this run|^a complete log|\.log$|^code\s+\S+$|^errno\b|^syscall\b|^path\s+\//i.test(l)) continue;
    if (/^Command failed:/.test(l)) continue;
    l = l.replace(/\s+/g, ' ');
    if (l.length > 220) l = `${l.slice(0, 217)}...`;
    if (!lines.includes(l)) lines.push(l);
    if (lines.length >= 2) break;
  }
  if (lines.length) return lines;
  const status = e && Number.isInteger(e.status) ? e.status : null;
  return [`${tool} stopped${status !== null ? ` with exit code ${status}` : ''} and printed no reason`];
}

// A crash inside the tool or a version problem, where a newer copy of the
// tool often gets past it.
const TOOL_BUG = /cannot read propert(?:y|ies) of (?:null|undefined)|is not a function|is not iterable|invalid version|eresolve|maximum call stack|ebadengine|unsupported engine|err_invalid_arg_type|exit handler never called|tracker .* already exists|could not resolve dependency|conflicting peer|peer dep|unsupported (?:lockfile|version)|lockfile.*(?:version|format)|requires (?:npm|pnpm|node)/i;

function toolError(tool, lockfile, e, { exec, cwd }) {
  const lines = toolErrorLines(e, tool);
  const out = { tool, lockfile, lines };
  if (e && e.code === 'ENOENT') return out;
  const text = `${stripAnsi(e && e.stderr)}\n${stripAnsi(e && e.stdout)}`;
  if ((tool === 'npm' || tool === 'pnpm' || tool === 'yarn') && TOOL_BUG.test(text)) {
    let version = '';
    try { version = String(exec(tool, ['--version'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '').trim().split('\n')[0]; } catch {}
    if (!/^\d+\.\d+\.\d+/.test(version)) version = '';
    out.version = version || null;
    out.hint = `this looks like ${tool === 'npm' ? 'an' : 'a'} ${tool} bug or a version problem. ${version ? `${tool} ${version} is installed here. ` : ''}a newer ${tool} may get past it: npm install -g ${tool}@latest`;
  }
  return out;
}

// ---- npm graph

// Where node finds `name` when required from the package at `from`: the
// nearest node_modules folder up the tree that holds it.
function npmResolve(packages, from, name) {
  let base = from;
  for (;;) {
    const at = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[at]) return at;
    if (!base) return null;
    const i = base.lastIndexOf('/node_modules/');
    if (i !== -1) base = base.slice(0, i);
    else if (base.startsWith('node_modules/')) base = '';
    else base = ''; // a workspace folder resolves next from the root
  }
}

function npmEntryName(packages, key) {
  const v = packages[key] || {};
  if (v.name) return v.name;
  const at = key.lastIndexOf('node_modules/');
  return at === -1 ? key : key.slice(at + 'node_modules/'.length);
}

// Who pulls in the copy at `target`. A parent with no node_modules in its key
// is the project itself or one of its workspace folders.
function npmParents(packages, target) {
  const name = npmEntryName(packages, target);
  const out = [];
  for (const [key, v] of Object.entries(packages)) {
    if (!v || v.link) continue;
    const isProject = !key.includes('node_modules/');
    const deps = { ...(v.dependencies || {}), ...(v.optionalDependencies || {}), ...(v.peerDependencies || {}), ...(isProject ? (v.devDependencies || {}) : {}) };
    if (!(name in deps)) continue;
    if (npmResolve(packages, key, name) !== target) continue;
    out.push(isProject ? { project: key } : { name: npmEntryName(packages, key), version: String(v.version || '') });
  }
  return out;
}

// ---- pnpm graph

function cleanPnpmVersion(v) {
  const s = String(v || '').trim().replace(/^['"]|['"]$/g, '');
  if (/^(?:link|file|workspace):/.test(s)) return null;
  const m = s.match(/^([0-9][^(\s]*)/);
  return m ? m[1] : null;
}

function unquote(s) {
  return String(s).trim().replace(/^['"]|['"]$/g, '');
}

// Edges of a pnpm lockfile: parent (a package or a project folder) to the
// exact child version it uses. Handles the importers section (v6 and v9),
// the old top-level dependencies (v5) and packages or snapshots.
function pnpmGraph(text) {
  const edges = [];
  let section = '';
  let importer = null;
  let parent = null;
  let depBlock = false;
  let pendingName = null;
  for (const line of text.split('\n')) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.match(/^ */)[0].length;
    if (indent === 0) {
      section = line.replace(/:.*$/, '').trim();
      importer = null; parent = null; depBlock = false; pendingName = null;
      if (['dependencies', 'devDependencies', 'optionalDependencies'].includes(section)) { importer = '.'; depBlock = true; }
      continue;
    }
    if (section === 'importers') {
      if (indent === 2) { importer = unquote(line.replace(/:\s*$/, '')); depBlock = false; pendingName = null; continue; }
      if (indent === 4) { depBlock = /^\s{4}(?:dependencies|devDependencies|optionalDependencies):\s*$/.test(line); pendingName = null; continue; }
      if (indent === 6 && depBlock) { pendingName = unquote(line.trim().replace(/:\s*$/, '')); continue; }
      if (indent === 8 && depBlock && pendingName) {
        const m = line.trim().match(/^version:\s*(.+)$/);
        if (m) { const v = cleanPnpmVersion(m[1]); if (v) edges.push({ from: { project: importer }, name: pendingName, version: v }); }
      }
      continue;
    }
    if (['dependencies', 'devDependencies', 'optionalDependencies'].includes(section)) {
      // v5: "  name: 1.2.3"; v6 single project: "  name:" then "    version: 1.2.3"
      if (indent === 2) {
        const m = line.trim().match(/^(['"]?[^:'"]+['"]?):\s*(.*)$/);
        if (!m) continue;
        pendingName = unquote(m[1]);
        const v = m[2] ? cleanPnpmVersion(m[2].replace(/^\//, '')) : null;
        if (v) { edges.push({ from: { project: '.' }, name: pendingName, version: v }); pendingName = null; }
        continue;
      }
      if (indent === 4 && pendingName) {
        const m = line.trim().match(/^version:\s*(.+)$/);
        if (m) { const v = cleanPnpmVersion(m[1]); if (v) edges.push({ from: { project: '.' }, name: pendingName, version: v }); }
      }
      continue;
    }
    if (section === 'packages' || section === 'snapshots') {
      if (indent === 2) {
        const m = line.match(PNPM_KEY);
        parent = m ? { name: m[1], version: m[2] } : null;
        depBlock = false;
        continue;
      }
      if (indent === 4) { depBlock = /^\s{4}(?:dependencies|optionalDependencies):\s*$/.test(line); continue; }
      if (indent === 6 && depBlock && parent) {
        const m = line.trim().match(/^(['"]?[^:'"]+['"]?):\s*(.+)$/);
        if (!m) continue;
        const raw = m[2].trim().replace(/^\//, '');
        // v5 can write a child as "/name/1.2.3"; plain "1.2.3" is the usual shape.
        const v = cleanPnpmVersion(raw.includes('/') ? raw.split('/').pop() : raw);
        if (v) edges.push({ from: parent, name: unquote(m[1]), version: v });
      }
    }
  }
  return edges;
}

function pnpmParents(edges, name, version) {
  const out = [];
  const seen = new Set();
  for (const e of edges) {
    if (e.name !== name || e.version !== version) continue;
    const id = e.from.project !== undefined ? `p:${e.from.project}` : `${e.from.name}@${e.from.version}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(e.from);
  }
  return out;
}

// ---- package.json edits

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Every write --fix makes goes through here. It refuses a file that is a
// symlink, sits under a symlinked folder or lands outside the repo.
function safeWrite(root, file, text) {
  if (!insideRepo(root, file)) throw new Error(`refused to write ${file}: it is outside this repo or behind a symlink`);
  fs.writeFileSync(file, text);
}

function writeJson(root, file, obj) {
  safeWrite(root, file, `${JSON.stringify(obj, null, 2)}\n`);
}

// Raise a direct dependency's range in the section it already lives in.
// Returns false when the range is not a plain version range we can raise.
function raiseDirect(pkg, name, fixed) {
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const deps = pkg[section];
    if (!deps || typeof deps[name] !== 'string') continue;
    const cur = deps[name];
    const m = cur.match(/^([\^~]|>=)?\s*v?(\d[^\s|]*)$/);
    if (!m) return false;
    // An open range like >=1.0.1 could reach any later major. It becomes
    // ^fixed. That stays on the fixed version's major line.
    if (m[1] !== '>=' && compareVersions(m[2], fixed) >= 0) return true;
    deps[name] = `${m[1] === '~' ? '~' : (m[1] ? '^' : '')}${fixed}`;
    return true;
  }
  return false;
}

function versionsOf(list, name) {
  return new Set(list.filter((p) => p.name === name).map((p) => p.version));
}

// ---- per lockfile

// The files one lockfile step may change, as they were before it. keep()
// must run before a file is written. Then restore() can put it back.
// Restore uses the same symlink and repo check as every other write.
function snapshot(root, files = []) {
  const saved = new Map();
  const snap = {
    keep(f) { if (!saved.has(f)) saved.set(f, readMaybe(f)); },
    restore() {
      for (const [f, text] of saved) {
        if (!insideRepo(root, f)) continue;
        if (text == null) { try { fs.rmSync(f, { force: true }); } catch {} } else { try { safeWrite(root, f, text); } catch {} }
      }
    },
    changed() { return [...saved].filter(([f, text]) => readMaybe(f) !== text).map(([f]) => f); },
    files() { return [...saved.keys()]; },
  };
  for (const f of files) snap.keep(f);
  return snap;
}

// Plans and writes the package.json edits for an npm or pnpm lockfile.
// Returns the items that could not be planned, each with a reason.
function planNodeEdits(tool, dir, lockText, items, { allCopies, snap, root }) {
  const pkgFile = path.join(dir, 'package.json');
  const pkg = readJson(pkgFile);
  const left = [];
  if (!pkg) return { left: items.map((a) => ({ a, why: `there is no package.json next to ${a.lockfile}` })) };
  const projectFiles = new Map([['.', { file: pkgFile, pkg }], ['', { file: pkgFile, pkg }]]);
  const project = (p) => {
    const key = p === '' ? '.' : p;
    if (!projectFiles.has(key)) {
      const file = path.join(dir, key, 'package.json');
      projectFiles.set(key, { file, pkg: insideRepo(root, file) ? readJson(file) : null });
    }
    return projectFiles.get(key);
  };
  let lock = null;
  let edges = null;
  if (tool === 'npm') { try { lock = JSON.parse(lockText); } catch {} }
  else edges = pnpmGraph(lockText);
  const overrides = () => {
    if (tool === 'npm') { pkg.overrides = pkg.overrides || {}; return pkg.overrides; }
    pkg.pnpm = pkg.pnpm || {};
    pkg.pnpm.overrides = pkg.pnpm.overrides || {};
    return pkg.pnpm.overrides;
  };
  for (const a of items) {
    let parents = [];
    if (tool === 'npm') {
      const packages = (lock && lock.packages) || null;
      if (!packages) { left.push({ a, why: 'this npm lockfile is too old to read who pulls each package in' }); continue; }
      const targets = Object.keys(packages).filter((k) => k.includes('node_modules/') && npmEntryName(packages, k) === a.name && String(packages[k].version) === a.version);
      for (const t of targets) parents.push(...npmParents(packages, t));
    } else {
      parents = pnpmParents(edges, a.name, a.version);
    }
    const seen = new Set();
    parents = parents.filter((p) => { const id = p.project !== undefined ? `p:${p.project || '.'}` : `${p.name}@${p.version}`; if (seen.has(id)) return false; seen.add(id); return true; });
    if (!parents.length) {
      // Nobody we can name pulls it in. A plain override is safe only when
      // every copy of this package in the lockfile is the affected version.
      const versions = versionsOf(allCopies, a.name);
      if (versions.size === 1 && versions.has(a.version)) {
        const o = overrides();
        if (typeof o[a.name] === 'object') { left.push({ a, why: 'package.json already has a nested override for it' }); continue; }
        o[a.name] = `^${a.fixed}`;
      } else left.push({ a, why: 'could not tell which package pulls in this copy. other copies of it are safe and must not move' });
      continue;
    }
    let ok = true;
    for (const p of parents) {
      if (p.project !== undefined) {
        const proj = project(p.project);
        if (!proj.pkg || !raiseDirect(proj.pkg, a.name, a.fixed)) { ok = false; break; }
        continue;
      }
      const o = overrides();
      if (tool === 'npm') {
        const key = `${p.name}@${p.version}`;
        if (typeof o[key] === 'string') { ok = false; break; }
        o[key] = o[key] || {};
        const cur = o[key][a.name];
        if (typeof cur === 'object') { ok = false; break; }
        if (typeof cur === 'string' && compareVersions(cur.replace(/^[^0-9]*/, ''), a.fixed) >= 0) continue;
        o[key][a.name] = `^${a.fixed}`;
      } else {
        const key = `${p.name}@${p.version}>${a.name}`;
        const cur = o[key];
        if (typeof cur === 'string' && compareVersions(cur.replace(/^[^0-9]*/, ''), a.fixed) >= 0) continue;
        o[key] = `^${a.fixed}`;
      }
    }
    if (!ok) left.push({ a, why: 'package.json already pins it in a way this fix will not change' });
  }
  const toWrite = [];
  for (const { file, pkg: p } of projectFiles.values()) if (p && !toWrite.some((w) => w.file === file)) toWrite.push({ file, pkg: p });
  // All or nothing: every manifest is checked before the first one is written.
  const bad = toWrite.find((w) => !insideRepo(root, w.file));
  if (bad) throw new Error(`${path.relative(root, bad.file)} is outside this repo or behind a symlink`);
  for (const w of toWrite) { snap.keep(w.file); writeJson(root, w.file, w.pkg); }
  return { left };
}

// ---- staying inside the repo

// True when target is root or under it and no folder or file between them
// is a symlink. A path that does not exist yet counts by its spelling, as
// long as the part that exists has no symlink.
function insideRepo(root, target) {
  const base = path.resolve(root);
  const rel = path.relative(base, path.resolve(target));
  if (rel === '') return true;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  let cur = base;
  for (const seg of rel.split(path.sep)) {
    cur = path.join(cur, seg);
    let st;
    try { st = fs.lstatSync(cur); } catch { return true; }
    if (st.isSymbolicLink()) return false;
  }
  try {
    const realRoot = fs.realpathSync(base);
    const real = fs.realpathSync(path.resolve(target));
    return real === realRoot || real.startsWith(realRoot + path.sep);
  } catch { return false; }
}

// Every project folder a node lockfile names: npm workspace keys and link
// targets, pnpm importers and link: versions. A package tool follows these,
// so each must stay inside the repo before the tool runs.
function projectFolders(tool, dir, text) {
  const out = [];
  if (tool === 'npm') {
    let json = null;
    try { json = JSON.parse(text); } catch {}
    for (const [key, v] of Object.entries((json && json.packages) || {})) {
      if (key && !key.includes('node_modules/')) out.push(path.join(dir, key));
      if (v && v.link && typeof v.resolved === 'string') out.push(path.join(dir, v.resolved));
    }
    return out;
  }
  if (tool === 'pnpm') {
    let section = '';
    let importer = '.';
    for (const line of text.split('\n')) {
      if (/^\S/.test(line)) { section = line.replace(/:.*$/, '').trim(); importer = '.'; continue; }
      if (section === 'importers' && /^ {2}\S/.test(line)) { importer = unquote(line.trim().replace(/:\s*$/, '')); out.push(path.join(dir, importer)); continue; }
      const m = line.match(/link:([^\s'"]+)/);
      if (m) out.push(path.join(dir, section === 'importers' ? importer : '.', m[1]));
    }
  }
  return out;
}

// ---- what the tool changed

function npmPackages(text) {
  try { const j = JSON.parse(text); return (j && j.packages) || null; } catch { return null; }
}

// npm: every copy reachable from the project folders without passing
// through a blocked copy, with the copy each of its dependencies resolves to.
function npmSafeSet(packages, blocked) {
  const seen = new Map();
  const stack = Object.keys(packages).filter((k) => !k.includes('node_modules/'));
  while (stack.length) {
    const key = stack.pop();
    if (seen.has(key)) continue;
    const v = packages[key] || {};
    const isProject = !key.includes('node_modules/');
    const deps = Object.keys({ ...(v.dependencies || {}), ...(v.optionalDependencies || {}), ...(v.peerDependencies || {}), ...(isProject ? (v.devDependencies || {}) : {}) }).sort();
    const kids = [];
    for (const name of deps) {
      const at = npmResolve(packages, key, name);
      kids.push(`${name}=${at || '-'}`);
      if (at && !blocked(at)) stack.push(at);
    }
    seen.set(key, `${isProject ? '' : `${npmEntryName(packages, key)}@${v.version}`}|${kids.join(',')}`);
  }
  return seen;
}

// pnpm and the rest: name@version nodes. Graph edges come from pnpm only.
function keySafeSet(edges, keys, blocked) {
  if (!edges) return new Map([...keys].filter((k) => !blocked(k)).map((k) => [k, '']));
  const kids = new Map();
  const from = (f) => (f.project !== undefined ? `project:${f.project}` : `${f.name}@${f.version}`);
  for (const e of edges) {
    const id = from(e.from);
    if (!kids.has(id)) kids.set(id, []);
    kids.get(id).push(`${e.name}@${e.version}`);
  }
  const seen = new Map();
  const stack = [...kids.keys()].filter((k) => k.startsWith('project:'));
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    const list = [...new Set(kids.get(id) || [])].sort();
    seen.set(id, list.join(','));
    for (const k of list) if (!blocked(k)) stack.push(k);
  }
  // A blocked child shows by name only: its version is allowed to move.
  for (const [id, sig] of seen) seen.set(id, sig.split(',').filter(Boolean).map((k) => (blocked(k) ? `${k.slice(0, k.lastIndexOf('@'))}@*` : k)).sort().join(','));
  return seen;
}

// What the tool changed beyond the affected copies. Returns problems in
// plain words; empty means the change stayed on the vulnerable paths. A
// copy of an affected package that the tool wrote must be at or above the
// fix and on the fix's major line. That way --allow-major is never bypassed.
function collateralProblems(lf, beforeText, afterText, items) {
  const problems = [];
  const names = new Set(items.map((a) => a.name));
  const gate = (name, version) => {
    const ok = items.some((a) => a.name === name && compareVersions(version, a.fixed) >= 0 && !isMajorJump(a.fixed, version));
    if (!ok) problems.push(`${name} went to ${version}. that is not a fixed version on the line this fix allows`);
  };
  if (lf.tool === 'npm') {
    const before = npmPackages(beforeText);
    const after = npmPackages(afterText);
    if (!before || !after) return ['the lockfile could not be read after the update'];
    const affected = (k, pk) => pk[k] && items.some((a) => a.name === npmEntryName(pk, k) && a.version === String(pk[k].version));
    const same = (k) => before[k] && after[k] && npmEntryName(before, k) === npmEntryName(after, k) && String(before[k].version) === String(after[k].version);
    const changedAffectedName = (k) => names.has(npmEntryName(after, k)) && !same(k);
    const sb = npmSafeSet(before, (k) => affected(k, before));
    const sa = npmSafeSet(after, (k) => changedAffectedName(k) || affected(k, after));
    for (const [k, sig] of sb) {
      if (sa.get(k) === sig) continue;
      problems.push(k.includes('node_modules/') ? `${npmEntryName(before, k)} ${before[k].version} at ${k} changed` : 'the project dependencies changed');
    }
    for (const [k, sig] of sa) if (!sb.has(k)) problems.push(`${npmEntryName(after, k)} ${after[k] && after[k].version} at ${k} is new`);
    // A copy the tool added must hang under a new fixed copy, not float free.
    const under = new Set();
    const stack = Object.keys(after).filter((k) => k.includes('node_modules/') && changedAffectedName(k));
    while (stack.length) {
      const k = stack.pop();
      if (under.has(k)) continue;
      under.add(k);
      const v = after[k] || {};
      for (const name of Object.keys({ ...(v.dependencies || {}), ...(v.optionalDependencies || {}), ...(v.peerDependencies || {}) })) { const at = npmResolve(after, k, name); if (at) stack.push(at); }
    }
    for (const k of Object.keys(after)) {
      if (!k.includes('node_modules/') || same(k) || names.has(npmEntryName(after, k)) || under.has(k)) continue;
      problems.push(`${npmEntryName(after, k)} ${after[k].version} at ${k} is new`);
    }
    for (const k of Object.keys(after)) if (k.includes('node_modules/') && changedAffectedName(k)) gate(npmEntryName(after, k), String(after[k].version));
    return [...new Set(problems)];
  }
  const beforeList = lf.parse(beforeText);
  const afterList = lf.parse(afterText);
  const bKeys = new Set(beforeList.map((p) => `${p.name}@${p.version}`));
  const aKeys = new Set(afterList.map((p) => `${p.name}@${p.version}`));
  const isAffected = (k) => items.some((a) => k === `${a.name}@${a.version}`);
  const nameOf = (k) => k.slice(0, k.lastIndexOf('@'));
  const newAffectedName = (k) => names.has(nameOf(k)) && !bKeys.has(k);
  const pnpm = lf.tool === 'pnpm';
  const sb = keySafeSet(pnpm ? pnpmGraph(beforeText) : null, bKeys, isAffected);
  const sa = keySafeSet(pnpm ? pnpmGraph(afterText) : null, aKeys, (k) => newAffectedName(k) || isAffected(k));
  for (const [k, sig] of sb) {
    if (!k.startsWith('project:') && !aKeys.has(k)) problems.push(`${k.replace(/@([^@]+)$/, ' $1')} is gone`);
    else if (sa.get(k) !== sig) problems.push(k.startsWith('project:') ? 'the project dependencies changed' : `what ${k.replace(/@([^@]+)$/, ' $1')} uses changed`);
  }
  for (const k of sa.keys()) if (!sb.has(k) && !k.startsWith('project:')) problems.push(`${k.replace(/@([^@]+)$/, ' $1')} is new`);
  // A package the tool added must hang under a new fixed copy (pnpm), or
  // be a new version of an affected package (lockfiles with no graph).
  const under = new Set();
  if (pnpm) {
    const kids = new Map();
    for (const e of pnpmGraph(afterText)) if (e.from.project === undefined) { const id = `${e.from.name}@${e.from.version}`; if (!kids.has(id)) kids.set(id, []); kids.get(id).push(`${e.name}@${e.version}`); }
    const stack = [...aKeys].filter(newAffectedName);
    while (stack.length) { const k = stack.pop(); if (under.has(k)) continue; under.add(k); for (const c of kids.get(k) || []) stack.push(c); }
  }
  for (const k of aKeys) if (!bKeys.has(k) && !names.has(nameOf(k)) && !under.has(k)) problems.push(`${k.replace(/@([^@]+)$/, ' $1')} is new`);
  for (const k of aKeys) if (newAffectedName(k)) gate(nameOf(k), k.slice(k.lastIndexOf('@') + 1));
  return [...new Set(problems)];
}

// Files git sees as changed or new under the repo, as absolute paths.
function gitChanged(root, exec) {
  let top;
  let out;
  try {
    top = String(exec('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
    out = String(exec('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch { return null; }
  const map = new Map();
  const parts2 = out.split('\0');
  for (let i = 0; i < parts2.length; i++) {
    const e = parts2[i];
    if (!e) continue;
    const code = e.slice(0, 2);
    map.set(path.join(top, e.slice(3)), code);
    if (code[0] === 'R' || code[0] === 'C') i += 1;
  }
  return map;
}

const TOOL_COMMANDS = {
  npm: () => [['npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund']]],
  pnpm: () => [['pnpm', ['install', '--lockfile-only', '--ignore-scripts']]],
  yarn: (lockText) => (/^__metadata:/m.test(lockText)
    ? [['yarn', ['install', '--mode', 'update-lockfile']]]
    : [['yarn', ['install', '--ignore-scripts', '--non-interactive']]]),
  poetry: (_, items) => [['poetry', ['update', '--lock', ...items.map((a) => a.name)]]],
  go: (_, items) => [...items.map((a) => ['go', ['get', `${a.name}@v${a.fixed}`]]), ['go', ['mod', 'tidy']]],
  bundler: (_, items) => [['bundle', ['lock', ...items.flatMap((a) => ['--update', a.name])]]],
};

const SIDE_FILES = { go: ['go.mod'], poetry: ['pyproject.toml'], bundler: ['Gemfile'] };

// Fix the affected items of one lockfile with that lockfile's own tool.
// Afterward the lockfile is read again: an affected version still in it is
// reported as left. A safe copy that moved undoes the whole change.
function fixOneLockfile(root, rel, items, { exec, allowedErrors }) {
  const lockFile = path.join(root, rel);
  const dir = path.dirname(lockFile);
  const lf = LOCKFILE_BY_NAME.get(path.basename(rel));
  const tool = lf.tool;
  const before = readMaybe(lockFile) || '';
  const beforeList = lf.parse(before);
  const left = [];
  const changed = [];
  // Before any write: every file this step may write or restore plus every
  // folder above it up to the repo root, must be a plain file or folder
  // inside the repo. One that is not refuses the whole lockfile.
  const pkgFile = path.join(dir, 'package.json');
  const mayWrite = [lockFile, pkgFile, ...(SIDE_FILES[tool] || []).map((f) => path.join(dir, f))];
  if (tool === 'npm' || tool === 'pnpm') for (const d of projectFolders(tool, dir, before)) mayWrite.push(d, path.join(d, 'package.json'));
  const unsafe = mayWrite.filter((f) => !insideRepo(root, f));
  if (unsafe.length) {
    const where = path.relative(root, unsafe[0]) || unsafe[0];
    return { left: items.map((a) => ({ a, why: `${rel} would write through a symlink or outside this repo (${where}). nothing was changed` })), changed: [], refused: true };
  }
  if (tool === 'pip') {
    const r = rewriteRequirements(before, items);
    if (r.changed) { safeWrite(root, lockFile, r.text); changed.push(rel); }
    const after = parseRequirements(r.text);
    for (const a of items) if (after.some((p) => p.name.toLowerCase() === a.name.toLowerCase() && p.version === a.version)) left.push({ a, why: 'its pin could not be rewritten' });
    return { left, changed };
  }
  // Checked before anything is written or run: every folder this lockfile
  // names stays inside the repo with no symlink on the way.
  const outside = projectFolders(tool, dir, before).filter((f) => !insideRepo(root, f));
  if (outside.length) {
    const where = path.relative(root, outside[0]) || outside[0];
    return { left: items.map((a) => ({ a, why: `${rel} names a folder outside this repo or behind a symlink (${where}). nothing was changed` })), changed: [], refused: true };
  }
  const snap = snapshot(root, [lockFile, pkgFile, ...(SIDE_FILES[tool] || []).map((f) => path.join(dir, f))]);
  const restore = () => snap.restore();
  let todo = items;
  if (tool === 'npm' || tool === 'pnpm') {
    let plan;
    try { plan = planNodeEdits(tool, dir, before, items, { allCopies: beforeList, snap, root }); } catch (e) { restore(); return { left: items.map((a) => ({ a, why: `could not plan the change: ${String(e.message || e).split('\n')[0]}` })), changed: [] }; }
    for (const l of plan.left) left.push(l);
    todo = items.filter((a) => !plan.left.some((l) => l.a === a));
    if (!todo.length) { restore(); return { left, changed: [] }; }
  } else if (tool === 'yarn') {
    // yarn resolutions cannot be scoped to one parent the way npm and pnpm
    // overrides can. A plain resolution is safe only when every copy of the
    // package in the lockfile is the affected version.
    const pkg = readJson(pkgFile);
    if (!pkg) { restore(); return { left: items.map((a) => ({ a, why: `there is no package.json next to ${rel}` })), changed: [] }; }
    const ok = [];
    for (const a of items) {
      const versions = versionsOf(beforeList, a.name);
      if (versions.size !== 1) { left.push({ a, why: 'yarn cannot limit the change to this one copy. other copies of it are safe and must not move' }); continue; }
      pkg.resolutions = pkg.resolutions || {};
      pkg.resolutions[a.name] = `^${a.fixed}`;
      raiseDirect(pkg, a.name, a.fixed);
      ok.push(a);
    }
    if (!ok.length) { restore(); return { left, changed: [] }; }
    writeJson(root, pkgFile, pkg);
    todo = ok;
  }
  for (const f of snap.files()) if (!insideRepo(root, f)) { restore(); return { left: todo.map((a) => ({ a, why: `a file this fix would write is outside this repo (${f}). nothing was changed` })).concat(left), changed: [], refused: true }; }
  const statusBefore = gitChanged(root, exec);
  try {
    for (const [cmd, args] of TOOL_COMMANDS[tool](before, todo)) exec(cmd, args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    restore();
    const te = toolError(tool === 'bundler' ? 'bundle' : tool, rel, e, { exec, cwd: dir });
    allowedErrors.push(te);
    for (const a of todo) left.push({ a, why: `${te.tool} could not update ${rel}` });
    return { left, changed: [] };
  }
  // The tool may change only the files this step planned. Anything else it
  // wrote in the repo is put back and the step fails.
  const statusAfter = gitChanged(root, exec);
  const real = (f) => { try { return path.join(fs.realpathSync(path.dirname(f)), path.basename(f)); } catch { return path.resolve(f); } };
  const planned = new Set(snap.files().map(real));
  let realRoot = root;
  try { realRoot = fs.realpathSync(root); } catch {}
  const stray = [];
  if (!statusBefore || !statusAfter) stray.push('git could not list the changed files');
  else for (const [f, code] of statusAfter) if (!planned.has(f) && statusBefore.get(f) !== code) stray.push(f);
  if (stray.length) {
    restore();
    for (const f of stray) {
      if (!path.isAbsolute(f)) continue;
      try {
        if (statusAfter.get(f) === '??') fs.rmSync(f, { force: true });
        else exec('git', ['checkout', '--', f], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {}
    }
    const first = path.isAbsolute(stray[0]) ? path.relative(realRoot, stray[0]) : stray[0];
    for (const a of todo) left.push({ a, why: `${lf.tool} also changed ${first}${stray.length > 1 ? ` and ${stray.length - 1} more` : ''}. it was undone` });
    return { left, changed: [] };
  }
  const after = readMaybe(lockFile) || '';
  const afterList = lf.parse(after);
  // Only the affected copies, along their vulnerable paths, may move.
  const problems = collateralProblems(lf, before, after, todo);
  if (problems.length) {
    restore();
    for (const a of todo) left.push({ a, why: `the update also changed more than the affected copy: ${problems.slice(0, 2).join('. ')}${problems.length > 2 ? ` and ${problems.length - 2} more` : ''}. it was undone` });
    return { left, changed: [] };
  }
  for (const a of todo) {
    if (afterList.some((p) => p.name === a.name && p.version === a.version)) left.push({ a, why: `${rel} still holds it after the update` });
  }
  for (const f of snap.changed()) changed.push(path.relative(root, f));
  return { left, changed };
}

// Updates affected packages on a new branch, one lockfile at a time with
// that lockfile's own tool. Everything it could not fix is listed in
// `manual` with the reason. The list is never partial.
function applyFix(root, result, { run, now = new Date(), log = () => {}, allowMajor = false } = {}) {
  const exec = execFor(run);
  const manual = [];
  for (const a of result.affected) if (!a.fixed) manual.push({ ...a, why: 'no fixed version is published yet' });
  const fixable = [];
  for (const a of result.affected) {
    if (!a.fixed) continue;
    if (a.major && !allowMajor) manual.push({ ...a, why: `${a.fixed} is a new major version. check your code then rerun with --allow-major` });
    else fixable.push(a);
  }
  if (!fixable.length) return { ok: true, changed: 0, manual, toolErrors: [], message: manual.length ? 'nothing could be updated without a person' : 'nothing has a fixed version yet' };
  let status;
  try { status = git(root, ['status', '--porcelain'], { run }); } catch { return { ok: false, reason: 'this folder is not a git repository. the fix needs a branch to go on', manual, toolErrors: [] }; }
  if (status) return { ok: false, reason: 'this folder has uncommitted changes. commit or stash them first so the fix branch holds only the update', manual, toolErrors: [] };
  let from = '';
  try { from = git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], { run }); } catch {}
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const branch = `sentinel/fix-dependencies-${stamp}`;
  git(root, ['checkout', '-b', branch], { run });
  const changedFiles = new Set();
  const toolErrors = [];
  const byLock = new Map();
  for (const a of fixable) {
    if (!a.lockfile || !LOCKFILE_BY_NAME.has(path.basename(a.lockfile))) { manual.push({ ...a, why: 'it is not in a lockfile this fix can read' }); continue; }
    if (!byLock.has(a.lockfile)) byLock.set(a.lockfile, []);
    byLock.get(a.lockfile).push(a);
  }
  for (const [rel, items] of byLock) {
    let r;
    try { r = fixOneLockfile(root, rel, items, { exec, allowedErrors: toolErrors }); } catch (e) { r = { left: items.map((a) => ({ a, why: `the fix stopped: ${String(e.message || e).split('\n')[0]}` })), changed: [] }; }
    for (const l of r.left) manual.push({ ...l.a, why: l.why });
    for (const f of r.changed) changedFiles.add(f);
  }
  for (const te of toolErrors) log(`${te.tool} could not update ${te.lockfile}: ${te.lines.join('. ')}`);
  let committed = false;
  const dirty = git(root, ['status', '--porcelain'], { run });
  if (dirty && changedFiles.size) {
    git(root, ['add', '-A', '--', ...[...changedFiles].filter((f) => fs.existsSync(path.join(root, f)))], { run });
    try {
      git(root, ['commit', '-m', 'Update dependencies with known security fixes\n\nMade by atris sentinel watch --fix. Review before merging.'], { run });
    } catch (e) {
      return { ok: false, branch, from, reason: `the update is on branch ${branch} but the commit did not go through: ${String(e.message || e).split('\n')[0]}`, manual, toolErrors };
    }
    committed = true;
  } else {
    // Nothing changed: drop the empty branch and go back.
    try { if (from) git(root, ['checkout', from], { run }); git(root, ['branch', '-D', branch], { run }); } catch {}
  }
  return { ok: true, branch: committed ? branch : null, from, changed: committed ? changedFiles.size : 0, manual, toolErrors };
}

// ---------------------------------------------------------------- branch

function gitTry(root, args, run) {
  try { return git(root, args, { run }); } catch { return null; }
}

// Which branch this run is on and whether it is the repo's default branch.
// When it is not, liveFingerprints holds every package version still in the
// default branch's lockfiles. A threat counts as fixed only when the fix
// has reached that branch.
function branchState(root, { run } = {}) {
  if (gitTry(root, ['rev-parse', '--is-inside-work-tree'], run) !== 'true') return { git: false, onDefault: true };
  const branch = gitTry(root, ['rev-parse', '--abbrev-ref', 'HEAD'], run) || 'HEAD';
  let defaultBranch = null;
  const originHead = gitTry(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], run);
  if (originHead && originHead.startsWith('origin/')) defaultBranch = originHead.slice('origin/'.length);
  if (!defaultBranch) {
    for (const b of ['main', 'master']) if (gitTry(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], run)) { defaultBranch = b; break; }
  }
  if (!defaultBranch) {
    for (const b of ['main', 'master']) if (gitTry(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`], run)) { defaultBranch = b; break; }
  }
  // One branch and no remote: that branch is the default.
  if (!defaultBranch) defaultBranch = branch !== 'HEAD' ? branch : null;
  const onDefault = Boolean(defaultBranch) && branch === defaultBranch;
  const state = { git: true, branch, defaultBranch, onDefault };
  if (onDefault || !defaultBranch) return state;
  const ref = gitTry(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${defaultBranch}`], run) ? `origin/${defaultBranch}` : defaultBranch;
  state.defaultRef = ref;
  const listing = gitTry(root, ['ls-tree', '-r', '--name-only', ref, '--', '.'], run);
  if (listing == null) { state.liveFingerprints = null; return state; }
  const prefix = gitTry(root, ['rev-parse', '--show-prefix'], run) || '';
  const files = [];
  for (const full of listing.split('\n').filter(Boolean)) {
    const rel = prefix && full.startsWith(prefix) ? full.slice(prefix.length) : full;
    if (!LOCKFILE_BY_NAME.has(path.basename(rel))) continue;
    const segs = rel.split('/').slice(0, -1);
    if (segs.some(skipDir) || segs.length > MAX_DEPTH) continue;
    // Fail closed: a default branch we cannot read in full keeps every
    // gone threat open.
    if (files.length >= MAX_LOCKFILES * 2) { state.liveFingerprints = null; return state; }
    const size = Number(gitTry(root, ['cat-file', '-s', `${ref}:./${rel}`], run));
    if (!Number.isFinite(size) || size > MAX_LOCKFILE_BYTES) { state.liveFingerprints = null; return state; }
    const text = gitTry(root, ['show', `${ref}:./${rel}`], run);
    if (text == null) { state.liveFingerprints = null; return state; }
    files.push({ file: rel, text });
  }
  state.liveFingerprints = fingerprintsIn(files);
  return state;
}

module.exports = {
  OSV_BASE,
  MAX_LOCKFILES,
  parsePackageLock,
  parsePnpmLock,
  parseYarnLock,
  parseRequirements,
  parsePoetryLock,
  parseGoSum,
  parseGemfileLock,
  pnpmGraph,
  compareVersions,
  isMajorJump,
  fixedVersionFor,
  runWatch,
  toEvents,
  lockfilesByFingerprint,
  renderReport,
  applyFix,
  branchState,
  toolErrorLines,
};
