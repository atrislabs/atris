'use strict';

// atris sentinel bench: a fixed exam for the sentinel. It is the judge in
// `atris sentinel improve`. It is deterministic and never asks a model,
// apart from the opt-in review set that runs the real audit on engines.
//
//   guard    shell commands an agent might run. attacks should block,
//            everyday commands should run. scores: attacks blocked and
//            everyday commands wrongly blocked
//   agents   small agent setups with planted problems and clean controls.
//            scores: planted problems found and false alarms
//   review   tiny seeded repos with planted holes and clean look-alikes,
//            scored by running the audit. scores: holes found, false
//            findings and engine calls used. opt-in (--review), it costs
//            engine time
//
// Every set has two halves. The seen half lives in the repo at
// atris/sentinel-bench/<set>.jsonl. The held-out half lives on this machine
// at ~/.atris/sentinel-holdout/<set>.jsonl. An agent working in the
// checkout never reads it. Held-out items are scored but never printed or
// put in --json output: only their totals leave this module.
//
// Fixtures hold no real secrets. A value like {{fake:github}} becomes a
// token-shaped string at load time, built from parts. The files in the
// repo pass the security scan.

const fs = require('fs');
const os = require('os');
const path = require('path');

const SETS = ['guard', 'agents', 'review'];

function homeDir(env = process.env) {
  return env.HOME || os.homedir();
}

function defaultHoldoutDir(env = process.env) {
  return env.ATRIS_SENTINEL_HOLDOUT || path.join(homeDir(env), '.atris', 'sentinel-holdout');
}

function seenDirOf(root) {
  return path.join(root, 'atris', 'sentinel-bench');
}

// ---------------------------------------------------------------- fixtures

// Token-shaped values, built at runtime so no file in the repo holds one.
// The letters avoid every placeholder word the scanner skips.
const FAKE = {
  github: ['gh', 'p_', 'Qw7Rt2Yu9Ip4As6Df1Gh3Jk8Lz5Xc0Vb2Nm7Q'].join(''),
  aws: ['AK', 'IA', 'QW7RT2YU9IP4AS6D'].join(''),
  openai: ['sk-', 'proj-', 'Qw7Rt2Yu9Ip4As6Df1Gh3Jk8Lz5Xc0Vb2Nm7Qa4'].join(''),
  anthropic: ['sk-', 'ant-', 'api03-Qw7Rt2Yu9Ip4As6Df1Gh3Jk8Lz5Xc0'].join(''),
  stripe: ['sk', '_live_', 'Qw7Rt2Yu9Ip4As6Df1Gh3Jk8Lz'].join(''),
  slack: ['xo', 'xb-', '2048170955-Qw7Rt2Yu9Ip4As6Df1Gh3Jk'].join(''),
  value: ['Zk3pQ9vL', '2mX8rT5w', 'N7bH4cJ6'].join(''),
};

function expand(value) {
  if (typeof value === 'string') return value.replace(/\{\{fake:([a-z]+)\}\}/g, (m, name) => (FAKE[name] !== undefined ? FAKE[name] : m));
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)]));
  return value;
}

// One item per line. Bad lines are counted, not fatal.
function readItems(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { items: [], invalid: 0, missing: true }; }
  return parseItems(text);
}

function parseItems(text) {
  const items = [];
  let invalid = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item && typeof item === 'object' && typeof item.id === 'string') items.push(item);
      else invalid += 1;
    } catch { invalid += 1; }
  }
  return { items, invalid, missing: false };
}

function validItem(set, item) {
  if (!item || typeof item.id !== 'string' || !item.id) return false;
  if (set === 'guard') return (item.expect === 'block' || item.expect === 'allow') && (typeof item.command === 'string' || (item.input && typeof item.input === 'object'));
  if (set === 'agents') return item.files && typeof item.files === 'object' && Array.isArray(item.expect);
  if (set === 'review') return item.files && typeof item.files === 'object' && Array.isArray(item.holes);
  return false;
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const clean = path.normalize(rel);
    if (path.isAbsolute(clean) || clean.startsWith('..')) throw new Error(`fixture path leaves its folder: ${rel}`);
    const file = path.join(dir, clean);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
}

// ---------------------------------------------------------------- code under test

// What is judged is data: the rules file of the target checkout. The code
// that applies the rules always comes from the atris that runs the exam, so
// no JavaScript from a proposal ever runs here.
function loadRules(target) {
  const file = path.join(path.resolve(target), 'lib', 'sentinel-rules.json');
  let rules;
  try { rules = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`could not read the rules file: ${String(e.message).split('\n')[0]}`); }
  const problems = require('./sentinel-rules').validateRules(rules);
  if (problems.length) throw new Error(`the rules file is not valid: ${problems.slice(0, 3).join('; ')}`);
  return rules;
}

// ---------------------------------------------------------------- sealing

// Held-out files are encrypted at rest (aes-256-gcm). A stray read gets
// ciphertext. The key lives in the macOS keychain, or in a 0600 file under
// ~/.atris/sentinel-judge when there is no keychain. Only this process,
// the judge, asks for it.
const SEALED = '.jsonl.sealed';
const KEYCHAIN_SERVICE = 'atris-sentinel-holdout';

function keyFromFile(file) {
  try {
    const hex = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  } catch {}
  const hex = require('crypto').randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${hex}\n`, { mode: 0o600, flag: 'wx' });
  return Buffer.from(hex, 'hex');
}

function keyFromKeychain() {
  const { spawnSync } = require('child_process');
  const read = () => {
    const r = spawnSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'atris', '-w'], { encoding: 'utf8', timeout: 10000 });
    const hex = String(r.stdout || '').trim();
    return r.status === 0 && /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null;
  };
  const have = read();
  if (have) return have;
  const hex = require('crypto').randomBytes(32).toString('hex');
  const add = spawnSync('security', ['add-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'atris', '-w', hex], { encoding: 'utf8', timeout: 10000 });
  return add.status === 0 ? read() : null;
}

// Where the last key came from: 'keychain' or 'file'. The night run asks
// for this in the report and refuses a file key: a reviewer that can read
// files could read a key file too.
let lastKeySource = null;

function holdoutKey(env = process.env) {
  if (env.ATRIS_SENTINEL_KEY_FILE) { lastKeySource = 'file'; return keyFromFile(env.ATRIS_SENTINEL_KEY_FILE); }
  if (process.platform === 'darwin' && env.ATRIS_SENTINEL_KEYCHAIN !== '0') {
    const k = keyFromKeychain();
    if (k) { lastKeySource = 'keychain'; return k; }
  }
  lastKeySource = 'file';
  return keyFromFile(path.join(homeDir(env), '.atris', 'sentinel-judge', 'holdout.key'));
}

function seal(text, key) {
  const crypto = require('crypto');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `${JSON.stringify({ sealed: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') })}\n`;
}

function unseal(raw, key) {
  const crypto = require('crypto');
  const box = JSON.parse(raw);
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  d.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8');
}

// The held-out items of one set, as text. A plain file left from before
// sealing is sealed in place first.
function readHeldText(dir, set, env) {
  const plain = path.join(dir, `${set}.jsonl`);
  const sealed = path.join(dir, `${set}${SEALED}`);
  if (!fs.existsSync(plain) && !fs.existsSync(sealed)) return null;
  const key = holdoutKey(env);
  if (fs.existsSync(plain)) {
    let text = fs.readFileSync(plain, 'utf8');
    if (fs.existsSync(sealed)) text = unseal(fs.readFileSync(sealed, 'utf8'), key) + text;
    fs.writeFileSync(sealed, seal(text, key), { mode: 0o600 });
    if (unseal(fs.readFileSync(sealed, 'utf8'), key) === text) fs.unlinkSync(plain);
  }
  if (!fs.existsSync(sealed)) return null;
  return unseal(fs.readFileSync(sealed, 'utf8'), key);
}

function writeHeldText(dir, set, text, env) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, `${set}${SEALED}`), seal(text, holdoutKey(env)), { mode: 0o600 });
}

// Sealed split sources. Their paths are kept so the exam can report them and
// the improver can deny an engine reads there. The list holds paths only.
function sourcesFile(dir) {
  return path.join(dir, 'sealed-sources.json');
}

function readSealedSources(dir) {
  try { const v = JSON.parse(fs.readFileSync(sourcesFile(dir), 'utf8')); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
}

function registerSealedSource(file, dir) {
  const abs = path.resolve(file);
  const list = [...new Set([...readSealedSources(dir), abs])].sort();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(sourcesFile(dir), `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
  return abs;
}

// The git top level above a path, or null when it is not in a repo.
function repoRootOf(file) {
  try {
    const { execFileSync } = require('child_process');
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: path.dirname(path.resolve(file)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

// ---------------------------------------------------------------- scoring

function scoreGuard(items, guardMod, rules = null) {
  // An empty home: the guard reads no config from this machine and the
  // score is the same everywhere.
  const home = tmpDir('atris-sentinel-bench-home-');
  const env = { HOME: home, PATH: process.env.PATH || '' };
  const results = [];
  try {
    for (const raw of items) {
      const item = expand(raw);
      const tool = item.tool || 'Bash';
      const input = item.input || { command: item.command };
      let got = 'allow';
      let rule = '';
      try {
        const d = guardMod.decide({ tool_name: tool, tool_input: input, cwd: item.cwd || '/tmp/project' }, { env, gitBranch: () => item.branch || 'feature', ...(rules ? { rules } : {}) });
        if (d && d.allow === false) { got = 'block'; rule = d.rule || ''; }
      } catch (e) { got = 'error'; rule = String(e.message || e).slice(0, 80); }
      const attack = item.expect === 'block';
      results.push({ id: raw.id, kind: item.kind || (attack ? 'attack' : 'benign'), expect: item.expect, got, rule, ok: got === item.expect });
    }
  } finally { rmDir(home); }
  const attacks = results.filter((r) => r.expect === 'block');
  const benign = results.filter((r) => r.expect === 'allow');
  const byKind = {};
  for (const r of results) {
    const k = r.kind;
    byKind[k] = byKind[k] || { total: 0, ok: 0 };
    byKind[k].total += 1;
    if (r.ok) byKind[k].ok += 1;
  }
  return {
    items: results.length,
    attacks: attacks.length,
    blocked: attacks.filter((r) => r.got === 'block').length,
    benign: benign.length,
    false_blocks: benign.filter((r) => r.got !== 'allow').length,
    errors: results.filter((r) => r.got === 'error').length,
    by_kind: byKind,
    results,
  };
}

function scoreAgents(items, agentsMod, rules = null) {
  const home = tmpDir('atris-sentinel-bench-home-');
  const results = [];
  try {
    for (const raw of items) {
      const item = expand(raw);
      const dir = tmpDir('atris-sentinel-bench-agents-');
      let findings = [];
      let error = '';
      try {
        writeFiles(dir, item.files);
        findings = agentsMod.runAgentCheck(dir, { home: false, homeDir: home, ...(rules ? { rules } : {}) }).findings || [];
      } catch (e) { error = String(e.message || e).slice(0, 80); }
      finally { rmDir(dir); }
      const expected = [...new Set(item.expect)];
      const gotRules = new Set(findings.map((f) => f.rule));
      const found = expected.filter((r) => gotRules.has(r));
      const falseAlarms = findings.filter((f) => !expected.includes(f.rule));
      results.push({
        id: raw.id,
        kind: expected.length ? 'planted' : 'clean',
        expected,
        found: found.length,
        missed: expected.filter((r) => !gotRules.has(r)),
        false_alarms: falseAlarms.map((f) => f.rule),
        error,
        ok: !error && found.length === expected.length && falseAlarms.length === 0,
      });
    }
  } finally { rmDir(home); }
  const planted = results.filter((r) => r.kind === 'planted');
  const clean = results.filter((r) => r.kind === 'clean');
  return {
    items: results.length,
    planted_items: planted.length,
    expected: planted.reduce((n, r) => n + r.expected.length, 0),
    found: planted.reduce((n, r) => n + r.found, 0),
    clean_items: clean.length,
    false_alarms: results.reduce((n, r) => n + r.false_alarms.length, 0),
    clean_items_flagged: clean.filter((r) => r.false_alarms.length > 0).length,
    errors: results.filter((r) => r.error).length,
    results,
  };
}

// A confirmed record lands on a file when its fingerprint or trace names it.
function recordFiles(record) {
  const files = new Set();
  const fp = String(record.fingerprint || '');
  if (fp.includes(':')) files.add(fp.split(':')[0]);
  for (const t of Array.isArray(record.trace) ? record.trace : []) {
    const f = String((t && (t.file || t.path)) || '').replace(/:\d+(?:-\d+)?$/, '');
    if (f) files.add(f);
  }
  return files;
}

async function scoreReview(items, auditMod, { hunter, verifier, profile = 'quick', budget, runJobs, log = () => {} } = {}) {
  const { execFileSync } = require('child_process');
  const results = [];
  let engineCalls = 0;
  let credits = 0;
  for (const raw of items) {
    const item = expand(raw);
    const dir = tmpDir('atris-sentinel-bench-review-');
    const out = tmpDir('atris-sentinel-bench-review-out-');
    let records = [];
    let error = '';
    try {
      writeFiles(dir, item.files);
      const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
      git(['init', '-q']);
      git(['add', '-A']);
      git(['-c', 'user.name=bench', '-c', 'user.email=bench@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture']);
      const res = await auditMod.runAudit({ root: dir, out, profile, hunter, verifier, ...(Number.isInteger(budget) ? { budget } : {}), ...(runJobs ? { runJobs } : {}), log });
      records = (res.records || []).filter((r) => r.verdict === 'confirmed');
      engineCalls += (res.meta && res.meta.invocations && res.meta.invocations.used) || 0;
      credits += Number((res.meta && res.meta.credits_used) || 0);
    } catch (e) { error = String(e.message || e).slice(0, 120); }
    finally { rmDir(dir); rmDir(out); }
    const holes = item.holes.map((h) => String(h.file));
    const hit = new Set();
    let falseFindings = 0;
    for (const r of records) {
      const files = recordFiles(r);
      const match = holes.filter((h) => files.has(h));
      if (match.length) match.forEach((h) => hit.add(h));
      else falseFindings += 1;
    }
    results.push({ id: raw.id, holes: holes.length, found: hit.size, false_findings: falseFindings, error, ok: !error && hit.size === holes.length && falseFindings === 0 });
  }
  return {
    items: results.length,
    repos: results.length,
    holes: results.reduce((n, r) => n + r.holes, 0),
    found: results.reduce((n, r) => n + r.found, 0),
    false_findings: results.reduce((n, r) => n + r.false_findings, 0),
    engine_calls: engineCalls,
    credits,
    errors: results.filter((r) => r.error).length,
    results,
  };
}

// ---------------------------------------------------------------- run

function loadSet(dir, set, { held = false, env = process.env } = {}) {
  let parsed;
  if (held) { const text = readHeldText(dir, set, env); parsed = text === null ? { items: [], invalid: 0, missing: true } : parseItems(text); }
  else parsed = readItems(path.join(dir, `${set}.jsonl`));
  const { items, invalid, missing } = parsed;
  const good = items.filter((i) => validItem(set, i));
  return { items: good, invalid: invalid + (items.length - good.length), missing };
}

// The full exam. Returns raw numbers per set and half. Held-out results
// stay in this object; publicReport() drops them before anything prints.
async function runBench({ target, seenDir, holdoutDir, sets = ['guard', 'agents'], review = null, env = process.env } = {}) {
  const root = path.resolve(target || process.cwd());
  const seen = path.resolve(seenDir || seenDirOf(root));
  const held = path.resolve(holdoutDir || defaultHoldoutDir(env));
  const rules = loadRules(root);
  const guardMod = require('./sentinel-guard');
  const agentsMod = require('./sentinel-agents');
  const want = sets.filter((s) => SETS.includes(s) && (s !== 'review' || review));
  const report = { target: root, sets: want, seen: {}, holdout: {}, holdout_missing: [], holdout_dir: held, sealed_sources: readSealedSources(held) };
  // Seal any plain held-out file, scored this run or not.
  for (const set of SETS) if (fs.existsSync(path.join(held, `${set}.jsonl`))) readHeldText(held, set, env);
  for (const half of ['seen', 'holdout']) {
    const dir = half === 'seen' ? seen : held;
    for (const set of want) {
      const loaded = loadSet(dir, set, { held: half === 'holdout', env });
      if (half === 'holdout' && (loaded.missing || !loaded.items.length)) { report.holdout_missing.push(set); continue; }
      let score;
      if (set === 'guard') score = scoreGuard(loaded.items, guardMod, rules);
      else if (set === 'agents') score = scoreAgents(loaded.items, agentsMod, rules);
      else score = await scoreReview(loaded.items, require('./security-audit'), review || {});
      score.invalid = loaded.invalid;
      report[half][set] = score;
    }
  }
  report.key_source = lastKeySource;
  return report;
}

// ---------------------------------------------------------------- screen

// Lowercase with whitespace collapsed, for overlap checks.
function normalizeText(v) {
  return String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function itemTexts(set, item) {
  if (set === 'guard') return [item.command !== undefined ? item.command : JSON.stringify(item.input || '')];
  return Object.entries(item.files || {}).map(([f, c]) => `${f} ${typeof c === 'string' ? c : JSON.stringify(c)}`).concat(Object.values(item.files || {}).map((c) => (typeof c === 'string' ? c : JSON.stringify(c))));
}

// New seen items proposed from outside (the night reviewer) checked against
// the held-out half. This runs in the judge, the one process that holds it. An item
// whose normalized text equals, contains or sits inside any held-out item's
// text is refused. Only the refused ids leave this function, never a
// held-out item. A held-out set that cannot be read refuses everything.
function screenItems(candidates, { holdoutDir, env = process.env } = {}) {
  const held = path.resolve(holdoutDir || defaultHoldoutDir(env));
  const texts = [];
  let unreadable = false;
  for (const set of ['guard', 'agents']) {
    try {
      const loaded = loadSet(held, set, { held: true, env });
      for (const item of loaded.items) for (const t of itemTexts(set, item)) { const n = normalizeText(t); if (n) texts.push(n); }
    } catch { unreadable = true; }
  }
  const refused = [];
  for (const c of candidates) {
    if (!c || typeof c.id !== 'string' || (c.set !== 'guard' && c.set !== 'agents')) continue;
    if (unreadable) { refused.push(c.id); continue; }
    const mine = itemTexts(c.set, c.item || {}).map(normalizeText).filter(Boolean);
    if (!mine.length || mine.some((m) => texts.some((h) => h === m || h.includes(m) || m.includes(h)))) refused.push(c.id);
  }
  return { refused, key_source: lastKeySource, unreadable };
}

// What may leave this module: held-out totals only, never an item. With
// summary, seen items are dropped too.
function publicReport(report, { summary = false } = {}) {
  const strip = (half, keepItems) => Object.fromEntries(Object.entries(report[half]).map(([set, s]) => {
    const { results, ...totals } = s;
    return [set, keepItems ? { ...totals, results } : totals];
  }));
  return {
    target: report.target,
    sets: report.sets,
    seen: strip('seen', !summary),
    holdout: strip('holdout', false),
    holdout_missing: report.holdout_missing,
    // Where the held-out half lives. The improver uses it to deny an engine
    // reads there. A path, never its contents.
    holdout_dir: report.holdout_dir,
    // Sealed split sources, paths only. The improver uses them to deny reads.
    sealed_sources: report.sealed_sources || [],
    // How the judge got the held-out key: 'keychain' or 'file'. Never the key.
    key_source: report.key_source || null,
  };
}

// ---------------------------------------------------------------- split

// Splits a new corpus file into the two halves: within each kind, items
// sorted by a hash of their id alternate seen, held-out. The seen half is
// appended to the repo corpus, the held-out half to the sealed machine
// copy. The input file is never deleted. A split that would leave
// either half with nothing new writes nothing.
function splitCorpus(file, set, { seenDir, holdoutDir, env = process.env } = {}) {
  if (!SETS.includes(set)) throw new Error(`unknown set ${set}. use guard, agents or review`);
  const crypto = require('crypto');
  const abs = path.resolve(file);
  // Never follow a symbolic link: sealing a link would leave its plaintext
  // target readable. The path and every folder above it must be real.
  for (let p = abs; ; p = path.dirname(p)) {
    let st;
    try { st = fs.lstatSync(p); } catch { if (p === abs) throw new Error(`${file} is not a file`); break; }
    if (st.isSymbolicLink()) {
      let realPath = '';
      try { realPath = fs.realpathSync(abs); } catch {}
      throw new Error(`the source ${file} is or sits under a symbolic link (${p}). nothing was written${realPath ? `. pass the real path: ${realPath}` : ''}`);
    }
    if (path.dirname(p) === p) break;
  }
  if (!fs.lstatSync(abs).isFile()) throw new Error(`${file} is not a file`);
  if (fs.realpathSync(abs) !== abs) throw new Error(`the source ${file} does not resolve to itself. pass the real path: ${fs.realpathSync(abs)}`);
  const real = (x) => { try { return fs.realpathSync(x); } catch { return path.resolve(x); } };
  const repo = repoRootOf(abs);
  const realAbs = real(path.dirname(abs)) + path.sep + path.basename(abs);
  if (repo) { const rr = real(repo); if (realAbs === rr || realAbs.startsWith(`${rr}${path.sep}`)) throw new Error(`the source ${file} is inside the repo. put it outside the checkout so a plaintext exam file is never tracked`); }
  const { items, invalid, missing } = readItems(abs);
  if (missing) throw new Error(`${file} is not a file`);
  const good = items.filter((i) => validItem(set, i));
  const seenFile = path.join(seenDir, `${set}.jsonl`);
  const heldDir = holdoutDir || defaultHoldoutDir(env);
  const heldText = readHeldText(heldDir, set, env) || '';
  const have = new Set([...readItems(seenFile).items, ...parseItems(heldText).items].map((i) => i.id));
  const fresh = good.filter((i) => !have.has(i.id));
  const kindOf = (i) => (set === 'guard' ? (i.kind || i.expect) : set === 'agents' ? (i.expect.length ? 'planted' : 'clean') : 'repo');
  const hash = (i) => crypto.createHash('sha256').update(i.id).digest('hex');
  const groups = new Map();
  for (const i of fresh) { const k = kindOf(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); }
  const toSeen = [];
  const toHeld = [];
  for (const list of groups.values()) list.sort((a, b) => hash(a).localeCompare(hash(b))).forEach((i, n) => (n % 2 === 0 ? toSeen : toHeld).push(i));
  if (!toSeen.length || !toHeld.length) {
    throw new Error(`nothing written: ${fresh.length} new ${fresh.length === 1 ? 'item' : 'items'} cannot fill both halves (${good.length - fresh.length} already in a half, ${invalid + (items.length - good.length)} not valid)`);
  }
  const lines = (list) => list.map((i) => JSON.stringify(i)).join('\n') + '\n';
  fs.mkdirSync(path.dirname(seenFile), { recursive: true });
  fs.appendFileSync(seenFile, lines(toSeen), { mode: 0o644 });
  writeHeldText(heldDir, set, heldText + lines(toHeld), env);
  // Replace the plaintext source with an encrypted copy under the same key,
  // then register it for the deny list. No plaintext held-out
  // item is left readable anywhere.
  const sealedSource = `${abs}.sealed`;
  fs.writeFileSync(sealedSource, seal(fs.readFileSync(abs, 'utf8'), holdoutKey(env)), { mode: 0o600 });
  fs.rmSync(abs, { force: true });
  registerSealedSource(sealedSource, heldDir);
  return { seen: toSeen.length, holdout: toHeld.length, skipped: good.length - fresh.length, invalid: invalid + (items.length - good.length), seen_file: seenFile, holdout_dir: heldDir, sealed_source: sealedSource };
}

// ---------------------------------------------------------------- render

function plural(n, word, many) {
  return `${n} ${n === 1 ? word : (many || `${word}s`)}`;
}

function setLine(set, s) {
  if (set === 'guard') return `guard: ${s.blocked} of ${plural(s.attacks, 'attack')} blocked, ${s.false_blocks} of ${plural(s.benign, 'everyday command')} wrongly blocked${s.errors ? `, ${plural(s.errors, 'error')}` : ''}`;
  if (set === 'agents') return `agent check: ${s.found} of ${plural(s.expected, 'planted problem')} found, ${plural(s.false_alarms, 'false alarm')} (${s.clean_items_flagged} of ${plural(s.clean_items, 'clean setup')} flagged)${s.errors ? `, ${plural(s.errors, 'error')}` : ''}`;
  return `review: ${s.found} of ${plural(s.holes, 'planted hole')} found in ${plural(s.repos, 'repo')}, ${plural(s.false_findings, 'false finding')}, ${plural(s.engine_calls, 'engine call')}, ${s.credits} credits`;
}

function renderReport(pub, { holdoutDir } = {}) {
  const lines = ['', '  sentinel bench', ''];
  lines.push('  seen half (in the repo)');
  for (const set of pub.sets) if (pub.seen[set]) lines.push(`    ${setLine(set, pub.seen[set])}`);
  lines.push('');
  lines.push('  held-out half (on this machine, items never shown)');
  for (const set of pub.sets) if (pub.holdout[set]) lines.push(`    ${setLine(set, pub.holdout[set])}`);
  if (pub.holdout_missing.length) lines.push(`    no held-out ${pub.holdout_missing.join(' or ')} items${holdoutDir ? ` in ${holdoutDir}` : ''}`);
  const misses = [];
  for (const set of pub.sets) {
    const s = pub.seen[set];
    if (!s || !s.results) continue;
    for (const r of s.results) {
      if (r.ok) continue;
      if (set === 'guard') misses.push(`    ${r.id}  ${r.expect === 'block' ? 'attack ran' : `everyday command blocked by ${r.rule}`}`);
      else if (set === 'agents') misses.push(`    ${r.id}  ${r.missed.length ? `missed ${r.missed.join(', ')}` : ''}${r.missed.length && r.false_alarms.length ? '. ' : ''}${r.false_alarms.length ? `false alarm ${r.false_alarms.join(', ')}` : ''}${r.error ? `error ${r.error}` : ''}`);
      else misses.push(`    ${r.id}  ${r.found} of ${r.holes} holes found, ${r.false_findings} false`);
    }
  }
  if (misses.length) { lines.push(''); lines.push('  seen items it got wrong'); lines.push(...misses); }
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  SETS,
  readHeldText,
  readSealedSources,
  normalizeText,
  screenItems,
  FAKE,
  defaultHoldoutDir,
  expand,
  publicReport,
  readItems,
  renderReport,
  runBench,
  scoreAgents,
  scoreGuard,
  scoreReview,
  seenDirOf,
  splitCorpus,
};
