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

// The sentinel code to judge. `target` is a checkout; the exam code itself
// always comes from the atris that runs it. A change under test cannot
// change how it is scored.
function loadTarget(target) {
  const lib = path.join(path.resolve(target), 'lib');
  return {
    guard: () => require(path.join(lib, 'sentinel-guard.js')),
    agents: () => require(path.join(lib, 'sentinel-agents.js')),
    audit: () => require(path.join(lib, 'security-audit.js')),
  };
}

// ---------------------------------------------------------------- scoring

function scoreGuard(items, guardMod) {
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
        const d = guardMod.decide({ tool_name: tool, tool_input: input, cwd: item.cwd || '/tmp/project' }, { env, gitBranch: () => item.branch || 'feature' });
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

function scoreAgents(items, agentsMod) {
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
        findings = agentsMod.runAgentCheck(dir, { home: false, homeDir: home }).findings || [];
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

function loadSet(dir, set) {
  const { items, invalid, missing } = readItems(path.join(dir, `${set}.jsonl`));
  const good = items.filter((i) => validItem(set, i));
  return { items: good, invalid: invalid + (items.length - good.length), missing };
}

// The full exam. Returns raw numbers per set and half. Held-out results
// stay in this object; publicReport() drops them before anything prints.
async function runBench({ target, seenDir, holdoutDir, sets = ['guard', 'agents'], review = null, env = process.env } = {}) {
  const root = path.resolve(target || process.cwd());
  const seen = path.resolve(seenDir || seenDirOf(root));
  const held = path.resolve(holdoutDir || defaultHoldoutDir(env));
  const code = loadTarget(root);
  const want = sets.filter((s) => SETS.includes(s) && (s !== 'review' || review));
  const report = { target: root, sets: want, seen: {}, holdout: {}, holdout_missing: [] };
  for (const half of ['seen', 'holdout']) {
    const dir = half === 'seen' ? seen : held;
    for (const set of want) {
      const loaded = loadSet(dir, set);
      if (half === 'holdout' && (loaded.missing || !loaded.items.length)) { report.holdout_missing.push(set); continue; }
      let score;
      if (set === 'guard') score = scoreGuard(loaded.items, code.guard());
      else if (set === 'agents') score = scoreAgents(loaded.items, code.agents());
      else score = await scoreReview(loaded.items, code.audit(), review || {});
      score.invalid = loaded.invalid;
      report[half][set] = score;
    }
  }
  return report;
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
  };
}

// ---------------------------------------------------------------- split

// Splits a new corpus file into the two halves: within each kind, items
// sorted by a hash of their id alternate seen, held-out. The seen half is
// appended to the repo corpus, the held-out half to the machine copy, and
// the source file is removed so the held-out items are not left behind.
function splitCorpus(file, set, { seenDir, holdoutDir, env = process.env } = {}) {
  if (!SETS.includes(set)) throw new Error(`unknown set ${set}. use guard, agents or review`);
  const crypto = require('crypto');
  const { items, invalid, missing } = readItems(file);
  if (missing) throw new Error(`${file} is not a file`);
  const good = items.filter((i) => validItem(set, i));
  const seenFile = path.join(seenDir, `${set}.jsonl`);
  const heldFile = path.join(holdoutDir || defaultHoldoutDir(env), `${set}.jsonl`);
  const have = new Set([...readItems(seenFile).items, ...readItems(heldFile).items].map((i) => i.id));
  const fresh = good.filter((i) => !have.has(i.id));
  const kindOf = (i) => (set === 'guard' ? (i.kind || i.expect) : set === 'agents' ? (i.expect.length ? 'planted' : 'clean') : 'repo');
  const hash = (i) => crypto.createHash('sha256').update(i.id).digest('hex');
  const groups = new Map();
  for (const i of fresh) { const k = kindOf(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); }
  const toSeen = [];
  const toHeld = [];
  for (const list of groups.values()) list.sort((a, b) => hash(a).localeCompare(hash(b))).forEach((i, n) => (n % 2 === 0 ? toSeen : toHeld).push(i));
  const append = (f, list, mode) => {
    if (!list.length) return;
    fs.mkdirSync(path.dirname(f), { recursive: true, ...(mode === 0o600 ? { mode: 0o700 } : {}) });
    fs.appendFileSync(f, list.map((i) => JSON.stringify(i)).join('\n') + '\n', { mode });
  };
  append(seenFile, toSeen, 0o644);
  append(heldFile, toHeld, 0o600);
  fs.unlinkSync(file);
  return { seen: toSeen.length, holdout: toHeld.length, skipped: good.length - fresh.length, invalid: invalid + (items.length - good.length), seen_file: seenFile, holdout_file: heldFile };
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
