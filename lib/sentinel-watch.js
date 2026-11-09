'use strict';

// atris sentinel watch: known attacks and security holes in the packages a
// project uses. Reads the lockfiles, asks the free OSV database
// (https://api.osv.dev, no key) which exact versions are affected, and
// reports each affected package with the version that fixes it.
//
//   parse   package-lock.json, pnpm-lock.yaml, yarn.lock, requirements.txt,
//           poetry.lock, go.sum, Gemfile.lock (exact versions only)
//   query   POST /v1/querybatch returns advisory ids per package, then
//           GET /v1/vulns/<id> gives the affected ranges and fixed versions
//   fix     --fix updates packages on a new git branch, commits there and
//           never pushes. Never commits on main or master.
//
// Only package names, versions and advisory ids go to OSV. No source code.
// A network failure is a warning in the result, never a throw.

const fs = require('fs');
const path = require('path');
const events = require('./sentinel-events');

const OSV_BASE = 'https://api.osv.dev';
const BATCH_SIZE = 1000;
const MAX_VULN_DETAILS = 400;

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
      out.push({ name: v.name || key.slice(at + 'node_modules/'.length), version: String(v.version), ecosystem: 'npm', direct: key.split('node_modules/').length === 2, dev: Boolean(v.dev) });
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
function parsePnpmLock(text) {
  const out = [];
  let inPackages = false;
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) { inPackages = /^(?:packages|snapshots):\s*$/.test(line); continue; }
    if (!inPackages) continue;
    const m = line.match(/^ {2}['"]?\/?((?:@[^/@\s]+\/)?[^/@\s(]+)[@/]([0-9][^:('"\s]*)(?:\([^:]*\))?['"]?:\s*$/);
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

const LOCKFILES = [
  { file: 'package-lock.json', parse: parsePackageLock },
  { file: 'npm-shrinkwrap.json', parse: parsePackageLock },
  { file: 'pnpm-lock.yaml', parse: parsePnpmLock },
  { file: 'yarn.lock', parse: parseYarnLock },
  { file: 'requirements.txt', parse: parseRequirements },
  { file: 'poetry.lock', parse: parsePoetryLock },
  { file: 'go.sum', parse: parseGoSum },
  { file: 'Gemfile.lock', parse: parseGemfileLock },
];

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

function readLockfiles(root) {
  const found = [];
  const seen = new Set();
  const packages = [];
  let skipped = 0;
  for (const lf of LOCKFILES) {
    const file = path.join(root, lf.file);
    const text = readMaybe(file);
    if (text == null) continue;
    const list = lf.parse(text);
    found.push({ file: lf.file, packages: list.length });
    for (const p of list) {
      if (!looksReal(p)) { skipped += 1; continue; }
      const key = `${p.ecosystem}\u0000${p.name}\u0000${p.version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      packages.push({ ...p, lockfile: lf.file });
    }
  }
  return { lockfiles: found, packages, skipped };
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

async function runWatch(root, { base = process.env.ATRIS_OSV_BASE || OSV_BASE, request = defaultRequest() } = {}) {
  const { lockfiles, packages, skipped } = readLockfiles(root);
  const result = { root: path.resolve(root), lockfiles, packages: packages.length, skipped, affected: [], warnings: [] };
  if (skipped) result.warnings.push(`skipped ${skipped} lockfile entr${skipped === 1 ? 'y' : 'ies'} that did not look like a package version. they were not sent`);
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
    result.affected.push({ ...pkg, advisories: vids, fixed, malicious, severity, unfixed: fixes.length < vids.length });
  });
  result.affected.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.name.localeCompare(b.name));
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

function threatDetail(a) {
  const one = a.advisories.length === 1;
  const slots = { n: ['count', String(a.advisories.length), 'some'], fixed: ['version', a.fixed, 'a newer version'], current: ['version', a.version, 'the current version'] };
  const found = one ? 'Found in one published advisory against version {current}.' : 'Found in {n} published advisories against version {current}.';
  const head = a.fixed
    ? events.fillPlain(`${found} Update to version {fixed} or later and run your tests.`, slots, 1000)
    : events.fillPlain(`${found} Watch for a fix or replace the package.`, slots, 1000);
  // Advisory codes stay in the local report: mixed letter and digit codes read as keys to the dashboard's secret check.
  return head.slice(0, 1000);
}

function toEvents(result, { repo, now = new Date() } = {}) {
  const name = repo || events.repoName(result.root);
  return result.affected.map((a) => events.makeEvent({
    kind: 'threat',
    repo: name,
    severity: a.severity,
    title: threatTitle(a),
    detail: threatDetail(a),
    status: 'open',
    // Per package and version: updating it changes the version, so the old
    // finding resolves on the next run.
    fingerprint: events.fingerprint('threat', a.ecosystem, a.name, a.version),
    occurredAt: now,
  }));
}

function renderReport(result) {
  const L = [''];
  const files = result.lockfiles.map((l) => l.file).join(', ');
  if (!result.lockfiles.length) {
    L.push('  sentinel watch: no lockfile found here. there is nothing to check');
    L.push('  it reads package-lock.json, pnpm-lock.yaml, yarn.lock, requirements.txt, poetry.lock, go.sum and Gemfile.lock');
    L.push('');
    return L.join('\n');
  }
  L.push(`  sentinel watch: checked ${result.packages} package versions from ${files} against the osv database`);
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
    const fix = a.fixed ? `fixed in ${a.fixed}` : 'no fix yet';
    L.push(`  ${a.severity.padEnd(8)} ${a.name} ${a.version} (${a.ecosystem}): ${what}. ${fix}`);
    L.push(`           ${a.advisories.slice(0, 4).join(' ')}${a.advisories.length > 4 ? ` and ${a.advisories.length - 4} more` : ''}`);
  }
  if (result.affected.length > 80) L.push(`  and ${result.affected.length - 80} more. run with --json to see all`);
  const fixable = result.affected.filter((a) => a.fixed).length;
  L.push('');
  L.push(`  ${result.affected.length} affected package${result.affected.length === 1 ? '' : 's'}. ${fixable} ha${fixable === 1 ? 's' : 've'} a fixed version`);
  if (fixable) L.push('  run atris sentinel watch --fix to update them on a new branch you can review');
  L.push('');
  return L.join('\n');
}

// ---------------------------------------------------------------- fix

function git(root, args, { run } = {}) {
  const { execFileSync } = require('child_process');
  const exec = run || ((cmd, a, o) => execFileSync(cmd, a, o));
  return String(exec('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '').trim();
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

// Updates affected packages on a new branch. npm packages go through npm
// (direct ones by version, the rest by an override in package.json);
// requirements.txt pins are rewritten. Everything else is listed for a
// person to update.
function applyFix(root, result, { run, now = new Date(), log = () => {} } = {}) {
  const fixable = result.affected.filter((a) => a.fixed);
  if (!fixable.length) return { ok: true, changed: 0, manual: [], message: 'nothing has a fixed version yet' };
  let status;
  try { status = git(root, ['status', '--porcelain'], { run }); } catch { return { ok: false, reason: 'this folder is not a git repository. the fix needs a branch to go on' }; }
  if (status) return { ok: false, reason: 'this folder has uncommitted changes. commit or stash them first so the fix branch holds only the update' };
  let from = '';
  try { from = git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], { run }); } catch {}
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const branch = `sentinel/fix-dependencies-${stamp}`;
  git(root, ['checkout', '-b', branch], { run });
  const changedFiles = new Set();
  const manual = [];
  const npm = fixable.filter((a) => a.ecosystem === 'npm' && a.lockfile === 'package-lock.json');
  const py = fixable.filter((a) => a.ecosystem === 'PyPI' && a.lockfile === 'requirements.txt');
  for (const a of fixable) if (!npm.includes(a) && !py.includes(a)) manual.push(a);
  if (py.length) {
    const file = path.join(root, 'requirements.txt');
    const r = rewriteRequirements(fs.readFileSync(file, 'utf8'), py);
    if (r.changed) { fs.writeFileSync(file, r.text); changedFiles.add('requirements.txt'); }
  }
  if (npm.length) {
    const pkgFile = path.join(root, 'package.json');
    let pkg = null;
    try { pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')); } catch {}
    if (!pkg) manual.push(...npm);
    else {
      const declared = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.optionalDependencies || {}) };
      const direct = npm.filter((a) => declared[a.name] && a.direct !== false);
      const transitive = npm.filter((a) => !direct.includes(a));
      if (transitive.length) {
        pkg.overrides = pkg.overrides || {};
        for (const a of transitive) {
          const cur = pkg.overrides[a.name];
          if (typeof cur === 'string' && compareVersions(cur.replace(/^[^0-9]*/, ''), a.fixed) >= 0) continue;
          if (cur && typeof cur !== 'string') { manual.push(a); continue; }
          pkg.overrides[a.name] = `^${a.fixed}`;
        }
        fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
      }
      const { execFileSync } = require('child_process');
      const exec = run || ((cmd, a, o) => execFileSync(cmd, a, o));
      try {
        // --ignore-scripts: no install script runs while fixing a security issue.
        const specs = direct.map((a) => `${a.name}@^${a.fixed}`);
        if (specs.length) exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...specs], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        else exec('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        changedFiles.add('package.json');
        changedFiles.add('package-lock.json');
      } catch (e) {
        log(`npm could not update the packages: ${String(e.message || e).split('\n')[0]}`);
        // Leave no half update: put package.json and the lockfile back.
        try { git(root, ['checkout', '--', 'package.json', 'package-lock.json'], { run }); } catch {}
        manual.push(...npm);
      }
    }
  }
  let committed = false;
  const dirty = git(root, ['status', '--porcelain'], { run });
  if (dirty) {
    git(root, ['add', '-A', '--', ...[...changedFiles].filter((f) => fs.existsSync(path.join(root, f)))], { run });
    try {
      git(root, ['commit', '-m', 'Update dependencies with known security fixes\n\nMade by atris sentinel watch --fix. Review before merging.'], { run });
    } catch (e) {
      return { ok: false, branch, from, reason: `the update is on branch ${branch} but the commit did not go through: ${String(e.message || e).split('\n')[0]}`, manual };
    }
    committed = true;
  } else {
    // Nothing changed: drop the empty branch and go back.
    try { if (from) git(root, ['checkout', from], { run }); git(root, ['branch', '-D', branch], { run }); } catch {}
  }
  return { ok: true, branch: committed ? branch : null, from, changed: committed ? changedFiles.size : 0, manual };
}

module.exports = {
  OSV_BASE,
  parsePackageLock,
  parsePnpmLock,
  parseYarnLock,
  parseRequirements,
  parsePoetryLock,
  parseGoSum,
  parseGemfileLock,
  compareVersions,
  fixedVersionFor,
  runWatch,
  toEvents,
  renderReport,
  applyFix,
};
