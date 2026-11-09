'use strict';

// The sentinel security record: one append-only log per project of every
// review, recheck, agent check, dependency watch, guard summary and fix.
// A small company hands the exported file to a customer's security reviewer.
//
// The guarantee:
//   every entry holds the SHA-256 of the entry before it and an Ed25519
//   signature from this project's key. Editing, deleting, reordering or
//   inserting an entry breaks the chain or a signature. The verifier
//   names the first entry that broke. An export also carries a signed head
//   (entry count and last hash). Cutting entries off the end of an
//   exported file breaks it too.
//   the signature proves the record came from the holder of this project's
//   key and was not edited since. the key fingerprint printed by
//   `atris sentinel record key` is what a reviewer compares against.
//
// Accepted limits:
//   it does not prove the checks were thorough or that the code is safe.
//   it records what sentinel ran and what it found, nothing more
//   it does not prove when an entry was written. times come from this
//   machine's clock. Backfilled entries carry their original dates
//   the key holder can build a fresh record from scratch or drop the newest
//   entries and sign a new head. a reviewer who kept an earlier export can
//   catch that: its last hash must still appear in the new one
//   a reviewer who takes the public key from the file itself instead of
//   from the company can be fooled by a record signed with some other key
//   the key sits in a 0600 file on this machine. anyone who can read it can
//   sign entries
//
// Privacy: entries hold plain sentences, counts, file:line locations and
// short fingerprints only. Every text field goes through plain() and the
// strict secret scanner in lib/sentinel-cloud.js before it is written, and
// the whole entry is scanned once more. Code, secrets and file contents
// never reach an entry.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const FORMAT = 'atris-sentinel-record';
const FORMAT_VERSION = 1;
const ZERO_HASH = '0'.repeat(64);
const KINDS = ['review', 'recheck', 'agent_check', 'watch', 'guard', 'fix'];
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
const STATUSES = ['open', 'fixed', 'needs_validation', 'fix_prepared'];
const KIND_WORDS = { review: 'review', recheck: 'recheck', agent_check: 'agent check', watch: 'dependency watch', guard: 'guard summary', fix: 'fix' };
const MAX_FINDINGS = 500;

function cloud() { return require('./sentinel-cloud'); }

// ---------------------------------------------------------------- paths

function homeOf(opts = {}) {
  return opts.homeDir || (opts.env && opts.env.HOME) || process.env.HOME || os.homedir();
}

function auditHome(opts = {}) {
  if (opts.recordHome) return opts.recordHome;
  const env = opts.env || process.env;
  return env.ATRIS_SECURITY_AUDIT_HOME || path.join(homeOf(opts), '.atris', 'security-audit');
}

function projectName(root) {
  let name = '';
  try { name = require('./security-audit').repoName(path.resolve(root)); } catch {}
  return /^[A-Za-z0-9._-]{1,100}$/.test(name) ? name : 'project';
}

function recordPath(root, opts = {}) {
  return path.join(auditHome(opts), opts.project || projectName(root), 'record.jsonl');
}

function keyPath(project, opts = {}) {
  return path.join(homeOf(opts), '.atris', 'sentinel', 'record-keys', `${project}.json`);
}

// ---------------------------------------------------------------- canonical form

// Sorted keys, no spaces. The browser verifier below uses the same code.
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function fromB64url(s) { return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }

function keyFingerprint(publicKeyB64) {
  return sha256Bytes(fromB64url(publicKeyB64)).slice(0, 32).match(/.{4}/g).join(' ');
}
function sha256Bytes(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// ---------------------------------------------------------------- key

// One Ed25519 key per project, made on first use, kept outside the repo.
function loadKey(project, opts = {}) {
  const file = keyPath(project, opts);
  let data = null;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (data && data.private_pem && data.public_key) {
    return { file, project, privateKey: crypto.createPrivateKey(data.private_pem), publicKey: data.public_key, fingerprint: keyFingerprint(data.public_key), created: false };
  }
  if (opts.create === false) return null;
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'jwk' }).x;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(file), 0o700); } catch {}
  const body = JSON.stringify({ project, created_at: new Date().toISOString(), public_key: pub, private_pem: privateKey.export({ format: 'pem', type: 'pkcs8' }) }, null, 2);
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeSync(fd, `${body}\n`); } finally { fs.closeSync(fd); }
  fs.chmodSync(file, 0o600);
  return { file, project, privateKey, publicKey: pub, fingerprint: keyFingerprint(pub), created: true };
}

function signText(text, privateKey) {
  return b64url(crypto.sign(null, Buffer.from(text, 'utf8'), privateKey));
}

// ---------------------------------------------------------------- cleaning

function cleanText(value, max = 300) {
  const { plain, FALLBACK_SENTENCE } = cloud();
  const s = plain(value, max);
  return s && s !== FALLBACK_SENTENCE ? s : '';
}

function cleanLocation(loc) {
  const s = String(loc || '').trim();
  const m = s.match(/^([\w./@+-]+?)(?::(\d{1,7}))?$/);
  if (!m || s.length > 280 || m[1].split('/').includes('..') || m[1].startsWith('/')) return '';
  if (cloud().strictSecretHit(s)) return '';
  return s;
}

function cleanCount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function cleanCounts(obj, depth = 0) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(k)) continue;
    if (v && typeof v === 'object' && depth === 0) out[k] = cleanCounts(v, 1);
    else if (typeof v !== 'object') out[k] = cleanCount(v);
  }
  return out;
}

function cleanSeverity(s) {
  const v = String(s || '').toLowerCase();
  if (v === 'informational') return 'info';
  return SEVERITIES.includes(v) ? v : 'unrated';
}

function cleanDate(d) {
  const t = Date.parse(d);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function findingId(fingerprint) {
  const s = String(fingerprint || '');
  if (/^f-[0-9a-f]{12}$/.test(s)) return s;
  return `f-${sha256(s).slice(0, 12)}`;
}

function cleanFinding(f) {
  if (!f) return null;
  const out = { id: findingId(f.id || f.fingerprint), severity: cleanSeverity(f.severity), status: STATUSES.includes(f.status) ? f.status : 'open' };
  const title = cleanText(f.title, 300);
  if (title) out.title = title;
  const loc = cleanLocation(f.location);
  if (loc) out.location = loc;
  return out;
}

// Build a clean, unsigned entry body from raw input. Throws when the result
// would still hold anything that looks like a secret.
function cleanEntry(input, opts = {}) {
  if (!KINDS.includes(input.kind)) throw new Error(`unknown record kind: ${input.kind}`);
  const at = cleanDate(input.at) || new Date().toISOString();
  const body = {
    kind: input.kind,
    at,
    summary: cleanText(input.summary, 500) || `Sentinel ran a ${KIND_WORDS[input.kind]}.`,
    counts: cleanCounts(input.counts),
    findings: (Array.isArray(input.findings) ? input.findings : []).slice(0, MAX_FINDINGS).map(cleanFinding).filter(Boolean),
    exam_version: /^[a-z0-9 +._-]{1,80}$/i.test(String(input.exam_version || '')) ? String(input.exam_version) : examVersion(),
    atris_version: /^[0-9A-Za-z.+-]{1,40}$/.test(String(input.atris_version || '')) ? String(input.atris_version) : atrisVersion(),
  };
  if (input.backfilled) { body.backfilled = true; body.recorded_at = cleanDate(opts.now) || new Date().toISOString(); }
  if (/^run-\d{1,6}$/.test(String(input.source_run || ''))) body.source_run = String(input.source_run);
  if (['project', 'project and home'].includes(input.scope)) body.scope = input.scope;
  if (cloud().strictSecretHit(canonical(body).replace(/[{}[\]",]/g, '\n'))) throw new Error('an entry looked like it held a secret. it was not written');
  return body;
}

let cachedExam = null;
function examVersion() {
  if (cachedExam) return cachedExam;
  const root = path.join(__dirname, '..');
  let rules = 'none';
  try { rules = sha256Bytes(fs.readFileSync(path.join(root, 'lib', 'sentinel-rules.json'))).slice(0, 12); } catch {}
  let exam = '';
  try {
    const dir = path.join(root, 'atris', 'sentinel-bench');
    const h = crypto.createHash('sha256');
    const names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort();
    for (const n of names) h.update(n).update(fs.readFileSync(path.join(dir, n)));
    if (names.length) exam = ` exam-${h.digest('hex').slice(0, 12)}`;
  } catch {}
  cachedExam = `rules-${rules}${exam}`;
  return cachedExam;
}

function atrisVersion() {
  try { return require('../package.json').version; } catch { return 'unknown'; }
}

// ---------------------------------------------------------------- read and append

function readEntries(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    out.push(JSON.parse(line));
  }
  return out;
}

function withLock(file, fn) {
  const lock = `${file}.lock`;
  const start = Date.now();
  for (;;) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30000) { fs.unlinkSync(lock); continue; } } catch {}
      if (Date.now() - start > 5000) throw new Error('the record is busy. another sentinel command is writing to it');
      const until = Date.now() + 25; while (Date.now() < until) { /* short wait */ }
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(lock); } catch {} }
}

function sealEntry(body, prev, seq, key) {
  const unsigned = { ...body, seq, prev };
  const hash = sha256(canonical(unsigned));
  return { ...unsigned, hash, sig: signText(hash, key.privateKey) };
}

// Append one entry. Returns the written entry.
function append(root, input, opts = {}) {
  const project = opts.project || projectName(root);
  const file = recordPath(root, { ...opts, project });
  const body = cleanEntry(input, opts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withLock(file, () => {
    const key = loadKey(project, opts);
    const entries = readEntries(file);
    const last = entries[entries.length - 1];
    const entry = sealEntry(body, last ? last.hash : ZERO_HASH, entries.length + 1, key);
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return entry;
  });
}

// The hook every sentinel command calls. Never throws. Off inside node
// --test unless the test names its own record home.
function appendSafe(root, input, opts = {}) {
  if (opts.record === false) return { ok: true, skipped: true };
  const env = opts.env || process.env;
  if ((process.env.NODE_TEST_CONTEXT || env.ATRIS_SENTINEL_RECORD === 'off') && !opts.recordHome) return { ok: true, skipped: true };
  try {
    const list = Array.isArray(input) ? input : [input];
    const written = list.map((x) => append(root, x, opts));
    return { ok: true, entries: written };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e).split('\n')[0] };
  }
}

function warnLine(res) {
  if (!res || res.ok) return '';
  return `  warning: could not add this to the security record: ${res.reason}. the check itself is done`;
}

// ---------------------------------------------------------------- entries from sentinel results

function runFindings(dir) {
  const read = (n) => { try { return JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { return null; } };
  const records = read('findings.json') || [];
  const waiting = (read('carried-pending.json') || []).filter((r) => r && r.verdict === 'confirmed' && !records.some((x) => x && x.fingerprint === r.fingerprint));
  const out = [];
  for (const r of [...records, ...waiting]) {
    if (!r || !['confirmed', 'fixed', 'needs_validation'].includes(r.verdict)) continue;
    const trace = Array.isArray(r.trace) ? r.trace : [];
    const sink = trace[trace.length - 1] || {};
    const loc = sink && typeof sink.file === 'string' ? `${sink.file}${Number.isInteger(sink.line) && sink.line > 0 ? `:${sink.line}` : ''}` : '';
    out.push({
      fingerprint: r.fingerprint,
      severity: (r.severity && r.severity.overall) || 'unrated',
      status: r.verdict === 'confirmed' ? 'open' : r.verdict,
      title: r.title,
      location: loc,
    });
  }
  return out;
}

function bySeverity(findings, status) {
  const out = {};
  for (const s of [...SEVERITIES, 'unrated']) out[s] = 0;
  for (const f of findings) if (f.status === status) out[cleanSeverity(f.severity)] += 1;
  return out;
}

function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

// A review or recheck run folder as one entry.
function entryFromRun(dir, { backfilled = false } = {}) {
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'run-metadata.json'), 'utf8')); } catch {}
  if (!meta) throw new Error(`no run-metadata.json in ${dir}`);
  const kind = meta.mode === 'recheck' ? 'recheck' : 'review';
  const findings = runFindings(dir);
  const open = findings.filter((f) => f.status === 'open').length;
  const fixed = findings.filter((f) => f.status === 'fixed').length;
  const needs = findings.filter((f) => f.status === 'needs_validation').length;
  const cov = meta.coverage || {};
  const complete = meta.run_status === 'complete';
  const what = kind === 'recheck' ? 'Sentinel rechecked earlier findings against the current code' : 'Sentinel reviewed the project';
  let summary = `${what}. ${plural(open, 'problem is', 'problems are')} open`;
  if (fixed) summary += `. ${plural(fixed, 'problem was', 'problems were')} confirmed fixed`;
  if (needs) summary += `. ${plural(needs, 'possible problem needs', 'possible problems need')} a person to check`;
  summary += '.';
  if (!complete) summary += ' This run did not finish.';
  return {
    kind,
    at: meta.finished_at || meta.started_at,
    backfilled,
    source_run: meta.run_id || path.basename(dir),
    summary,
    counts: {
      open: bySeverity(findings, 'open'),
      fixed: bySeverity(findings, 'fixed'),
      needs_validation: needs,
      areas_in_scope: cleanCount(cov.in_scope),
      areas_done: cleanCount(cov.done),
      complete: complete ? 1 : 0,
    },
    findings,
    ...(backfilled ? { exam_version: 'not recorded at the time', atris_version: 'unknown' } : {}),
  };
}

// Ids still open from earlier snapshot checks of this kind and scope.
function openFromKind(root, kind, scope, opts) {
  let entries = [];
  try { entries = readEntries(recordPath(root, opts)); } catch { return new Map(); }
  const state = new Map();
  for (const e of entries) {
    if (e.kind !== kind || (scope && e.scope && e.scope !== scope)) continue;
    for (const f of e.findings || []) state.set(f.id, f);
  }
  return new Map([...state].filter(([, f]) => f.status === 'open'));
}

function entryFromAgents(root, result, opts = {}) {
  const scope = result.home ? 'project and home' : 'project';
  const now = (result.findings || []).map((f) => ({ fingerprint: f.fingerprint, severity: f.severity, status: 'open', title: f.title, location: f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : '' }));
  const seen = new Set(now.map((f) => findingId(f.fingerprint)));
  const gone = [...openFromKind(root, 'agent_check', scope, opts).values()].filter((f) => !seen.has(f.id)).map((f) => ({ ...f, status: 'fixed' }));
  let summary = `Sentinel checked the agent setup in this ${scope === 'project' ? 'project' : 'project and the home folder'}. The grade is ${result.grade}. ${plural(now.length, 'problem is', 'problems are')} open.`;
  if (gone.length) summary += ` ${plural(gone.length, 'earlier problem is', 'earlier problems are')} no longer found.`;
  return { kind: 'agent_check', scope, summary, counts: { open: bySeverity(now, 'open'), fixed: bySeverity(gone, 'fixed'), files: cleanCount(result.files) }, findings: [...now, ...gone] };
}

function entryFromWatch(root, result, { branch = null, ...opts } = {}) {
  if (result.offline) {
    return { kind: 'watch', summary: 'Sentinel could not reach the known attacks database this time. Nothing was checked.', counts: { complete: 0 }, findings: [] };
  }
  const now = [];
  const seenIds = new Set();
  for (const a of result.affected || []) {
    const id = findingId(require('./sentinel-events').fingerprint('threat', a.ecosystem, a.name, a.version));
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    now.push({ id, severity: a.severity, status: 'open', location: a.lockfile || '' });
  }
  // Gone counts as fixed only after a full read on the default branch.
  const full = !result.incomplete && (!branch || branch.onDefault);
  const gone = full ? [...openFromKind(root, 'watch', null, opts).values()].filter((f) => !seenIds.has(f.id)).map((f) => ({ ...f, status: 'fixed' })) : [];
  let summary = `Sentinel checked ${plural((result.lockfiles || []).length, 'lockfile', 'lockfiles')} against known attacks. ${plural(now.length, 'affected package is', 'affected packages are')} open.`;
  if (gone.length) summary += ` ${plural(gone.length, 'earlier threat is', 'earlier threats are')} no longer found.`;
  if (result.incomplete) summary += ' Some lockfiles were not read.';
  return { kind: 'watch', summary, counts: { open: bySeverity(now, 'open'), fixed: bySeverity(gone, 'fixed'), lockfiles: (result.lockfiles || []).length, complete: result.incomplete ? 0 : 1 }, findings: [...now, ...gone] };
}

// Guard blocks for this project since the last guard entry. Counts only.
function entryFromGuard(root, opts = {}) {
  const env = opts.env || process.env;
  const project = opts.project || projectName(root);
  let entries = [];
  try { entries = readEntries(recordPath(root, { ...opts, project })); } catch {}
  const lastGuard = [...entries].reverse().find((e) => e.kind === 'guard');
  const since = lastGuard ? Date.parse(lastGuard.at) : 0;
  const now = opts.now ? Date.parse(opts.now) : Date.now();
  let text = '';
  try { text = fs.readFileSync(path.join(homeOf({ ...opts, env }), '.atris', 'sentinel', 'guard.log'), 'utf8'); } catch {}
  const byRule = {};
  let total = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const t = Date.parse(r.at);
    if (!Number.isFinite(t) || t <= since || t > now) continue;
    if (r.repo && r.repo !== project) continue;
    const rule = /^[a-z][a-z0-9-]{0,39}$/.test(String(r.rule || '')) ? r.rule : 'other';
    byRule[rule] = (byRule[rule] || 0) + 1;
    total += 1;
  }
  const window = lastGuard ? 'since the last guard summary' : 'in its log';
  return { kind: 'guard', at: new Date(now).toISOString(), summary: `The sentinel guard stopped ${plural(total, 'agent action', 'agent actions')} in this project ${window}.`, counts: { blocked: total, blocked_by_rule: byRule }, findings: [] };
}

function entryFromFix(record, res) {
  const sev = record.severity && record.severity.overall;
  return {
    kind: 'fix',
    summary: res.ok
      ? 'Sentinel prepared a fix on its own branch. The new test failed on the old code and passes with the fix. It stays open until a recheck confirms it.'
      : 'Sentinel tried to prepare a fix and no fix was committed.',
    counts: { prepared: res.ok ? 1 : 0 },
    findings: [{ fingerprint: record.fingerprint, severity: sev, status: res.ok ? 'fix_prepared' : 'open', title: record.title }],
  };
}

// Past review runs not yet in the record, oldest first, marked backfilled.
function backfill(root, opts = {}) {
  const project = opts.project || projectName(root);
  const dir = path.join(auditHome(opts), project);
  let names = [];
  try { names = fs.readdirSync(dir); } catch {}
  const runs = names.map((n) => ({ n, m: n.match(/^run-(\d+)$/) })).filter((x) => x.m).sort((a, b) => Number(a.m[1]) - Number(b.m[1]));
  const have = new Set(readEntries(recordPath(root, { ...opts, project })).map((e) => e.source_run).filter(Boolean));
  const added = [];
  const skipped = [];
  for (const r of runs) {
    if (have.has(r.n)) { skipped.push(r.n); continue; }
    let input;
    try { input = entryFromRun(path.join(dir, r.n), { backfilled: true }); } catch (e) { skipped.push(r.n); continue; }
    added.push(append(root, input, { ...opts, project }));
  }
  return { added, skipped };
}

// ---------------------------------------------------------------- summary

function summarize(entries) {
  const sorted = entries.map((e, i) => ({ e, i })).sort((a, b) => (Date.parse(a.e.at) - Date.parse(b.e.at)) || (a.i - b.i)).map((x) => x.e);
  const checks = {};
  for (const k of KINDS) checks[k] = 0;
  const state = new Map();
  const guard = { blocked: 0, by_rule: {} };
  let backfilled = 0;
  for (const e of sorted) {
    checks[e.kind] = (checks[e.kind] || 0) + 1;
    if (e.backfilled) backfilled += 1;
    if (e.kind === 'guard') {
      guard.blocked += cleanCount(e.counts && e.counts.blocked);
      for (const [r, n] of Object.entries((e.counts && e.counts.blocked_by_rule) || {})) guard.by_rule[r] = (guard.by_rule[r] || 0) + cleanCount(n);
    }
    for (const f of e.findings || []) {
      const s = state.get(f.id) || { id: f.id, severity: f.severity, status: null, first_open: null, fixed_at: null, title: f.title || '', location: f.location || '', kind: e.kind };
      if (f.severity && f.severity !== 'unrated') s.severity = f.severity;
      if (f.title) s.title = f.title;
      if (f.location) s.location = f.location;
      if (f.status === 'fix_prepared') { s.fix_prepared = e.at; if (!s.status) s.status = 'open'; }
      else {
        if ((f.status === 'open' || f.status === 'needs_validation') && !s.first_open) s.first_open = e.at;
        if (f.status === 'fixed' && s.status !== 'fixed') s.fixed_at = e.at;
        if (f.status !== 'fixed') s.fixed_at = null;
        s.status = f.status;
      }
      state.set(f.id, s);
    }
  }
  const open = {}; const fixed = {};
  for (const s of [...SEVERITIES, 'unrated']) { open[s] = 0; fixed[s] = 0; }
  const fixedList = [];
  let needs = 0;
  for (const s of state.values()) {
    if (s.status === 'open') open[s.severity] = (open[s.severity] || 0) + 1;
    else if (s.status === 'needs_validation') needs += 1;
    else if (s.status === 'fixed') {
      fixed[s.severity] = (fixed[s.severity] || 0) + 1;
      fixedList.push({ ...s, open_ms: s.first_open && s.fixed_at ? Math.max(0, Date.parse(s.fixed_at) - Date.parse(s.first_open)) : null });
    }
  }
  const last = sorted[sorted.length - 1] || null;
  return { total: entries.length, checks, backfilled, last: last ? { kind: last.kind, at: last.at } : null, first: sorted[0] ? sorted[0].at : null, open, fixed, needs_validation: needs, fixed_list: fixedList, guard, findings: [...state.values()] };
}

function duration(ms) {
  if (ms == null) return 'unknown';
  const h = ms / 3600000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60000))} min`;
  if (h < 48) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} days`;
}

function sevLine(counts) {
  return SEVERITIES.map((s) => `${counts[s] || 0} ${s}`).join(', ') + (counts.unrated ? `, ${counts.unrated} unrated` : '');
}

function renderShow(project, entries, key) {
  const s = summarize(entries);
  const L = [''];
  L.push(`  sentinel security record for ${project}`);
  if (key) L.push(`  signed with key ${key.fingerprint}`);
  L.push('');
  if (!entries.length) { L.push('  no entries yet. run atris sentinel or atris sentinel record backfill'); L.push(''); return L.join('\n'); }
  const ran = KINDS.filter((k) => s.checks[k]).map((k) => `${s.checks[k]} ${KIND_WORDS[k]}${s.checks[k] === 1 ? '' : 's'}`).join(', ');
  L.push(`  checks run: ${ran}`);
  if (s.backfilled) L.push(`  ${s.backfilled} of them were added later from past runs, with their original dates`);
  L.push(`  last check: ${KIND_WORDS[s.last.kind]} on ${s.last.at.slice(0, 16).replace('T', ' ')} utc`);
  L.push(`  open: ${sevLine(s.open)}`);
  if (s.needs_validation) L.push(`  waiting for a person to check: ${s.needs_validation}`);
  L.push(`  fixed: ${sevLine(s.fixed)}`);
  for (const f of s.fixed_list) L.push(`    ${f.severity} ${f.location || f.id} stayed open ${duration(f.open_ms)}`);
  const rules = Object.entries(s.guard.by_rule);
  L.push(`  guard: stopped ${plural(s.guard.blocked, 'action', 'actions')}${rules.length ? ` (${rules.map(([r, n]) => `${r} ${n}`).join(', ')})` : ''}`);
  L.push('');
  return L.join('\n');
}

// ---------------------------------------------------------------- export

function buildExport(root, opts = {}) {
  const project = opts.project || projectName(root);
  const entries = readEntries(recordPath(root, { ...opts, project }));
  const key = loadKey(project, opts);
  const exported = cleanDate(opts.now) || new Date().toISOString();
  const head = { project, count: entries.length, last_hash: entries.length ? entries[entries.length - 1].hash : ZERO_HASH, exported_at: exported };
  const headHash = sha256(canonical(head));
  return {
    format: FORMAT,
    format_version: FORMAT_VERSION,
    project,
    public_key: key.publicKey,
    key_fingerprint: key.fingerprint,
    algorithm: 'Ed25519 over the SHA-256 hex of each entry in sorted-key JSON',
    guarantee: 'The signature proves this record came from the holder of this key and was not edited, reordered or cut since. It does not prove the checks were thorough or that the code is safe.',
    head: { ...head, hash: headHash, sig: signText(headHash, key.privateKey) },
    entries,
  };
}

// ---------------------------------------------------------------- verify (node)

function brokenAt(i, entries, code, reason) {
  const e = entries[i];
  const what = e && KIND_WORDS[e.kind] ? `${KIND_WORDS[e.kind]}${e.at ? ` from ${String(e.at).slice(0, 10)}` : ''}` : 'entry';
  return { ok: false, index: i, entry: i + 1, code, reason, label: `entry ${i + 1} (${what})` };
}

// The CLI check. Written apart from the browser one on purpose. The tests
// run both on the same files and expect the same answer.
function verifyDoc(doc) {
  if (!doc || doc.format !== FORMAT || !Array.isArray(doc.entries) || !doc.head) return { ok: false, index: -1, entry: 0, code: 'format', reason: 'this is not an atris sentinel record', label: 'the file' };
  let pub;
  try {
    const raw = fromB64url(doc.public_key);
    if (raw.length !== 32) throw new Error('bad key');
    pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: doc.public_key }, format: 'jwk' });
  } catch { return { ok: false, index: -1, entry: 0, code: 'key', reason: 'the public key is not a valid ed25519 key', label: 'the key' }; }
  if (keyFingerprint(doc.public_key) !== doc.key_fingerprint) return { ok: false, index: -1, entry: 0, code: 'key', reason: 'the key fingerprint does not match the public key', label: 'the key' };
  const entries = doc.entries;
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (!e || typeof e !== 'object') return brokenAt(i, entries, 'format', 'it is not a record entry');
    if (e.seq !== i + 1) return brokenAt(i, entries, 'seq', `it says it is entry ${e.seq}. entries were removed, added or moved`);
    const prev = i === 0 ? ZERO_HASH : entries[i - 1].hash;
    if (e.prev !== prev) return brokenAt(i, entries, 'prev', 'it does not point to the entry before it');
    const { hash, sig, ...body } = e;
    if (sha256(canonical(body)) !== hash) return brokenAt(i, entries, 'hash', 'its contents were changed after it was written');
    let good = false;
    try { good = crypto.verify(null, Buffer.from(String(hash), 'utf8'), pub, fromB64url(sig)); } catch {}
    if (!good) return brokenAt(i, entries, 'signature', 'its signature does not match this key');
  }
  const { hash: hh, sig: hs, ...head } = doc.head;
  const last = entries.length ? entries[entries.length - 1].hash : ZERO_HASH;
  let headOk = sha256(canonical(head)) === hh;
  if (headOk) { try { headOk = crypto.verify(null, Buffer.from(String(hh), 'utf8'), pub, fromB64url(hs)); } catch { headOk = false; } }
  if (!headOk || head.count !== entries.length || head.last_hash !== last || head.project !== doc.project) {
    return { ok: false, index: entries.length, entry: entries.length, code: 'head', reason: `the signed head lists ${head.count} entries ending in a different entry. entries were cut from the end or the head was changed`, label: 'the end of the record' };
  }
  return { ok: true, entries: entries.length, fingerprint: doc.key_fingerprint };
}

// ---------------------------------------------------------------- verify (browser)

// Runs in the exported page with WebCrypto. Self-contained on purpose: the
// page embeds this function's source. Tests run it in Node's WebCrypto.
async function browserVerify(doc, subtle) {
  const ZERO = '0000000000000000000000000000000000000000000000000000000000000000';
  const WORDS = { review: 'review', recheck: 'recheck', agent_check: 'agent check', watch: 'dependency watch', guard: 'guard summary', fix: 'fix' };
  const enc = new TextEncoder();
  const canon = (v) => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  };
  const hex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  const sha = async (text) => hex(await subtle.digest('SHA-256', enc.encode(text)));
  const unb64 = (s) => {
    const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(t + '==='.slice((t.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  };
  const broken = (i, entries, code, reason) => {
    const e = entries[i];
    const what = e && WORDS[e.kind] ? WORDS[e.kind] + (e.at ? ' from ' + String(e.at).slice(0, 10) : '') : 'entry';
    return { ok: false, index: i, entry: i + 1, code, reason, label: 'entry ' + (i + 1) + ' (' + what + ')' };
  };
  if (!doc || doc.format !== 'atris-sentinel-record' || !Array.isArray(doc.entries) || !doc.head) return { ok: false, index: -1, entry: 0, code: 'format', reason: 'this is not an atris sentinel record', label: 'the file' };
  let key; let raw;
  try {
    raw = unb64(doc.public_key);
    if (raw.length !== 32) throw new Error('bad key');
    key = await subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
  } catch (e) { return { ok: false, index: -1, entry: 0, code: 'key', reason: 'the public key is not a valid ed25519 key', label: 'the key' }; }
  const fp = hex(await subtle.digest('SHA-256', raw)).slice(0, 32).match(/.{4}/g).join(' ');
  if (fp !== doc.key_fingerprint) return { ok: false, index: -1, entry: 0, code: 'key', reason: 'the key fingerprint does not match the public key', label: 'the key' };
  const check = async (hash, sig) => { try { return await subtle.verify({ name: 'Ed25519' }, key, unb64(sig), enc.encode(String(hash))); } catch (e) { return false; } };
  const entries = doc.entries;
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (!e || typeof e !== 'object') return broken(i, entries, 'format', 'it is not a record entry');
    if (e.seq !== i + 1) return broken(i, entries, 'seq', 'it says it is entry ' + e.seq + '. entries were removed, added or moved');
    const prev = i === 0 ? ZERO : entries[i - 1].hash;
    if (e.prev !== prev) return broken(i, entries, 'prev', 'it does not point to the entry before it');
    const body = {};
    for (const k of Object.keys(e)) if (k !== 'hash' && k !== 'sig') body[k] = e[k];
    if (await sha(canon(body)) !== e.hash) return broken(i, entries, 'hash', 'its contents were changed after it was written');
    if (!(await check(e.hash, e.sig))) return broken(i, entries, 'signature', 'its signature does not match this key');
  }
  const head = {};
  for (const k of Object.keys(doc.head)) if (k !== 'hash' && k !== 'sig') head[k] = doc.head[k];
  const last = entries.length ? entries[entries.length - 1].hash : ZERO;
  let headOk = (await sha(canon(head))) === doc.head.hash;
  if (headOk) headOk = await check(doc.head.hash, doc.head.sig);
  if (!headOk || head.count !== entries.length || head.last_hash !== last || head.project !== doc.project) {
    return { ok: false, index: entries.length, entry: entries.length, code: 'head', reason: 'the signed head lists ' + head.count + ' entries ending in a different entry. entries were cut from the end or the head was changed', label: 'the end of the record' };
  }
  return { ok: true, entries: entries.length, fingerprint: doc.key_fingerprint };
}

// ---------------------------------------------------------------- html

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderHtml(doc) {
  const s = summarize(doc.entries);
  const date = (d) => (d ? esc(String(d).slice(0, 16).replace('T', ' ')) + ' utc' : 'unknown');
  const sevCells = (counts) => SEVERITIES.map((k) => `<td>${counts[k] || 0}</td>`).join('');
  const ran = KINDS.filter((k) => s.checks[k]).map((k) => `${s.checks[k]} ${esc(KIND_WORDS[k])}${s.checks[k] === 1 ? '' : 's'}`).join(', ') || 'none yet';
  const fixedRows = s.fixed_list.map((f) => `<tr><td>${esc(f.severity)}</td><td>${esc(f.title || 'problem')}</td><td><code>${esc(f.location || f.id)}</code></td><td>${esc(duration(f.open_ms))}</td></tr>`).join('');
  const openRows = s.findings.filter((f) => f.status === 'open' || f.status === 'needs_validation').map((f) => `<tr><td>${esc(f.status === 'open' ? f.severity : 'needs a person')}</td><td>${esc(f.title || 'problem')}</td><td><code>${esc(f.location || f.id)}</code></td><td>${date(f.first_open)}</td></tr>`).join('');
  const rules = Object.entries(s.guard.by_rule).map(([r, n]) => `${esc(r)} ${n}`).join(', ');
  const timeline = [...doc.entries].reverse().map((e) => `<li id="e${e.seq}"><span class="when">${date(e.at)}</span> <span class="kind">${esc(KIND_WORDS[e.kind] || e.kind)}</span>${e.backfilled ? ' <span class="tag">added later from a past run</span>' : ''}<br>${esc(e.summary)}<br><span class="meta">entry ${e.seq} · atris ${esc(e.atris_version)} · ${esc(e.exam_version)} · hash <code>${esc(String(e.hash).slice(0, 16))}</code></span></li>`).join('\n');
  const json = JSON.stringify(doc).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<title>security record: ${esc(doc.project)}</title>
<style>
body{font:15px/1.5 -apple-system,system-ui,sans-serif;color:#1b1b1b;background:#fafaf8;margin:0;padding:32px;max-width:860px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}
.key{font:13px ui-monospace,monospace;background:#f0efea;padding:10px 12px;border-radius:6px;word-break:break-all}
#status{margin:16px 0;padding:12px 14px;border-radius:6px;font-weight:600;background:#eee}
#status.ok{background:#e3f1e5;color:#17532a}#status.bad{background:#f8e1df;color:#7a1d14}
table{border-collapse:collapse;width:100%;font-size:14px}td,th{border-bottom:1px solid #e3e1da;padding:6px 8px;text-align:left}
ul{list-style:none;padding:0}li{padding:10px 0;border-bottom:1px solid #e3e1da}li.broken{background:#f8e1df}
.when{color:#555}.kind{font-weight:600}.tag{font-size:12px;background:#f0efea;padding:1px 6px;border-radius:4px}.meta{font-size:12px;color:#666}
.small{font-size:13px;color:#555}
</style></head><body>
<h1>security record: ${esc(doc.project)}</h1>
<p class="small">exported ${date(doc.head.exported_at)} · ${doc.entries.length} entries · kept by atris sentinel</p>
<p>public key (ed25519):</p>
<div class="key">${esc(doc.public_key)}<br>fingerprint: <b>${esc(doc.key_fingerprint)}</b></div>
<p class="small">ask the company for its key fingerprint and check it matches the one above. a record signed with a different key proves nothing about them.</p>
<div id="status">checking the record in this browser...</div>
<h2>what this proves</h2>
<p>${esc(doc.guarantee)} Times come from the company's machine. Entries marked added later were written from past runs after the fact.</p>
<h2>summary</h2>
<p>checks run: ${ran}${s.backfilled ? ` (${s.backfilled} added later from past runs)` : ''}<br>
first check: ${date(s.first)}<br>last check: ${s.last ? `${esc(KIND_WORDS[s.last.kind])} on ${date(s.last.at)}` : 'none'}</p>
<table><tr><th></th>${SEVERITIES.map((k) => `<th>${k}</th>`).join('')}</tr>
<tr><td>open</td>${sevCells(s.open)}</tr><tr><td>fixed</td>${sevCells(s.fixed)}</tr></table>
${s.needs_validation ? `<p>${s.needs_validation} possible problem${s.needs_validation === 1 ? '' : 's'} wait for a person to check.</p>` : ''}
<p>guard: stopped ${s.guard.blocked} agent action${s.guard.blocked === 1 ? '' : 's'}${rules ? ` (${rules})` : ''}.</p>
${openRows ? `<h2>open</h2><table><tr><th>severity</th><th>problem</th><th>where</th><th>first seen</th></tr>${openRows}</table>` : ''}
${fixedRows ? `<h2>fixed</h2><table><tr><th>severity</th><th>problem</th><th>where</th><th>stayed open</th></tr>${fixedRows}</table>` : ''}
<h2>timeline</h2>
<ul>
${timeline}
</ul>
<p class="small">check it offline with the atris cli: atris sentinel record verify FILE</p>
<script type="application/json" id="record">${json}</script>
<script>
${browserVerify.toString()}
(async function () {
  var el = document.getElementById('status');
  var doc = JSON.parse(document.getElementById('record').textContent);
  if (!(window.crypto && window.crypto.subtle)) { el.textContent = 'this browser cannot check signatures here. run atris sentinel record verify on the file'; return; }
  try {
    var r = await browserVerify(doc, window.crypto.subtle);
    if (r.ok) { el.className = 'ok'; el.textContent = 'verified: all ' + r.entries + ' entries are signed by key ' + r.fingerprint + ' and none were changed, moved or removed'; }
    else {
      el.className = 'bad'; el.textContent = 'broken at ' + r.label + ': ' + r.reason;
      var li = document.getElementById('e' + r.entry); if (li) li.className = 'broken';
    }
  } catch (e) { el.textContent = 'this browser could not check ed25519 signatures. run atris sentinel record verify on the file'; }
})();
</script>
</body></html>
`;
}

// Read an exported file: json, or the html with the record inside.
function readExport(file) {
  const text = fs.readFileSync(file, 'utf8');
  const t = text.trim();
  if (t.startsWith('{')) return JSON.parse(t);
  const m = text.match(/<script type="application\/json" id="record">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no record found in this file');
  return JSON.parse(m[1]);
}

module.exports = {
  FORMAT,
  ZERO_HASH,
  KINDS,
  canonical,
  recordPath,
  keyPath,
  projectName,
  loadKey,
  keyFingerprint,
  cleanEntry,
  append,
  appendSafe,
  warnLine,
  readEntries,
  entryFromRun,
  entryFromAgents,
  entryFromWatch,
  entryFromGuard,
  entryFromFix,
  backfill,
  summarize,
  renderShow,
  buildExport,
  verifyDoc,
  browserVerify,
  renderHtml,
  readExport,
  examVersion,
};
