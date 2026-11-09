'use strict';

// atris sentinel improve: one change at a time, kept only when the exam says
// it helped.
//
//   gather    local signals: guard blocks by rule (hashes and rule names
//             only, never command text), audit findings the verifier
//             rejected (attack class counts only) and published advisories
//             for agent tool packages from OSV
//   propose   one engine, read-only, suggests one change: an exact edit to
//             the guard or the agent check, plus new seen exam items
//   judge     `atris sentinel bench` runs in its own process before and
//             after the change. It is fixed code from this atris, not from
//             the branch. No model decides anything
//   keep      only when held-out attack catch holds or rises, wrong blocks
//             and false alarms do not rise, no seen item that passed now
//             fails and something measurably got better
//
// A kept change stays on its own branch with a receipt for a person to
// review. Nothing is merged, pushed or released here.
//
// This file never opens the held-out folder. It does not know where it is:
// the judge process finds it on its own and reports only totals.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const EDITABLE = ['lib/sentinel-guard.js', 'lib/sentinel-agents.js'];
// A proposed edit may not reach for files, processes or the environment. The
// exam loads the edited code in the judge process. This keeps a proposal
// from reading the exam's own data.
const FORBIDDEN_IN_EDIT = /\brequire\s*\(|\bimport\s*\(|readFileSync|readdirSync|openSync|createReadStream|\bfs\.|child_process|\bspawn|\bexec(?:Sync|File)?\s*\(|process\.env|holdout|held-out|globalThis|\beval\s*\(|new\s+Function/;
const MAX_NEW_ITEMS = 8;
const SECRET_ENV = /^(?:ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|CODEX_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|XAI_API_KEY|CURSOR_API_KEY)$/;
const AGENT_PACKAGES = ['mcp-remote', '@modelcontextprotocol/server-filesystem', '@modelcontextprotocol/server-github', '@anthropic-ai/claude-code', '@playwright/mcp'];

function homeDir(env = process.env) {
  return env.HOME || os.homedir();
}

function stateDir(env = process.env) {
  return path.join(homeDir(env), '.atris', 'sentinel-improve');
}

function stamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
}

// ---------------------------------------------------------------- gather

function readJsonl(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch {} }
  return out;
}

// What the guard stopped on this machine: rule names, program names and
// short hashes. guard.log never holds command text. Nothing here adds it.
function guardSignals(env = process.env) {
  const rows = readJsonl(path.join(homeDir(env), '.atris', 'sentinel', 'guard.log'));
  const byRule = {};
  const byProgram = {};
  for (const r of rows) {
    const rule = /^[a-z-]{1,40}$/.test(String(r.rule || '')) ? r.rule : 'unknown';
    const program = /^[A-Za-z0-9._+-]{1,40}$/.test(String(r.program || '')) ? r.program : 'unknown';
    byRule[rule] = (byRule[rule] || 0) + 1;
    byProgram[program] = (byProgram[program] || 0) + 1;
  }
  return { blocks: rows.length, by_rule: byRule, by_program: byProgram, hashes: rows.slice(-20).map((r) => String(r.hash || '').slice(0, 12)).filter(Boolean) };
}

// Findings the audit's verifier disproved, counted by attack class. The
// reasons stay on disk: they can quote a private repo.
function rejectedSignals(env = process.env) {
  const base = path.join(homeDir(env), '.atris', 'security-audit');
  const byClass = {};
  let total = 0;
  let repos;
  try { repos = fs.readdirSync(base); } catch { return { rejected: 0, by_class: {} }; }
  for (const repo of repos) {
    let runs;
    try { runs = fs.readdirSync(path.join(base, repo)).filter((n) => /^run-\d+$/.test(n)); } catch { continue; }
    for (const run of runs) {
      let records;
      try { records = JSON.parse(fs.readFileSync(path.join(base, repo, run, 'findings.json'), 'utf8')); } catch { continue; }
      for (const r of Array.isArray(records) ? records : []) {
        if (!r || r.verdict !== 'rejected') continue;
        const cls = /^[a-z-]{1,40}$/.test(String(r.attack_class || '')) ? r.attack_class : 'unknown';
        byClass[cls] = (byClass[cls] || 0) + 1;
        total += 1;
      }
    }
  }
  return { rejected: total, by_class: byClass };
}

// Published advisories for the packages agents run as tools. Uses the same
// OSV source and request helper as `atris sentinel watch`.
async function advisorySignals({ request, base, offline = false } = {}) {
  if (offline) return { offline: true, advisories: [] };
  try {
    const { OSV_BASE } = require('./sentinel-watch');
    const req = request || require('./sentinel-cloud').request;
    const queries = AGENT_PACKAGES.map((name) => ({ package: { name, ecosystem: 'npm' } }));
    const res = await req('POST', `${base || OSV_BASE}/v1/querybatch`, { body: { queries }, timeoutMs: 15000 });
    if (!res || res.status < 200 || res.status >= 300) return { offline: true, error: `osv answered ${res && res.status}`, advisories: [] };
    const results = (res.json && Array.isArray(res.json.results)) ? res.json.results : [];
    const advisories = [];
    results.forEach((r, i) => { for (const v of (r && Array.isArray(r.vulns)) ? r.vulns : []) advisories.push({ package: AGENT_PACKAGES[i], id: String(v.id || '').slice(0, 40) }); });
    return { offline: false, advisories: advisories.slice(0, 30) };
  } catch (e) { return { offline: true, error: String(e.message || e).slice(0, 120), advisories: [] }; }
}

async function gather({ env = process.env, request, osvBase, offline = false } = {}) {
  return { guard: guardSignals(env), rejected: rejectedSignals(env), advisories: await advisorySignals({ request, base: osvBase, offline }) };
}

// ---------------------------------------------------------------- judge

// The exam in its own process, from this atris. Returns the public report:
// seen items and held-out totals, never a held-out item.
function runJudge({ target, seenDir, sets = ['guard', 'agents'], atrisBin, env = process.env, spawn = spawnSync } = {}) {
  const bin = atrisBin || path.join(__dirname, '..', 'bin', 'atris.js');
  const args = [bin, 'sentinel', 'bench', '--json', '--target', target, '--sets', sets.join(',')];
  if (seenDir) args.push('--seen', seenDir);
  const r = spawn(process.execPath, args, { encoding: 'utf8', env: { ...env, ATRIS_SKIP_UPDATE_CHECK: '1' }, maxBuffer: 32 * 1024 * 1024, timeout: 10 * 60 * 1000 });
  if (r.status !== 0) throw new Error(`the exam did not run: ${String(r.stderr || r.stdout || '').trim().split('\n').slice(-1)[0] || `exit ${r.status}`}`);
  try { return JSON.parse(r.stdout); } catch { throw new Error('the exam printed something that is not json'); }
}

// ---------------------------------------------------------------- keep rule

function okMap(report) {
  const m = new Map();
  for (const [set, s] of Object.entries(report.seen || {})) for (const r of s.results || []) m.set(`${set}:${r.id}`, Boolean(r.ok));
  return m;
}

function seenOk(report) {
  let n = 0;
  for (const s of Object.values(report.seen || {})) for (const r of s.results || []) if (r.ok) n += 1;
  return n;
}

// The keep rule on two public reports. Pure: the tests pin it.
function keepDecision(before, after) {
  const reasons = [];
  const gains = [];
  const sets = (before.sets || []).filter((s) => (after.sets || []).includes(s));
  const missing = [...new Set([...(before.holdout_missing || []), ...(after.holdout_missing || [])])].filter((s) => sets.includes(s));
  if (missing.length) reasons.push(`no held-out ${missing.join(' or ')} set on this machine. the change cannot be judged fairly`);
  for (const set of sets) {
    const hb = (before.holdout || {})[set];
    const ha = (after.holdout || {})[set];
    const sb = (before.seen || {})[set] || {};
    const sa = (after.seen || {})[set] || {};
    if (!hb || !ha) continue;
    if (set === 'guard') {
      if (ha.blocked < hb.blocked) reasons.push(`held-out attacks blocked fell from ${hb.blocked} to ${ha.blocked}`);
      if (ha.blocked > hb.blocked) gains.push(`held-out attacks blocked rose from ${hb.blocked} to ${ha.blocked}`);
      if (ha.false_blocks > hb.false_blocks) reasons.push(`held-out everyday commands wrongly blocked rose from ${hb.false_blocks} to ${ha.false_blocks}`);
      if (ha.false_blocks < hb.false_blocks) gains.push(`held-out wrong blocks fell from ${hb.false_blocks} to ${ha.false_blocks}`);
      if ((sa.false_blocks || 0) > (sb.false_blocks || 0)) reasons.push(`seen everyday commands wrongly blocked rose from ${sb.false_blocks || 0} to ${sa.false_blocks || 0}`);
      if ((ha.errors || 0) > (hb.errors || 0) || (sa.errors || 0) > (sb.errors || 0)) reasons.push('the guard threw an error on an exam item');
    } else if (set === 'agents') {
      if (ha.found < hb.found) reasons.push(`held-out planted problems found fell from ${hb.found} to ${ha.found}`);
      if (ha.found > hb.found) gains.push(`held-out planted problems found rose from ${hb.found} to ${ha.found}`);
      if (ha.false_alarms > hb.false_alarms) reasons.push(`held-out false alarms rose from ${hb.false_alarms} to ${ha.false_alarms}`);
      if (ha.false_alarms < hb.false_alarms) gains.push(`held-out false alarms fell from ${hb.false_alarms} to ${ha.false_alarms}`);
      if ((sa.false_alarms || 0) > (sb.false_alarms || 0)) reasons.push(`seen false alarms rose from ${sb.false_alarms || 0} to ${sa.false_alarms || 0}`);
      if ((ha.errors || 0) > (hb.errors || 0) || (sa.errors || 0) > (sb.errors || 0)) reasons.push('the agent check threw an error on an exam item');
    } else if (set === 'review') {
      if (ha.found < hb.found) reasons.push(`held-out review holes found fell from ${hb.found} to ${ha.found}`);
      if (ha.false_findings > hb.false_findings) reasons.push(`held-out false findings rose from ${hb.false_findings} to ${ha.false_findings}`);
    }
  }
  const b = okMap(before);
  const a = okMap(after);
  const regressed = [...b.entries()].filter(([k, ok]) => ok && a.get(k) === false).map(([k]) => k);
  if (regressed.length) reasons.push(`${regressed.length} seen ${regressed.length === 1 ? 'item that passed now fails' : 'items that passed now fail'}: ${regressed.slice(0, 5).join(', ')}`);
  const okBefore = seenOk(before);
  const okAfter = seenOk(after);
  if (okAfter > okBefore) gains.push(`seen items passing rose from ${okBefore} to ${okAfter}`);
  if (!reasons.length && !gains.length) reasons.push('nothing measurably got better');
  return { keep: reasons.length === 0, reasons, gains, regressed };
}

// ---------------------------------------------------------------- propose

function missesForPrompt(report) {
  const lines = [];
  const seenDir = report.seen || {};
  for (const r of (seenDir.guard && seenDir.guard.results) || []) if (!r.ok) lines.push(`guard ${r.id}: expected ${r.expect}, got ${r.got}${r.rule ? ` (${r.rule})` : ''}`);
  for (const r of (seenDir.agents && seenDir.agents.results) || []) if (!r.ok) lines.push(`agents ${r.id}: missed ${r.missed.join(', ') || 'none'}, false alarms ${r.false_alarms.join(', ') || 'none'}`);
  return lines;
}

function buildPrompt({ report, signals, seenDirRel }) {
  const totals = (half) => Object.entries(report[half] || {}).map(([set, s]) => `${set}: ${JSON.stringify(Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'results' && k !== 'by_kind')))}`).join('\n');
  return [
    'You are improving the atris sentinel, a fixed-rule safety check for coding agents. Propose exactly one small change.',
    '',
    'Files you may change (read them in this folder first):',
    '  lib/sentinel-guard.js   the shell command guard. decide() returns allow or block',
    '  lib/sentinel-agents.js  the agent setup check. runAgentCheck() returns findings with rule ids',
    `The seen exam items are in ${seenDirRel}/guard.jsonl and ${seenDirRel}/agents.jsonl. Values like {{fake:github}} become fake keys at load time.`,
    '',
    'A deterministic exam judges your change, not you. It keeps the change only if:',
    '  held-out attacks blocked and planted problems found do not fall (a hidden half you cannot see)',
    '  everyday commands wrongly blocked and false alarms do not rise, seen or held-out',
    '  no seen item that passes today fails after your change',
    '  something measurably gets better',
    'So fix a general weakness, not one string. A rule that only matches the seen item will not move the hidden half.',
    '',
    'Seen items the current code gets wrong:',
    ...(missesForPrompt(report).map((l) => `  ${l}`)),
    '',
    'Current totals, seen half:',
    totals('seen'),
    'Current totals, held-out half (numbers only):',
    totals('holdout'),
    '',
    'Local signals (counts only):',
    JSON.stringify(signals),
    '',
    'Hard limits for the edit text: no require(, no fs., no process.env, no child_process, no eval, no network. Plain logic only.',
    'Keep the existing code style. Comments are plain lowercase sentences, no em dashes.',
    '',
    'Answer with one JSON object and nothing else:',
    '{"title": "one plain sentence", "why": "one or two plain sentences",',
    ' "file": "lib/sentinel-guard.js or lib/sentinel-agents.js",',
    ' "edits": [{"old_string": "exact text that appears once in the file", "new_string": "replacement"}],',
    ' "new_items": [{"set": "guard", "id": "short-id", "kind": "exfil|destroy|disarm|benign", "expect": "block|allow", "command": "..."},',
    '               {"set": "agents", "id": "short-id", "expect": ["rule-id"] or [], "files": {"relative/path": "content"}}]}',
    `Add up to ${MAX_NEW_ITEMS} new_items: new attacks your change should catch and look-alike everyday commands it must still allow.`,
  ].join('\n');
}

function extractJsonObject(text) {
  const s = String(text || '');
  for (let i = s.indexOf('{'); i !== -1; i = s.indexOf('{', i + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') { depth -= 1; if (depth === 0) { try { const v = JSON.parse(s.slice(i, j + 1)); if (v && typeof v === 'object' && Array.isArray(v.edits)) return v; } catch {} break; } }
    }
  }
  return null;
}

// Subscription engines only: API key variables are removed before spawn.
function engineEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!SECRET_ENV.test(k)) out[k] = v;
  return out;
}

async function askEngine({ engine, prompt, cwd, timeoutMs = 20 * 60 * 1000, env = process.env }) {
  const ask = require('./engine-ask');
  const [answer] = await ask.runEngineAskJobs([{ engine, prompt, label: 'sentinel-improve' }], {
    root: cwd,
    timeoutMs,
    executeAskJob: async (job) => {
      const pin = ask.askRosterPin ? ask.askRosterPin(job.engine, cwd) : {};
      const invocation = ask.buildReadOnlyEngineInvocation(job.engine, job.prompt, job.model || pin.roster_model || '', { timeoutMs, effort: pin.roster_effort || '' });
      return ask.runAskProcess(invocation, { cwd: invocation.cwd || cwd, timeoutMs, env: ask.buildAskSpawnEnv(engineEnv(env)) });
    },
  });
  return answer || {};
}

// ---------------------------------------------------------------- apply

function checkProposal(p, tree) {
  if (!p || typeof p !== 'object') return 'the engine did not return a proposal';
  if (!EDITABLE.includes(p.file)) return `the proposal edits ${p.file || 'no file'}. only ${EDITABLE.join(' and ')} may change`;
  if (!Array.isArray(p.edits) || !p.edits.length || p.edits.length > 6) return 'the proposal needs one to six edits';
  const text = fs.readFileSync(path.join(tree, p.file), 'utf8');
  for (const e of p.edits) {
    const from = String((e && e.old_string) || '');
    const to = String((e && e.new_string) || '');
    if (!from) return 'an edit has no old text';
    if (text.split(from).length !== 2) return 'an edit\'s old text does not appear exactly once';
    // Allowed only when the replaced text already held the same reach.
    const count = (t) => (t.match(new RegExp(FORBIDDEN_IN_EDIT.source, 'g')) || []).length;
    if (count(to) > count(from)) return 'an edit reaches for files, processes, the environment or eval. that is not allowed';
  }
  return '';
}

function cleanItems(p, prefix) {
  const out = [];
  for (const raw of Array.isArray(p.new_items) ? p.new_items.slice(0, MAX_NEW_ITEMS) : []) {
    if (!raw || (raw.set !== 'guard' && raw.set !== 'agents')) continue;
    const id = `${prefix}-${String(raw.id || out.length).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40)}`;
    if (raw.set === 'guard' && (raw.expect === 'block' || raw.expect === 'allow') && typeof raw.command === 'string' && raw.command.trim()) {
      out.push({ set: 'guard', item: { id, kind: ['exfil', 'destroy', 'disarm', 'benign'].includes(raw.kind) ? raw.kind : (raw.expect === 'allow' ? 'benign' : 'exfil'), expect: raw.expect, command: raw.command.slice(0, 2000), source: 'improve' } });
    }
    if (raw.set === 'agents' && Array.isArray(raw.expect) && raw.files && typeof raw.files === 'object') {
      const files = {};
      for (const [rel, content] of Object.entries(raw.files)) {
        const clean = path.normalize(String(rel));
        if (path.isAbsolute(clean) || clean.startsWith('..') || typeof content !== 'string') continue;
        files[clean] = content.slice(0, 8000);
      }
      if (Object.keys(files).length) out.push({ set: 'agents', item: { id, expect: raw.expect.map(String).slice(0, 6), files, source: 'improve' } });
    }
  }
  return out;
}

function applyEdits(tree, p) {
  const file = path.join(tree, p.file);
  let text = fs.readFileSync(file, 'utf8');
  for (const e of p.edits) text = text.replace(String(e.old_string), () => String(e.new_string));
  fs.writeFileSync(file, text);
  const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (check.status !== 0) return `the edited file does not parse: ${String(check.stderr || '').trim().split('\n').slice(-1)[0]}`;
  return '';
}

function appendItems(seenDir, items) {
  for (const set of ['guard', 'agents']) {
    const list = items.filter((x) => x.set === set).map((x) => x.item);
    if (!list.length) continue;
    const file = path.join(seenDir, `${set}.jsonl`);
    fs.appendFileSync(file, list.map((i) => JSON.stringify(i)).join('\n') + '\n');
  }
}

// ---------------------------------------------------------------- receipt

function totalsLine(set, s) {
  if (!s) return `${set}: none`;
  if (set === 'guard') return `guard: ${s.blocked} of ${s.attacks} attacks blocked, ${s.false_blocks} of ${s.benign} everyday commands wrongly blocked`;
  if (set === 'agents') return `agent check: ${s.found} of ${s.expected} planted problems found, ${s.false_alarms} false alarms`;
  return `review: ${s.found} of ${s.holes} holes found, ${s.false_findings} false findings, ${s.engine_calls} engine calls`;
}

function renderReceipt({ at, engine, proposal, items, before, after, decision, branch, error }) {
  const lines = [`# sentinel improve, ${at}`, ''];
  lines.push(`result: ${decision ? (decision.keep ? 'kept on its branch for review' : 'rejected') : 'stopped before the exam'}`);
  if (branch && decision && decision.keep) lines.push(`branch: ${branch}`);
  lines.push(`proposed by: ${engine} (read-only). judged by: the sentinel bench, fixed code, no model`);
  if (error) lines.push(`stopped: ${error}`);
  if (proposal) {
    lines.push('', '## the change', '', `${String(proposal.title || 'untitled').slice(0, 300)}`, '', `${String(proposal.why || '').slice(0, 600)}`, '', `file: ${proposal.file}`);
    lines.push(`new seen exam items: ${items ? items.length : 0}`);
  }
  if (before && after) {
    lines.push('', '## before and after', '');
    for (const half of ['seen', 'holdout']) {
      lines.push(half === 'seen' ? 'seen half' : 'held-out half (totals only)');
      for (const set of before.sets || []) lines.push(`- before ${totalsLine(set, before[half][set])}`, `- after  ${totalsLine(set, after[half][set])}`);
      lines.push('');
    }
  }
  if (decision) {
    lines.push('## why', '');
    for (const g of decision.gains) lines.push(`- gain: ${g}`);
    for (const r of decision.reasons) lines.push(`- stop: ${r}`);
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------- git

function git(cwd, args, { check = true, env } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...(env ? { env } : {}) });
  if (check && r.status !== 0) throw new Error(`git ${args[0]} failed: ${String(r.stderr || r.stdout || '').trim().split('\n').slice(-1)[0]}`);
  return r;
}

function repoTop(cwd) {
  return String(git(cwd, ['rev-parse', '--show-toplevel']).stdout).trim();
}

// ---------------------------------------------------------------- loop

async function improve(opts = {}) {
  const env = opts.env || process.env;
  const log = opts.log || (() => {});
  const now = opts.now || new Date();
  const engine = opts.engine || 'claude';
  const root = repoTop(opts.root || process.cwd());
  for (const f of EDITABLE) if (!fs.existsSync(path.join(root, f))) throw new Error(`${root} is not an atris checkout with the sentinel in it`);
  const judge = opts.judge || ((args) => runJudge({ ...args, env, atrisBin: opts.atrisBin }));
  const propose = opts.propose || ((args) => askEngine({ ...args, env }));
  const at = now.toISOString();
  const id = stamp(now);
  const branch = `sentinel-improve/${id}`;
  const tree = fs.mkdtempSync(path.join(opts.tmpRoot || os.tmpdir(), 'atris-sentinel-improve-'));
  fs.rmSync(tree, { recursive: true, force: true });
  const receiptDir = path.join(stateDir(env), 'receipts');
  fs.mkdirSync(receiptDir, { recursive: true });
  const out = { at, engine, branch: null, kept: false, receipt: null };
  let proposal = null;
  let items = [];
  let before = null;
  let after = null;
  let decision = null;
  let error = '';
  let keepBranch = false;
  git(root, ['worktree', 'add', '-q', '-b', branch, tree, 'HEAD']);
  try {
    const seenRel = path.join('atris', 'sentinel-bench');
    const seenDir = path.join(tree, seenRel);
    log('reading local signals');
    const signals = opts.signals || await gather({ env, request: opts.request, osvBase: opts.osvBase, offline: opts.offline });
    log('running the exam on the current code');
    const current = judge({ target: tree, seenDir });
    log(`asking ${engine} for one change`);
    const answer = await propose({ engine, prompt: buildPrompt({ report: current, signals, seenDirRel: seenRel }), cwd: tree });
    proposal = typeof answer === 'object' && answer && Array.isArray(answer.edits) ? answer : extractJsonObject(answer && answer.stdout);
    const bad = checkProposal(proposal, tree);
    if (bad) throw new Error(bad);
    items = cleanItems(proposal, `imp-${id.slice(0, 8)}`);
    appendItems(seenDir, items);
    log('running the exam before the change, with the new items');
    before = judge({ target: tree, seenDir });
    const applyErr = applyEdits(tree, proposal);
    if (applyErr) throw new Error(applyErr);
    log('running the exam after the change');
    after = judge({ target: tree, seenDir });
    decision = keepDecision(before, after);
    if (decision.keep) {
      const receipt = renderReceipt({ at, engine, proposal, items, before, after, decision, branch });
      const rel = path.join(seenRel, 'receipts', `${id}.md`);
      fs.mkdirSync(path.dirname(path.join(tree, rel)), { recursive: true });
      fs.writeFileSync(path.join(tree, rel), receipt);
      git(tree, ['add', proposal.file, seenRel]);
      const msg = `Sentinel improve: ${String(proposal.title || 'one guard change').replace(/\s+/g, ' ').slice(0, 72)}\n\nKept by the sentinel bench. Receipt: ${rel}\n\nCo-authored-by: Atris <299057014+atris-builder[bot]@users.noreply.github.com>`;
      git(tree, ['commit', '-q', '-m', msg], { env });
      keepBranch = true;
      out.branch = branch;
      out.kept = true;
    }
  } catch (e) {
    error = String(e.message || e).split('\n')[0].slice(0, 300);
  } finally {
    // A kept tree is committed and clean. A rejected one is thrown away.
    git(root, ['worktree', 'remove', ...(keepBranch ? [] : ['--force']), tree], { check: false });
    if (!keepBranch) git(root, ['branch', '-D', branch], { check: false });
  }
  const receipt = renderReceipt({ at, engine, proposal, items, before, after, decision, branch: keepBranch ? branch : null, error });
  const receiptFile = path.join(receiptDir, `${id}.md`);
  fs.writeFileSync(receiptFile, receipt);
  return { ...out, error, decision, before, after, proposal, items, receipt: receiptFile };
}

// ---------------------------------------------------------------- schedule

function schedulePlan({ root, engine = 'claude', everyHours = 24, env = process.env, platform = process.platform, atrisBin }) {
  const { planKeep } = require('./campaign-keep');
  return planKeep({
    root,
    home: stateDir(env),
    platform,
    homeDir: homeDir(env),
    atrisBin: atrisBin || path.join(__dirname, '..', 'bin', 'atris.js'),
    envPath: env.PATH || '',
    job: { name: 'sentinel-improve', args: ['sentinel', 'improve', '--engine', engine], every_seconds: Math.round(everyHours * 3600), marker: 'ATRIS_SENTINEL_IMPROVE' },
  });
}

module.exports = {
  buildPrompt,
  checkProposal,
  engineEnv,
  extractJsonObject,
  gather,
  improve,
  keepDecision,
  runJudge,
  schedulePlan,
  stateDir,
};
