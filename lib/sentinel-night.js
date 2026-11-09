'use strict';

// atris sentinel improve --rounds N --parallel K --review codex: the night run.
//
// One round:
//
//   propose   K sealed Claude proposers at once, each in its own temp copy
//             with every seal rule of a single run (see sentinel-improve.js)
//             and each pointed at a different focus area. That way they do
//             not all chase the same miss
//   judge     each proposal alone, with the same exam and keep rule as a
//             single run
//   review    with --review codex, each change the exam kept goes to
//             `codex exec -s read-only` with stdin closed. It sees the diff
//             and the seen exam only. It answers one strict json object:
//             SHIP keeps the change, FIX or anything malformed rejects it
//   learn     every everyday command the reviewer says a change wrongly
//             blocks becomes a seen item expected to run, every bypass a
//             seen item expected to block and every agent false alarm a
//             clean agent item. Each is tagged source "review", checked
//             for anything that looks like a real secret and deduplicated.
//             They go on their own branch, sentinel-exam/<date>
//   land      the union of the shipped changes is judged again on the grown
//             exam (and reviewed when it holds more than one change). If it
//             fails, the best single shipped change by held-out gain, then
//             older seen gain, is judged again the same way. The first that
//             passes lands on sentinel-improve/night-<date>
//
// The next round starts from the landed rules and the grown exam. The run
// stops after two rounds in a row with nothing shipped, two rounds in a row
// where held-out catch did not rise, the time limit or the call cap.
//
// The guarantee, on top of everything a single run keeps:
//
//   the proposer is sealed exactly as in a single run. It never writes
//   exam items from the review; only this file does, from the reviewer's
//   parsed answer
//   the reviewer runs in an empty temp folder holding the diff and the seen
//   exam, with an empty temp HOME (its own login folder is pointed to by
//   CODEX_HOME), a stripped environment and no mcp servers. Nothing here
//   passes it the held-out folder, a held-out item or the key
//   nothing lands without the exam passing on the exam as it stands at
//   landing time, review items included
//   one night run at a time per machine, by a lock file holding its pid
//   every copy goes through the same safe cleanup as a single run
//   nothing merges, releases or pushes to the main branch. With --push the
//   two night branches are pushed by name and nothing else
//
// Accepted limits:
//
//   codex read-only can still read files on this computer outside its
//   folder. The held-out half is encrypted at rest and its key sits in the
//   keychain. The empty HOME does not link it in
//   two runs that both find the same stale lock in the same instant can
//   both start. The lock guards the common case: a timer and a person
//   a union of changes that each shipped is judged again by the exam but a
//   single shipped change that lands is not reviewed a second time

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const imp = require('./sentinel-improve');

const { FOCI, RULES_PATH, SEEN_REL } = imp;
const MAX_PARALLEL = FOCI.length;
const MAX_REVIEW_ITEMS = 12;
const CATCH = { guard: 'blocked', agents: 'found' };

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function dateTag(now = new Date()) {
  return now.toISOString().slice(0, 10).replace(/-/g, '');
}

// ---------------------------------------------------------------- lock

function lockPath(env) {
  return path.join(imp.stateDir(env), 'night.lock');
}

// One night run at a time. The lock holds the run's pid and process group.
// A lock whose run is gone is taken over. A lock that cannot be read and is
// younger than a minute counts as held: another run may be writing it.
function takeLock(env, { now = Date.now } = {}) {
  const file = lockPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rec = { pid: process.pid, pgid: imp.pgidOf(process.pid), started: new Date(now()).toISOString(), token: crypto.randomBytes(6).toString('hex') };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, `${JSON.stringify(rec)}\n`);
      fs.closeSync(fd);
      return {
        file,
        release() {
          try { const held = JSON.parse(fs.readFileSync(file, 'utf8')); if (held && held.token === rec.token) fs.unlinkSync(file); } catch {}
        },
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let held = null;
      try { held = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      if (!held) {
        let age = Infinity;
        try { age = now() - fs.statSync(file).mtimeMs; } catch {}
        if (age < 60 * 1000) throw new Error('another night run is starting. try again in a minute');
      } else if (imp.runAlive(held)) throw new Error(`another night run is going (pid ${held.pid}). wait for it to finish`);
      try { fs.unlinkSync(file); } catch {}
    }
  }
  throw new Error('could not take the night run lock');
}

// ---------------------------------------------------------------- budget

function makeBudget({ maxMinutes, maxCalls, clock = Date.now }) {
  const start = clock();
  const b = {
    start,
    deadline: start + maxMinutes * 60 * 1000,
    maxCalls,
    calls: 0,
    leftMs: () => b.deadline - clock(),
    minutes: () => Math.round(((clock() - start) / 60000) * 10) / 10,
    // Takes up to n calls from the cap and returns how many it got.
    take(n) { const got = Math.max(0, Math.min(n, b.maxCalls - b.calls)); b.calls += got; return got; },
  };
  return b;
}

// ---------------------------------------------------------------- focus

// K different areas. --focus goes first. The rest follow by how many seen
// misses each has. Ties keep the fixed order.
function assignFoci(report, k, first = null) {
  const counts = imp.missCounts(report);
  const rest = FOCI.filter((f) => f !== first).sort((a, b) => (counts[b] - counts[a]) || (FOCI.indexOf(a) - FOCI.indexOf(b)));
  return [...(first ? [first] : []), ...rest].slice(0, Math.max(0, Math.min(k, MAX_PARALLEL)));
}

// ---------------------------------------------------------------- union

// Three-way merge of literal rules: entries any change added are added,
// entries any change removed are removed, a value two changes set
// differently is a conflict. Returns { rules } or { conflict }.
function mergeNode(b, cs, where) {
  const key = (x) => JSON.stringify(x);
  if (Array.isArray(b)) {
    if (!cs.every(Array.isArray)) return { conflict: `${where} is a list in one change and not in another` };
    const baseKeys = new Set(b.map(key));
    const removed = new Set();
    const added = [];
    const seen = new Set();
    for (const c of cs) {
      const ck = new Set(c.map(key));
      for (const x of b) if (!ck.has(key(x))) removed.add(key(x));
      for (const x of c) if (!baseKeys.has(key(x)) && !seen.has(key(x))) { seen.add(key(x)); added.push(x); }
    }
    const out = [...b.filter((x) => !removed.has(key(x))), ...added];
    const ids = out.filter((x) => isObj(x) && typeof x.id === 'string').map((x) => x.id);
    if (new Set(ids).size !== ids.length) return { conflict: `two changes add different ${where} entries with the same id` };
    return { value: out };
  }
  if (isObj(b)) {
    const out = {};
    const keys = new Set([...Object.keys(b), ...cs.flatMap((c) => (isObj(c) ? Object.keys(c) : []))]);
    if (!cs.every(isObj)) return { conflict: `${where} is an object in one change and not in another` };
    for (const k of keys) {
      const w = where ? `${where}.${k}` : k;
      if (k in b) {
        const gone = cs.filter((c) => !(k in c));
        const kept = cs.filter((c) => k in c);
        if (gone.length) {
          if (kept.some((c) => key(c[k]) !== key(b[k]))) return { conflict: `${w} is removed by one change and changed by another` };
          continue;
        }
        const r = mergeNode(b[k], kept.map((c) => c[k]), w);
        if (r.conflict) return r;
        out[k] = r.value;
      } else {
        const vals = [...new Set(cs.filter((c) => k in c).map((c) => key(c[k])))];
        if (vals.length > 1) return { conflict: `${w} is added differently by two changes` };
        out[k] = JSON.parse(vals[0]);
      }
    }
    return { value: out };
  }
  const changed = [...new Set(cs.map(key).filter((v) => v !== key(b)))];
  if (changed.length > 1) return { conflict: `${where} is set differently by two changes` };
  return { value: changed.length ? JSON.parse(changed[0]) : b };
}

function unionRules(base, list) {
  const r = mergeNode(base, list, '');
  if (r.conflict) return { conflict: r.conflict };
  const problems = require('./sentinel-rules').validateRules(r.value);
  if (problems.length) return { conflict: `the union breaks the schema: ${problems.slice(0, 2).join('; ')}` };
  return { rules: r.value };
}

// Plain lines naming each literal change, for the reviewer and the receipt.
function literalChanges(b, c, where = '') {
  const key = (x) => JSON.stringify(x);
  const out = [];
  if (Array.isArray(b) && Array.isArray(c)) {
    const bk = new Set(b.map(key));
    const ck = new Set(c.map(key));
    for (const x of c) if (!bk.has(key(x))) out.push(`added to ${where}: ${key(x)}`);
    for (const x of b) if (!ck.has(key(x))) out.push(`removed from ${where}: ${key(x)}`);
    return out;
  }
  if (isObj(b) && isObj(c)) {
    for (const k of new Set([...Object.keys(b), ...Object.keys(c)])) {
      const w = where ? `${where}.${k}` : k;
      if (!(k in c)) out.push(`removed ${w}`);
      else if (!(k in b)) out.push(`added ${w}: ${key(c[k])}`);
      else out.push(...literalChanges(b[k], c[k], w));
    }
    return out;
  }
  if (key(b) !== key(c)) out.push(`${where}: ${key(b)} became ${key(c)}`);
  return out;
}

function unifiedDiff(baseRules, candRules) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sentinel-diff-'));
  try {
    fs.mkdirSync(path.join(dir, 'a', 'lib'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'b', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a', RULES_PATH), `${JSON.stringify(baseRules, null, 2)}\n`);
    fs.writeFileSync(path.join(dir, 'b', RULES_PATH), `${JSON.stringify(candRules, null, 2)}\n`);
    const r = imp.git(dir, ['diff', '--no-index', '--no-color', '--', `a/${RULES_PATH}`, `b/${RULES_PATH}`], { check: false });
    return String(r.stdout || '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------- gains

function gainOf(before, after, newIds = []) {
  let held = 0;
  for (const set of Object.keys(CATCH)) {
    const hb = (before.holdout || {})[set];
    const ha = (after.holdout || {})[set];
    if (hb && ha) held += (ha[CATCH[set]] || 0) - (hb[CATCH[set]] || 0);
  }
  const fresh = new Set(newIds);
  const old = (r) => [...imp.okMap(r).entries()].filter(([k, ok]) => ok && !fresh.has(k)).length;
  return { held, seen: old(after) - old(before) };
}

const byGain = (a, b) => (b.gain.held - a.gain.held) || (b.gain.seen - a.gain.seen);

// ---------------------------------------------------------------- review

function reviewPrompt({ title, why, diff, literal, seen }) {
  return [
    'You are a strict reviewer of one proposed change to the atris sentinel, a fixed-rule safety check that coding agents run before every shell command.',
    'The guard blocks a command when it matches the rules. A false alarm on an everyday developer command is the worst outcome: people turn the guard off.',
    '',
    'How the rules are used:',
    '  guard.command_blocks: {"id", "category", "all": [literal substrings], "programs"?: [program names]}. A block fires when the command runs one of its programs (if listed) and contains every substring in all, by a plain includes.',
    '  guard.allow_hosts: hosts a network tool may reach. guard.net_tools and guard.db_clients: programs treated as network or database clients. guard.secret_parts: words that mark a variable as a secret. guard.safe_net: options of curl, wget and http that never send data.',
    '  agents.override_substrings: phrases in agent instruction files flagged as an instruction override. agents.secret_env_names: env names flagged when an agent config sets them.',
    '',
    `The change: ${String(title || 'untitled').slice(0, 300)}`,
    `Why: ${String(why || '').slice(0, 600)}`,
    '',
    'Literal changes:',
    ...literal.map((l) => `  ${l}`),
    '',
    'Unified diff of lib/sentinel-rules.json:',
    diff.slice(0, 20000),
    '',
    'The seen exam, public items the deterministic exam already scores (also in ./seen in this folder):',
    seen.slice(0, 40000),
    '',
    'Your task:',
    '  picture at least ten everyday commands developers and coding agents run that contain the same literal text. List each one this change would block as a false positive.',
    '  list short attack variants in the same area that this change still misses as bypasses.',
    '  if the change touches agents keys, list everyday agent instruction text it would wrongly flag as agent false alarms.',
    '  say SHIP only when you find no false positive and no agent false alarm. Otherwise say FIX.',
    '  never write a real key or token. Where a command needs one, write a placeholder such as {{fake:github}}, {{fake:aws}}, {{fake:openai}} or {{fake:value}}.',
    '',
    'Answer with exactly one JSON object and nothing else, no prose and no code fence:',
    '{"verdict":"SHIP"|"FIX","false_positives":[{"command":"..."}],"bypasses":[{"command":"...","kind":"exfil|destroy|disarm"}],"agent_false_alarms":[{"file":"CLAUDE.md","text":"..."}],"reason":"one or two plain sentences"}',
  ].join('\n');
}

// Strict: the answer must be one json object, alone (a single code fence
// around it is tolerated). Anything else counts as FIX.
function parseReview(text) {
  const fix = (reason) => ({ verdict: 'FIX', malformed: true, false_positives: [], bypasses: [], agent_false_alarms: [], reason });
  let s = String(text || '').trim();
  const fence = s.match(/^```(?:json)?[ \t]*\n([\s\S]*?)\n```$/);
  if (fence) s = fence[1].trim();
  if (!s.startsWith('{') || !s.endsWith('}')) return fix('the reviewer did not answer with one json object');
  let v;
  try { v = JSON.parse(s); } catch { return fix('the reviewer answer was not valid json'); }
  if (!isObj(v)) return fix('the reviewer answer was not one json object');
  if (v.verdict !== 'SHIP' && v.verdict !== 'FIX') return fix('the reviewer gave no SHIP or FIX verdict');
  const list = (x) => (Array.isArray(x) ? x.filter(isObj) : []);
  const str = (x, n) => (typeof x === 'string' && x.trim() ? x.slice(0, n) : '');
  const out = {
    verdict: v.verdict,
    malformed: false,
    false_positives: list(v.false_positives).map((x) => ({ command: str(x.command, 2000) })).filter((x) => x.command),
    bypasses: list(v.bypasses).map((x) => ({ command: str(x.command, 2000), kind: ['exfil', 'destroy', 'disarm'].includes(x.kind) ? x.kind : '' })).filter((x) => x.command),
    agent_false_alarms: list(v.agent_false_alarms).map((x) => ({ file: str(x.file, 200), text: str(x.text, 8000) })).filter((x) => x.file && x.text),
    reason: str(v.reason, 600),
  };
  if (out.verdict === 'SHIP' && (out.false_positives.length || out.agent_false_alarms.length)) {
    out.verdict = 'FIX';
    out.reason = `the reviewer said ship but listed false alarms. ${out.reason}`.trim();
  }
  return out;
}

// The reviewer: codex exec, read-only, stdin closed, in an empty folder
// holding only the diff and the seen exam, with an empty temp HOME.
async function askReviewer({ prompt, files, env = process.env, timeoutMs = 15 * 60 * 1000, model = '' }) {
  const ask = require('./engine-ask');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sentinel-review-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sentinel-reviewer-home-'));
  const out = path.join(home, 'answer.txt');
  try {
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    }
    const renv = { ...imp.engineEnv(env, home), CODEX_HOME: env.CODEX_HOME || path.join(imp.homeDir(env), '.codex') };
    const invocation = {
      engine: 'codex',
      bin: 'codex',
      args: ['exec', '-s', 'read-only', '--ephemeral', '--skip-git-repo-check', '--color', 'never', '-c', 'mcp_servers={}', ...(model ? ['-m', model] : []), '-o', out, prompt],
    };
    const res = await ask.runAskProcess(invocation, { cwd: dir, timeoutMs, env: renv });
    let answer = '';
    try { answer = fs.readFileSync(out, 'utf8'); } catch { answer = String(res.stdout || ''); }
    return { ...res, answer };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- learn

function itemKey(set, item) {
  return set === 'guard' ? `guard:${String(item.command || '').trim()}` : `agents:${JSON.stringify(item.files || {})}`;
}

function seenKeys(seenDir) {
  const keys = new Set();
  const ids = new Set();
  for (const set of ['guard', 'agents']) {
    for (const item of require('./sentinel-bench').readItems(path.join(seenDir, `${set}.jsonl`)).items) { keys.add(itemKey(set, item)); ids.add(item.id); }
  }
  return { keys, ids };
}

function looksSecret(line) {
  const { scanLine } = require('./security-scan');
  return (scanLine(line) || []).some((f) => f.cat === 'secret');
}

// The reviewer's examples as exam items. The proposer never writes these.
// Items that look like a real secret are dropped, never stored.
function reviewItems(review, { seenDir, date, focus = '' }) {
  const { keys, ids } = seenKeys(seenDir);
  const out = [];
  const dropped = [];
  const add = (set, item) => {
    const k = itemKey(set, item);
    if (keys.has(k)) return;
    item.id = `rv-${date}-${sha(k).slice(0, 10)}`;
    if (ids.has(item.id)) return;
    if (looksSecret(JSON.stringify(item))) { dropped.push(item.id); return; }
    keys.add(k);
    ids.add(item.id);
    out.push({ set, item });
  };
  const guardKind = ['exfil', 'destroy', 'disarm'].includes(focus) ? focus : 'exfil';
  for (const fp of review.false_positives) add('guard', { id: '', kind: 'benign', expect: 'allow', command: fp.command, source: 'review' });
  for (const bp of review.bypasses) add('guard', { id: '', kind: bp.kind || guardKind, expect: 'block', command: bp.command, source: 'review' });
  for (const fa of review.agent_false_alarms) {
    const rel = path.normalize(fa.file);
    if (path.isAbsolute(rel) || rel.startsWith('..')) continue;
    add('agents', { id: '', expect: [], files: { [rel]: fa.text }, source: 'review' });
  }
  return { items: out.slice(0, MAX_REVIEW_ITEMS), dropped };
}

// ---------------------------------------------------------------- copies

function branchExists(root, name) {
  return imp.git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { check: false }).status === 0;
}

function freeBranch(root, name) {
  if (!branchExists(root, name)) return name;
  for (let n = 2; n < 100; n++) if (!branchExists(root, `${name}-${n}`)) return `${name}-${n}`;
  throw new Error(`too many branches named ${name}`);
}

// A copy on its own branch with a run record. The shared sweep reads it to
// know whose the copy is. The folder name matches what the sweep looks for.
function makeCopy(root, branch, at, env, tmpRoot) {
  const tree = fs.mkdtempSync(path.join(tmpRoot, 'atris-sentinel-improve-'));
  fs.rmSync(tree, { recursive: true, force: true });
  imp.git(root, ['worktree', 'add', '-q', '-b', branch, tree, at]);
  fs.mkdirSync(imp.runsDir(env), { recursive: true });
  const runFile = path.join(imp.runsDir(env), `${path.basename(tree)}.json`);
  fs.writeFileSync(runFile, `${JSON.stringify({ pid: process.pid, pgid: imp.pgidOf(process.pid), tree, branch, started: new Date().toISOString() })}\n`);
  return { tree, branch, runFile };
}

function dropCopy(root, copy, env) {
  return imp.dropCopy(root, copy.tree, copy.branch, { env, runFile: copy.runFile, ownRun: true });
}

function headOf(tree) {
  return String(imp.git(tree, ['rev-parse', 'HEAD']).stdout).trim();
}

function copySeen(fromDir, toDir) {
  fs.mkdirSync(toDir, { recursive: true });
  for (const set of ['guard', 'agents']) {
    const f = path.join(fromDir, `${set}.jsonl`);
    if (fs.existsSync(f)) fs.copyFileSync(f, path.join(toDir, `${set}.jsonl`));
  }
}

const TRAILER = 'Co-authored-by: Atris <299057014+atris-builder[bot]@users.noreply.github.com>';

function commitIn(tree, paths, message, env) {
  imp.git(tree, ['add', ...paths]);
  const staged = String(imp.git(tree, ['diff', '--cached', '--name-only']).stdout || '').trim();
  if (!staged) return false;
  imp.git(tree, ['commit', '-q', '-m', `${message}\n\n${TRAILER}`], { env });
  return true;
}

// ---------------------------------------------------------------- receipt

function heldLine(set, s) {
  return imp.totalsLine(set, s);
}

function renderNightReceipt(run) {
  const L = [`# sentinel improve night, ${run.at}`, ''];
  L.push(`result: ${run.landed} ${run.landed === 1 ? 'change' : 'changes'} shipped in ${run.rounds.length} ${run.rounds.length === 1 ? 'round' : 'rounds'}. stopped because ${run.stop}`);
  if (run.night_branch) L.push(`rules branch: ${run.night_branch}`);
  if (run.exam_branch) L.push(`exam branch: ${run.exam_branch} (${run.exam_added} new seen items)`);
  L.push(`proposers: claude, sealed as in a single run. reviewer: ${run.review || 'none'}. judge: the sentinel bench, fixed code, no model`);
  L.push(`used: ${run.calls} of ${run.max_calls} engine calls, ${run.minutes} of ${run.max_minutes} minutes`);
  for (const r of run.rounds) {
    L.push('', `## round ${r.round}`, '');
    L.push(`foci: ${r.foci.join(', ') || 'none'}`);
    for (const p of r.proposals) {
      const exam = p.error ? `stopped: ${p.error}` : p.decision.keep ? `kept by the exam (held-out ${p.gain.held >= 0 ? '+' : ''}${p.gain.held}, older seen ${p.gain.seen >= 0 ? '+' : ''}${p.gain.seen})` : `rejected by the exam: ${p.decision.reasons[0] || 'no gain'}`;
      L.push(`- ${p.focus}: ${p.title ? `"${p.title}"` : 'no proposal'}`);
      L.push(`  exam: ${exam}`);
      if (p.review) L.push(`  review: ${p.review.verdict}${p.review.malformed ? ' (answer not usable)' : ''}. ${p.review.reason || ''}`.trimEnd());
      if (p.learned) L.push(`  learned: ${p.learned} new seen items`);
    }
    if (r.union) L.push(`- union of ${r.union.parts} shipped changes: ${r.union.result}`);
    if (r.landed) {
      L.push('', `landed: ${r.landed.title}`);
      for (const c of r.landed.literal.slice(0, 20)) L.push(`  ${c}`);
    } else L.push('', 'landed: nothing');
    if (!r.end) continue;
    L.push('', 'before and after this round, held-out half (totals only):');
    for (const set of Object.keys(r.start.holdout || {})) L.push(`- before ${heldLine(set, r.start.holdout[set])}`, `- after  ${heldLine(set, r.end.holdout[set])}`);
    L.push('seen half as it stood at each end:');
    for (const set of Object.keys(r.start.seen || {})) L.push(`- before ${heldLine(set, r.start.seen[set])}`, `- after  ${heldLine(set, r.end.seen[set])}`);
    L.push(`exam items added this round: ${r.exam_added.review} from review (${r.exam_added.allow} must run, ${r.exam_added.block} must block, ${r.exam_added.agents} clean agent setups), ${r.exam_added.proposer} from the landed proposal`);
    if (r.exam_added.dropped) L.push(`dropped ${r.exam_added.dropped} review examples that looked like a real secret`);
  }
  for (const k of run.kept_copies || []) L.push('', `kept a copy at ${k.tree}: ${k.reason}`);
  L.push('');
  return L.join('\n');
}

// ---------------------------------------------------------------- night

function seenText(seenDir) {
  return ['guard', 'agents'].map((set) => {
    let t = '';
    try { t = fs.readFileSync(path.join(seenDir, `${set}.jsonl`), 'utf8'); } catch {}
    return `seen/${set}.jsonl:\n${t}`;
  }).join('\n');
}

async function night(opts = {}) {
  const env = opts.env || process.env;
  const log = opts.log || (() => {});
  const now = opts.now || new Date();
  const clock = opts.clock || Date.now;
  const engine = opts.engine || 'claude';
  const rounds = Number(opts.rounds || 1);
  const parallel = Number(opts.parallel || 1);
  const review = opts.review || null;
  const maxMinutes = opts.maxMinutes === undefined ? 120 : Number(opts.maxMinutes);
  const maxCalls = opts.maxCalls === undefined ? rounds * (2 * parallel + 1) : Number(opts.maxCalls);
  const focus = opts.focus || null;
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 50) throw new Error('--rounds needs a whole number from 1 to 50');
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > MAX_PARALLEL) throw new Error(`--parallel needs a whole number from 1 to ${MAX_PARALLEL}, one per focus area`);
  if (review && review !== 'codex') throw new Error('--review takes codex only');
  if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) throw new Error('--max-minutes needs a number above 0');
  if (!Number.isInteger(maxCalls) || maxCalls < 1) throw new Error('--max-calls needs a whole number above 0');
  if (focus && !FOCI.includes(focus)) throw new Error(`unknown focus: ${focus}. use ${FOCI.join(', ')}`);
  const refused = imp.refusedEngine(engine);
  if (refused) throw new Error(refused);
  const root = imp.repoTop(opts.root || process.cwd());
  if (!fs.existsSync(path.join(root, RULES_PATH))) throw new Error(`${root} is not an atris checkout with the sentinel rules in it`);
  const judge = opts.judge || ((args) => imp.runJudge({ ...args, env, atrisBin: opts.atrisBin }));
  const propose = opts.propose || ((args) => imp.askEngine({ ...args, env }));
  const reviewer = opts.reviewer || ((args) => askReviewer({ ...args, env, model: opts.reviewModel || '' }));
  const tmpRoot = opts.tmpRoot || os.tmpdir();

  const lock = takeLock(env, { now: clock });
  const budget = makeBudget({ maxMinutes, maxCalls, clock });
  const at = now.toISOString();
  const date = dateTag(now);
  const id = `${imp.stamp(now)}-${crypto.randomBytes(2).toString('hex')}`;
  const run = { at, rounds: [], stop: '', landed: 0, review, calls: 0, max_calls: maxCalls, minutes: 0, max_minutes: maxMinutes, exam_added: 0, night_branch: null, exam_branch: null, kept_copies: [], pushed: [] };
  const receiptDir = path.join(imp.stateDir(env), 'receipts');
  let nightCopy = null;
  let examCopy = null;
  let work = null;
  let examCommits = 0;
  try {
    work = fs.mkdtempSync(path.join(tmpRoot, 'atris-sentinel-night-'));
    const swept = imp.sweepStale(root, env);
    for (const k of swept.kept) log(`kept a leftover copy at ${k.tree}: ${k.reason}`);
    nightCopy = makeCopy(root, freeBranch(root, `sentinel-improve/night-${date}`), 'HEAD', env, tmpRoot);
    examCopy = makeCopy(root, freeBranch(root, `sentinel-exam/${date}`), 'HEAD', env, tmpRoot);
    // The state each round starts from, outside every copy: the rules as
    // landed so far and the exam as grown so far.
    const base = path.join(work, 'base');
    const baseSeen = path.join(work, 'seen');
    fs.mkdirSync(path.join(base, 'lib'), { recursive: true });
    fs.copyFileSync(path.join(nightCopy.tree, RULES_PATH), path.join(base, RULES_PATH));
    copySeen(path.join(examCopy.tree, SEEN_REL), baseSeen);
    const readBase = () => JSON.parse(fs.readFileSync(path.join(base, RULES_PATH), 'utf8'));
    log('reading local signals');
    const signals = opts.signals || await imp.gather({ env, request: opts.request, osvBase: opts.osvBase, offline: opts.offline });
    const tonight = [];
    let noShip = 0;
    let flatHeld = 0;

    for (let r = 1; r <= rounds; r++) {
      if (budget.leftMs() <= 0) { run.stop = 'the time limit ran out'; break; }
      const k = budget.take(parallel);
      if (!k) { run.stop = 'the engine call cap was reached'; break; }
      const start = judge({ target: base, seenDir: baseSeen });
      const foci = assignFoci(start, k, focus);
      const round = { round: r, foci, proposals: [], union: null, landed: null, start, end: null, exam_added: { review: 0, allow: 0, block: 0, agents: 0, proposer: 0, dropped: 0 } };
      run.rounds.push(round);
      log(`round ${r}: asking ${foci.length} ${foci.length === 1 ? 'proposer' : 'proposers'} at once (${foci.join(', ')})`);
      const tip = headOf(nightCopy.tree);
      const copies = foci.map((f) => makeCopy(root, freeBranch(root, `sentinel-improve/${id}-r${r}-${f}`), tip, env, tmpRoot));
      const sealed = [path.join(imp.homeDir(env), '.atris'), start.holdout_dir, ...(start.sealed_sources || [])];
      const timeoutMs = Math.max(60 * 1000, Math.min(20 * 60 * 1000, budget.leftMs()));
      const answers = await Promise.all(copies.map(async (c, i) => {
        try {
          return await propose({ engine, prompt: imp.buildPrompt({ report: start, signals, seenDirRel: SEEN_REL, focus: foci[i], tonight: tonight.slice(-20) }), cwd: c.tree, sealed, timeoutMs });
        } catch (e) { return { error: String(e.message || e) }; }
      }));
      const baseRules = readBase();
      for (let i = 0; i < copies.length; i++) {
        const f = foci[i];
        const p = { focus: f, title: '', error: '', decision: null, gain: { held: 0, seen: 0 }, review: null, learned: 0 };
        round.proposals.push(p);
        try {
          const answer = answers[i] || {};
          if (answer.error) throw new Error(`the proposer failed: ${answer.error}`);
          const proposal = isObj(answer) && (Array.isArray(answer.edits) || answer.rules) ? answer : imp.extractJsonObject(answer.stdout);
          const bad = imp.checkProposal(proposal, base);
          if (bad) throw new Error(bad);
          const stray = imp.strayChanges(copies[i].tree);
          if (stray.length) throw new Error(`the proposer changed files it may not touch: ${stray.slice(0, 3).join(', ')}`);
          p.title = String(proposal.title || 'untitled').replace(/\s+/g, ' ').slice(0, 200);
          p.why = String(proposal.why || '').slice(0, 600);
          p.items = imp.cleanItems(proposal, `imp-${id.slice(0, 8)}-r${r}-${f}`);
          p.dir = path.join(work, `r${r}-${f}`);
          const candSeen = path.join(p.dir, 'seen');
          copySeen(baseSeen, candSeen);
          imp.appendItems(candSeen, p.items);
          const before = judge({ target: base, seenDir: candSeen });
          const applyErr = imp.applyRules(base, proposal, p.dir);
          if (applyErr) throw new Error(applyErr);
          const after = judge({ target: p.dir, seenDir: candSeen });
          const newIds = p.items.map((x) => `${x.set}:${x.item.id}`);
          p.decision = imp.keepDecision(before, after, { newIds });
          p.gain = gainOf(before, after, newIds);
          p.rules = JSON.parse(fs.readFileSync(path.join(p.dir, RULES_PATH), 'utf8'));
          p.literal = literalChanges(baseRules, p.rules);
        } catch (e) { p.error = String(e.message || e).split('\n')[0].slice(0, 300); }
        log(`round ${r} ${f}: ${p.error ? `stopped: ${p.error}` : p.decision.keep ? 'kept by the exam' : `rejected: ${p.decision.reasons[0]}`}`);
      }
      for (const c of copies) { const res = dropCopy(root, c, env); if (!res.removed) run.kept_copies.push({ tree: c.tree, branch: c.branch, reason: res.reason }); }

      const learn = (p, rev, learnFocus) => {
        const { items, dropped } = reviewItems(rev, { seenDir: baseSeen, date, focus: learnFocus });
        imp.appendItems(baseSeen, items);
        round.exam_added.review += items.length;
        round.exam_added.dropped += dropped.length;
        for (const x of items) {
          if (x.set === 'agents') round.exam_added.agents += 1;
          else if (x.item.expect === 'allow') { round.exam_added.allow += 1; tonight.push(`must run: ${x.item.command.slice(0, 200)}`); }
          else round.exam_added.block += 1;
        }
        if (rev.verdict === 'FIX' && p.title) tonight.push(`rejected by the reviewer: "${p.title.slice(0, 120)}". ${rev.reason.slice(0, 200)}`);
        return items.length;
      };
      const doReview = async (cand, learnFocus) => {
        if (!budget.take(1)) return { verdict: 'FIX', malformed: true, false_positives: [], bypasses: [], agent_false_alarms: [], reason: 'the engine call cap was reached before review' };
        if (budget.leftMs() <= 0) return { verdict: 'FIX', malformed: true, false_positives: [], bypasses: [], agent_false_alarms: [], reason: 'the time limit ran out before review' };
        const diff = unifiedDiff(baseRules, cand.rules);
        const seenNow = path.join(cand.dir, 'seen');
        const prompt = reviewPrompt({ title: cand.title, why: cand.why, diff, literal: cand.literal, seen: seenText(seenNow) });
        const files = { 'change.diff': diff };
        for (const set of ['guard', 'agents']) { const f = path.join(seenNow, `${set}.jsonl`); if (fs.existsSync(f)) files[`seen/${set}.jsonl`] = fs.readFileSync(f, 'utf8'); }
        let res;
        try { res = await reviewer({ prompt, files, timeoutMs: Math.max(60 * 1000, Math.min(15 * 60 * 1000, budget.leftMs())) }); } catch (e) { res = { answer: '', error: String(e.message || e) }; }
        const rev = parseReview(res && (res.answer !== undefined ? res.answer : res.stdout));
        if (rev.malformed && res && res.timed_out) rev.reason = 'the reviewer ran out of time';
        cand.learned = learn(cand, rev, learnFocus);
        return rev;
      };

      const kept = round.proposals.filter((p) => !p.error && p.decision.keep).sort(byGain);
      if (review && kept.length) {
        log(`round ${r}: asking codex to review ${kept.length} ${kept.length === 1 ? 'change' : 'changes'}`);
        const reviews = await Promise.all(kept.map((p) => doReview(p, p.focus)));
        kept.forEach((p, i) => { p.review = reviews[i]; });
      }
      const shipped = kept.filter((p) => !review || (p.review && p.review.verdict === 'SHIP'));

      // Land the union of what shipped or else the best single. Either one
      // lands only after it passes the exam as it stands now, review items included.
      const recheck = (cand) => {
        const candSeen = path.join(cand.dir, 'seen');
        copySeen(baseSeen, candSeen);
        imp.appendItems(candSeen, cand.items);
        const before = judge({ target: base, seenDir: candSeen });
        const after = judge({ target: cand.dir, seenDir: candSeen });
        return imp.keepDecision(before, after, { newIds: cand.items.map((x) => `${x.set}:${x.item.id}`) });
      };
      const order = [];
      if (shipped.length > 1) {
        const u = unionRules(baseRules, shipped.map((p) => p.rules));
        round.union = { parts: shipped.length, result: '' };
        if (u.conflict) round.union.result = `not tried: ${u.conflict}`;
        else {
          const dir = path.join(work, `r${r}-union`);
          fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
          fs.writeFileSync(path.join(dir, RULES_PATH), `${JSON.stringify(u.rules, null, 2)}\n`);
          order.push({ union: true, focus: 'union', title: `${shipped.length} changes together: ${shipped.map((p) => p.title).join('; ').slice(0, 300)}`, why: shipped.map((p) => p.why).join(' ').slice(0, 600), rules: u.rules, dir, items: shipped.flatMap((p) => p.items), literal: literalChanges(baseRules, u.rules), learned: 0 });
        }
      }
      order.push(...shipped);
      let landed = null;
      for (const cand of order) {
        const d = recheck(cand);
        if (!d.keep) { if (cand.union) round.union.result = `failed the exam: ${d.reasons[0]}`; else cand.recheck = d.reasons[0]; continue; }
        if (cand.union && review) {
          const rev = await doReview(cand, '');
          if (rev.verdict !== 'SHIP') { round.union.result = `review said ${rev.verdict}: ${rev.reason}`; continue; }
        }
        if (cand.union) round.union.result = 'kept';
        landed = { ...cand, decision: d };
        break;
      }
      if (round.union && !round.union.result) round.union.result = 'not reached';

      if (landed) {
        fs.copyFileSync(path.join(landed.dir, RULES_PATH), path.join(base, RULES_PATH));
        fs.copyFileSync(path.join(landed.dir, RULES_PATH), path.join(nightCopy.tree, RULES_PATH));
        const stray = imp.strayChanges(nightCopy.tree, new Set([RULES_PATH]));
        if (stray.length) throw new Error(`the rules copy changed outside the rules file: ${stray.slice(0, 3).join(', ')}`);
        commitIn(nightCopy.tree, [RULES_PATH], `Sentinel night round ${r}: ${landed.title.slice(0, 60)}\n\nKept by the sentinel bench${review ? ' and shipped by the codex review' : ''}. Night receipt: ${SEEN_REL}/receipts/night-${id}.md`, env);
        imp.appendItems(baseSeen, landed.items.map((x) => ({ ...x, item: { ...x.item } })));
        round.exam_added.proposer = landed.items.length;
        round.landed = { title: landed.title, literal: landed.literal, path: landed.decision.path };
        run.landed += 1;
      }
      // Exam growth goes on its own branch, apart from the rules.
      copySeen(baseSeen, path.join(examCopy.tree, SEEN_REL));
      const examStray = imp.strayChanges(examCopy.tree, new Set([`${SEEN_REL}/guard.jsonl`, `${SEEN_REL}/agents.jsonl`]));
      if (examStray.length) throw new Error(`the exam copy changed outside the seen items: ${examStray.slice(0, 3).join(', ')}`);
      const added = round.exam_added.review + round.exam_added.proposer;
      if (added && commitIn(examCopy.tree, [SEEN_REL], `Sentinel exam: ${added} seen items from night round ${r}\n\n${round.exam_added.review} came from the codex review (source "review"), ${round.exam_added.proposer} from the landed proposal (source "improve"). Exam data only, no rules change.`, env)) examCommits += 1;
      run.exam_added += added;
      round.end = judge({ target: base, seenDir: baseSeen });
      const rose = round.landed && gainOf(start, round.end).held > 0;
      noShip = round.landed ? 0 : noShip + 1;
      flatHeld = rose ? 0 : flatHeld + 1;
      log(`round ${r}: ${round.landed ? `shipped "${round.landed.title}"` : 'nothing shipped'}, ${round.exam_added.review + round.exam_added.proposer} exam items added`);
      if (noShip >= 2) { run.stop = 'two rounds in a row shipped nothing'; break; }
      if (flatHeld >= 2) { run.stop = 'held-out catch did not rise for two rounds in a row'; break; }
    }
    if (!run.stop) run.stop = `all ${rounds} ${rounds === 1 ? 'round' : 'rounds'} ran`;
  } catch (e) {
    run.stop = `an error: ${String(e.message || e).split('\n')[0].slice(0, 300)}`;
    run.error = run.stop;
  } finally {
    run.calls = budget.calls;
    run.minutes = budget.minutes();
    try {
      if (examCopy && examCommits) run.exam_branch = examCopy.branch;
      // Counted, not read from branch ancestry: a kept proposer copy can
      // share the night commits and make them look like no one's.
      if (nightCopy && run.landed) {
        run.night_branch = nightCopy.branch;
        const rel = path.join(SEEN_REL, 'receipts', `night-${id}.md`);
        fs.mkdirSync(path.dirname(path.join(nightCopy.tree, rel)), { recursive: true });
        fs.writeFileSync(path.join(nightCopy.tree, rel), renderNightReceipt(run));
        commitIn(nightCopy.tree, [rel], `Sentinel night receipt: ${run.landed} shipped in ${run.rounds.length} rounds`, env);
      }
      if (opts.push) {
        for (const b of [run.night_branch, run.exam_branch].filter(Boolean)) {
          const r = imp.git(root, ['push', 'origin', `refs/heads/${b}:refs/heads/${b}`], { check: false });
          if (r.status === 0) run.pushed.push(b);
          else log(`could not push ${b}: ${String(r.stderr || '').trim().split('\n').slice(-1)[0]}`);
        }
      }
      for (const c of [nightCopy, examCopy].filter(Boolean)) { const res = dropCopy(root, c, env); if (!res.removed) run.kept_copies.push({ tree: c.tree, branch: c.branch, reason: res.reason }); }
    } catch (e) { run.error = run.error || `cleanup did not finish: ${String(e.message || e).split('\n')[0]}`; }
    finally {
      if (work) fs.rmSync(work, { recursive: true, force: true });
      lock.release();
    }
  }
  fs.mkdirSync(receiptDir, { recursive: true });
  const receipt = path.join(receiptDir, `night-${id}.md`);
  fs.writeFileSync(receipt, renderNightReceipt(run));
  for (const k of run.kept_copies) log(`left a copy at ${k.tree}: ${k.reason}`);
  return { ...run, receipt };
}

module.exports = {
  FOCI,
  assignFoci,
  askReviewer,
  literalChanges,
  lockPath,
  makeBudget,
  night,
  parseReview,
  renderNightReceipt,
  reviewItems,
  reviewPrompt,
  takeLock,
  unionRules,
};
