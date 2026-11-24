#!/usr/bin/env node
'use strict';

// Real-advisory scorecard for the sentinel audit.
//
// 20 published security holes from GitHub Security Advisories, each pinned to
// the commit just before its public fix (atris/sentinel-bench/real-advisories/
// advisories.json). The audit runs on each vulnerable commit and is scored:
//   FOUND   a confirmed finding names the hole's file, near the hole's line,
//           and a person marked it as the same flaw (labels.json)
//   NEAR    an unchecked lead, rejected finding or hardening note on that spot
//   MISSED  nothing on that spot
// Every other confirmed finding is a candidate wrong alarm until labels.json
// marks it "real" (a new hole) or "wrong".
//
//   node scripts/sentinel-real-scorecard.js fetch            clone the vulnerable commits
//   node scripts/sentinel-real-scorecard.js run [ids...]     run the audit (quick, local engines)
//   node scripts/sentinel-real-scorecard.js score [--json]   print the table
//
// Options: --exam <name> (default real-advisories; real-advisories-2 is the
// second, fresh exam), --root <dir> (default /tmp/sentinel-scorecard, or
// /tmp/sentinel-scorecard/<exam> for other exams), --fresh (run: replace an
// existing run folder), --atris <bin/atris.js> (default: this checkout),
// --jobs <n> (run: audits at once, default 1), --keep <dir> (run: where each
// finished run is copied for later hand checks, default
// ~/.atris/sentinel-real-scorecard/runs/<date-time>/<exam>), --runs <dir>
// (score: read runs from this folder instead of <root>/runs, e.g. a kept copy),
// --show-real (score: show new real holes by name; local use only, never paste
// that output anywhere public).
//
// The clones are untrusted code. This script never runs, installs, builds or
// tests anything from them: it only uses git to fetch and check out, and runs
// the audit from this checkout with the clone as its working folder. It refuses
// a clone that carries agent settings able to run commands (hooks, MCP servers)
// because the audit's engines start inside the clone.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

const BENCH_ROOT = path.join(__dirname, '..', 'atris', 'sentinel-bench');
const os = require('os');
const LINE_WINDOW = 30;

// Settings a clone could use to run commands when the audit's engines (codex,
// claude) start in it. Present means the item is refused, not run.
const EXEC_FILES = ['.mcp.json', '.claude/hooks', '.codex/config.toml', '.codex/hooks.json'];

// Which of Sentinel's kinds of flaw (the attack_class in its coverage ledger)
// should catch each class on our list. Used only to explain misses.
const CLASS_KINDS = {
  access: ['access-control', 'access-rules'],
  signin: ['sign-in-matching', 'access-control'],
  rls: ['access-rules', 'access-control'],
  'webhook-header': ['access-control', 'sign-in-matching', 'access-rules', 'header-trust', 'inbound-signature'],
  secrets: ['secrets-handling'],
  injection: ['command-injection', 'code-injection', 'sql-injection'],
  ssrf: ['outbound-request'],
  traversal: ['path-traversal'],
  'agent-tool': ['agent-blast-radius', 'agent-and-llm', 'path-traversal', 'outbound-request'],
};
// Claude settings keys that run a command.
const CLAUDE_EXEC_KEYS = ['hooks', 'mcpServers', 'enableAllProjectMcpServers', 'enabledMcpjsonServers', 'statusLine', 'apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper', 'fileSuggestion', 'plugins', 'enabledPlugins', 'extraKnownMarketplaces'];

function execConfigs(dir) {
  const hits = EXEC_FILES.filter((p) => fs.existsSync(path.join(dir, p)));
  for (const p of ['.claude/settings.json', '.claude/settings.local.json']) {
    const full = path.join(dir, p);
    if (!fs.existsSync(full)) continue;
    let json;
    try { json = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { hits.push(`${p} (unreadable)`); continue; }
    const keys = CLAUDE_EXEC_KEYS.filter((k) => json && Object.prototype.hasOwnProperty.call(json, k));
    if (keys.length) hits.push(`${p} (${keys.join(', ')})`);
  }
  return hits;
}

function parseArgs(argv) {
  const o = { cmd: argv[0], ids: [], exam: 'real-advisories', root: null, runs: null, keep: null, jobs: 1, fresh: false, json: false, atris: path.join(__dirname, '..', 'bin', 'atris.js') };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') o.root = argv[++i];
    else if (a === '--exam') o.exam = argv[++i];
    else if (a === '--runs') o.runs = argv[++i];
    else if (a === '--keep') o.keep = argv[++i];
    else if (a === '--jobs') o.jobs = Math.max(1, Number(argv[++i]) || 1);
    else if (a === '--atris') o.atris = argv[++i];
    else if (a === '--fresh') o.fresh = true;
    else if (a === '--json') o.json = true;
    else if (a === '--show-real') o.showReal = true;
    else if (a.startsWith('-')) throw new Error(`unknown flag ${a}`);
    else o.ids.push(a);
  }
  if (!/^[a-z0-9-]+$/.test(o.exam)) throw new Error(`bad exam name ${o.exam}`);
  o.bench = path.join(BENCH_ROOT, o.exam);
  o.root = path.resolve(o.root || (o.exam === 'real-advisories' ? '/tmp/sentinel-scorecard' : `/tmp/sentinel-scorecard/${o.exam}`));
  o.runs = path.resolve(o.runs || path.join(o.root, 'runs'));
  const stamp = new Date().toISOString().replace(/[:]/g, '-').replace(/\..*$/, '');
  o.keep = path.resolve(o.keep || path.join(os.homedir(), '.atris', 'sentinel-real-scorecard', 'runs', stamp, o.exam));
  o.atris = path.resolve(o.atris);
  return o;
}

function load(o) {
  const list = JSON.parse(fs.readFileSync(path.join(o.bench, 'advisories.json'), 'utf8'));
  let labels = {};
  try { labels = JSON.parse(fs.readFileSync(path.join(o.bench, 'labels.json'), 'utf8')); } catch {}
  return { list, labels };
}

// A confirmed finding that turns out to be a new, unpublished hole is never
// written into this public repo by name. labels.json keys it by this hash of
// its fingerprint, and the score shows only the hash unless --show-real is set.
const fpKey = (fp) => `sha256:${crypto.createHash('sha256').update(String(fp)).digest('hex').slice(0, 16)}`;
const otherLabel = (lab, fp) => ((lab.others || {})[fp] || (lab.others || {})[fpKey(fp)] || 'unchecked');
// A match label can be keyed by the hash too, so a new hole that happens to sit
// on the advisory's spot is never named in this public repo.
const matchLabel = (lab, fp) => ((lab.match || {})[fp] || (lab.match || {})[fpKey(fp)]);

const repoDir = (o, id) => path.join(o.root, 'repos', id);
const runDir = (o, id) => path.join(o.runs, id);
const inside = (child, parent) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', '-c', 'core.fsmonitor=false', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1', GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function fetchOne(o, a) {
  const dir = repoDir(o, a.id);
  if (fs.existsSync(dir)) {
    let head = '';
    try { head = git(dir, ['rev-parse', 'HEAD']); } catch {}
    if (head === a.vulnerable_commit) return 'ready';
    throw new Error(`${dir} exists and is not at ${a.vulnerable_commit}; move it away first`);
  }
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['remote', 'add', 'origin', `https://github.com/${a.repo}.git`]);
  git(dir, ['fetch', '-q', '--depth', '1', '--no-tags', 'origin', a.vulnerable_commit]);
  git(dir, ['-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD']);
  const head = git(dir, ['rev-parse', 'HEAD']);
  if (head !== a.vulnerable_commit) throw new Error(`${a.id}: checked out ${head}, wanted ${a.vulnerable_commit}`);
  return 'fetched';
}

function refuseReason(o, a) {
  const dir = repoDir(o, a.id);
  if (inside(o.atris, path.join(o.root, 'repos'))) return 'the audit program sits inside the clones folder';
  if (!fs.existsSync(dir)) return 'not fetched';
  if (inside(runDir(o, a.id), dir) || inside(o.keep, dir)) return 'run folder is inside the clone';
  const hits = execConfigs(dir);
  if (hits.length) return `clone carries settings that can run commands: ${hits.join(', ')}`;
  return null;
}

async function runOne(o, a) {
  const why = refuseReason(o, a);
  if (why) return { id: a.id, status: 'refused', why };
  const out = runDir(o, a.id);
  if (fs.existsSync(out)) {
    if (!o.fresh) return { id: a.id, status: 'kept', why: 'run folder exists (use --fresh to replace)' };
    if (!inside(out, path.join(o.root, 'runs')) || out === path.join(o.root, 'runs')) throw new Error(`refusing to remove ${out}`);
    fs.rmSync(out, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const t0 = Date.now();
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, [o.atris, 'security-review', 'audit', '--quick', '--no-upload', '--engine', 'local', '--out', out], {
      cwd: repoDir(o, a.id), env: { ...process.env, ATRIS_SENTINEL_SCORECARD: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.on('error', (e) => resolve({ status: -1, stdout, stderr: `${stderr}${e.message}` }));
  });
  fs.writeFileSync(`${out}.log`, `${r.stdout || ''}\n${r.stderr || ''}`);
  // The audit exits 1 when it confirms findings, so a run counts as done when
  // its metadata says it finished, whatever the exit code.
  const done = Boolean(readJson(path.join(out, 'run-metadata.json'), {}).finished_at);
  // Keep a copy outside /tmp so findings can be hand-checked later.
  fs.mkdirSync(o.keep, { recursive: true });
  fs.cpSync(out, path.join(o.keep, a.id), { recursive: true });
  fs.copyFileSync(`${out}.log`, path.join(o.keep, `${a.id}.log`));
  return { id: a.id, status: done ? 'ran' : `failed (exit ${r.status}, see ${out}.log)`, seconds: Math.round((Date.now() - t0) / 1000) };
}

function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }

function holeSpots(a) {
  return [{ file: a.hole_file, line: a.hole_line }, ...(a.also || [])];
}

function touches(spots, file, line) {
  return spots.some((s) => s.file === file && (line == null || s.line == null || Math.abs(Number(line) - s.line) <= LINE_WINDOW));
}

function findingFiles(f) {
  const out = (f.trace || []).map((t) => ({ file: t.file, line: t.line }));
  const fp = String(f.fingerprint || '').split(':')[0];
  if (fp) out.push({ file: fp, line: null });
  return out;
}

function scoreOne(o, a, labels) {
  const dir = runDir(o, a.id);
  const meta = readJson(path.join(dir, 'run-metadata.json'), null);
  if (!meta) return { id: a.id, verdict: 'NO RUN', others: [] };
  if (!meta.finished_at) return { id: a.id, verdict: 'NOT DONE', others: [] };
  // Leads the run ran out of budget to check sit in carried-pending.json; they
  // count as unchecked leads, never as confirmed.
  const pending = readJson(path.join(dir, 'carried-pending.json'), []).map((f) => ({ ...f, verdict: 'unchecked' }));
  const findings = [...readJson(path.join(dir, 'findings.json'), []), ...pending];
  const ledger = readJson(path.join(dir, 'coverage-ledger.json'), []);
  const lab = labels[a.id] || {};
  const spots = holeSpots(a);
  const files = new Set(spots.map((s) => s.file));
  const hits = findings.filter((f) => findingFiles(f).some((t) => touches(spots, t.file, t.line)));

  let verdict = 'MISSED';
  let matched = null;
  const confirmedHits = hits.filter((f) => f.verdict === 'confirmed');
  const same = confirmedHits.find((f) => matchLabel(lab, f.fingerprint) === 'same');
  const unlabeled = confirmedHits.find((f) => !matchLabel(lab, f.fingerprint));
  if (same) { verdict = 'FOUND'; matched = same; }
  else if (unlabeled) { verdict = 'FOUND?'; matched = unlabeled; }
  else if (hits.some((f) => f.verdict !== 'confirmed' || matchLabel(lab, f.fingerprint) === 'near')) verdict = 'NEAR';
  else if (ledger.some((u) => (u.hardening || []).some((h) => [...files].some((fl) => String(h).includes(path.basename(fl)))))) verdict = 'NEAR';

  // Why a miss. The audit works in units of (area, kind of flaw). A unit is
  // "read" when a hunter ran it; "queued" when it held the file but ran out
  // of budget. A file read only while hunting other kinds of flaw is not the
  // same as a file read for this kind.
  let why = '';
  if (verdict === 'MISSED' || verdict === 'NEAR') {
    const kinds = new Set(CLASS_KINDS[a.class] || []);
    const holds = (u) => [...(u.reviewed_paths || []), ...(u.starting_paths || []), ...(u.hot_lines || []).map((h) => h.file)].some((p) => files.has(p));
    const ran = (u) => ['covered', 'candidate', 'blocked'].includes(u.status);
    const rightKind = (u) => kinds.has(u.attack_class);
    const dismissed = hits.filter((f) => f.verdict === 'rejected');
    if (hits.some((f) => f.verdict === 'unchecked')) why = 'spotted it, then ran out of budget before checking it';
    else if (hits.some((f) => f.verdict === 'needs_validation')) why = 'spotted it, left it as a lead that needs a fact';
    else if (dismissed.length) why = 'saw it and dismissed it';
    else if (ledger.some((u) => ran(u) && rightKind(u) && holds(u))) why = 'read the file for this kind of flaw but did not see it';
    else if (ledger.some((u) => !ran(u) && rightKind(u) && holds(u))) {
      why = ledger.some((u) => ran(u) && holds(u))
        ? 'read the file only for other kinds of flaw; the check for this kind was queued, not run (budget)'
        : 'queued the file for this kind of flaw, never read it (budget)';
    } else if (ledger.some((u) => ran(u) && holds(u))) why = 'read the file only for other kinds of flaw; never queued it for this kind';
    else why = 'never read the file';
  }

  const others = findings.filter((f) => f.verdict === 'confirmed' && f !== matched && !(confirmedHits.includes(f) && matchLabel(lab, f.fingerprint) === 'same'))
    .map((f) => {
      const label = otherLabel(lab, f.fingerprint);
      if (label === 'real' && !o.showReal) return { fingerprint: fpKey(f.fingerprint), title: '(new hole, kept private)', label };
      return { fingerprint: f.fingerprint, title: f.title, label };
    });
  return {
    id: a.id, verdict, why, matched: matched && matched.fingerprint,
    others, wrong: others.filter((x) => x.label === 'wrong').length, real: others.filter((x) => x.label === 'real').length,
    unchecked: others.filter((x) => x.label === 'unchecked').length,
    engine_calls: meta.invocations && meta.invocations.used, credits: meta.credits_used || 0,
    areas: meta.coverage && `${meta.coverage.done}/${meta.coverage.in_scope}`,
  };
}

function printTable(rows, list) {
  const byId = new Map(list.map((a) => [a.id, a]));
  const pad = (s, n) => String(s).padEnd(n);
  for (const half of ['seen', 'held-out']) {
    const rs = rows.filter((r) => byId.get(r.id).split === half);
    console.log(`\n  ${half} (${rs.length})`);
    console.log(`  ${pad('advisory', 21)}${pad('class', 16)}${pad('result', 9)}${pad('wrong', 7)}${pad('new', 5)}${pad('unchk', 7)}${pad('areas', 8)}why`);
    for (const r of rs) {
      const a = byId.get(r.id);
      console.log(`  ${pad(r.id, 21)}${pad(a.class, 16)}${pad(r.verdict, 9)}${pad(r.wrong ?? '-', 7)}${pad(r.real ?? '-', 5)}${pad(r.unchecked ?? '-', 7)}${pad(r.areas || '-', 8)}${r.why || ''}`);
    }
    const n = (v) => rs.filter((r) => r.verdict === v).length;
    const sum = (k) => rs.reduce((t, r) => t + (r[k] || 0), 0);
    console.log(`  total: found ${n('FOUND')}${n('FOUND?') ? ` (+${n('FOUND?')} unlabeled)` : ''}, near ${n('NEAR')}, missed ${n('MISSED')}, not run ${n('NO RUN') + n('NOT DONE')} · wrong alarms ${sum('wrong')}, new real holes ${sum('real')}, unchecked ${sum('unchecked')}`);
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const { list, labels } = load(o);
  const pick = o.ids.length ? list.filter((a) => o.ids.includes(a.id)) : list;
  if (o.cmd === 'fetch') {
    for (const a of pick) {
      try { console.log(`  ${a.id}  ${fetchOne(o, a)}`); } catch (e) { console.log(`  ${a.id}  failed: ${e.message.split('\n')[0]}`); }
    }
    return 0;
  }
  if (o.cmd === 'run') {
    const queue = [...pick];
    const worker = async () => {
      for (let a = queue.shift(); a; a = queue.shift()) {
        const r = await runOne(o, a);
        console.log(`  ${a.id}  ${r.status}${r.why ? `: ${r.why}` : ''}${r.seconds ? ` (${r.seconds}s)` : ''}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(o.jobs, queue.length) }, worker));
    console.log(`  copies kept in ${o.keep}`);
    return 0;
  }
  if (o.cmd === 'score') {
    const rows = pick.map((a) => scoreOne(o, a, labels));
    if (o.json) console.log(JSON.stringify(rows, null, 2));
    else printTable(rows, list);
    return 0;
  }
  console.log('usage: node scripts/sentinel-real-scorecard.js fetch|run|score [ids...] [--exam name] [--root dir] [--runs dir] [--keep dir] [--jobs n] [--fresh] [--json]');
  return 2;
}

main().then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(2); });
