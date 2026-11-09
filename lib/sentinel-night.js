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
//   CODEX_HOME), a stripped environment and no mcp servers. Its prompt tells
//   it to read nothing outside that folder. Nothing here passes it the
//   held-out folder, a held-out item or the key
//   a night run refuses to start its engines unless the judge reports that
//   the held-out key came from the keychain. A key file could be read
//   every review example passes three checks before it joins the exam: the
//   strict secret check (no suppression marker, no placeholder pass), a
//   dedupe and the judge's screen. The screen refuses any example that equals,
//   contains or sits inside a held-out item. The screen runs in the judge's
//   own process. Only refused ids leave it. If it cannot run, nothing joins
//   the reviewer answer is cut at 64 KB and its lists at the item limit
//   before anything is read. Missing, extra or mistyped fields mean FIX
//   receipts are scanned line by line before they are written
//   nothing lands without the exam passing on the exam as it stands at
//   landing time, review items included
//   one night run at a time per machine, by a lock file holding its pid.
//   A lock is never taken over. Only --break-lock clears it, and only when
//   its owner is gone
//   the reviewer's reason text is dropped after its shape is checked. Only
//   its verdict and the counts of accepted examples go anywhere
//   proposer exam items pass the same strict secret check as review items.
//   One flagged item rejects the whole proposal before it is judged
//   every copy goes through the same safe cleanup as a single run
//   nothing merges, releases or pushes to the main branch. With --push the
//   two night branches are pushed by name and nothing else
//
// Accepted limits:
//
//   codex read-only can still read files on this computer outside its
//   folder. The held-out half is encrypted at rest and its key sits in the
//   keychain. The empty HOME does not link it in. Even a read that worked
//   could not move a held-out item into the seen half past the screen
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

const PUSH_MS = 2 * 60 * 1000;

class TimeUp extends Error {
  constructor() { super('the time limit ran out'); this.timeUp = true; }
}
const isTimeUp = (e) => Boolean(e && (e.timeUp || /ran out of time/.test(String(e.message || ''))));

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function dateTag(now = new Date()) {
  return now.toISOString().slice(0, 10).replace(/-/g, '');
}

// ---------------------------------------------------------------- lock

function lockPath(env) {
  return path.join(imp.stateDir(env), 'night.lock');
}

function readLock(file) {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return isObj(v) ? v : null; } catch { return null; }
}

function lockAge(file, now) {
  try { return Math.max(0, Math.round((now() - fs.statSync(file).mtimeMs) / 60000)); } catch { return null; }
}

const BREAK_HINT = 'clear it with: atris sentinel improve --break-lock';

// One night run at a time. The lock file is made only by an exclusive
// create and holds the run's pid, process group and a random token. There
// is no automatic takeover: when a lock exists the run stops and says who
// holds it and how old it is. A person clears a dead owner's lock with
// --break-lock (breakLock below).
function takeLock(env, { now = Date.now } = {}) {
  const file = lockPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rec = { pid: process.pid, pgid: imp.pgidOf(process.pid), started: new Date(now()).toISOString(), token: crypto.randomBytes(8).toString('hex') };
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const held = readLock(file);
    const age = lockAge(file, now);
    const ageText = age === null ? 'of unknown age' : `${age} ${age === 1 ? 'minute' : 'minutes'} old`;
    if (!held) throw new Error(`a night run lock exists at ${file} that cannot be read (${ageText}). if no night run is going, remove that file by hand`);
    const alive = imp.runAlive(held);
    throw new Error(`another night run holds the lock: pid ${held.pid}, ${alive ? 'still running' : 'no longer running'}, ${ageText}. ${alive ? 'wait for it to finish' : BREAK_HINT}`);
  }
  fs.writeSync(fd, `${JSON.stringify(rec)}\n`);
  fs.closeSync(fd);
  return {
    file,
    release() { const held = readLock(file); if (held && held.token === rec.token) { try { fs.unlinkSync(file); } catch {} } },
  };
}

// --break-lock: removes the lock only when its owner is not alive. A lock
// that cannot be read is left alone.
function breakLock(env) {
  const file = lockPath(env);
  if (!fs.existsSync(file)) return { removed: false, message: 'there is no night run lock' };
  const held = readLock(file);
  if (!held) return { removed: false, refused: true, message: `the lock at ${file} cannot be read. remove it by hand only if no night run is going` };
  if (imp.runAlive(held)) return { removed: false, refused: true, message: `the night run that holds the lock is still running (pid ${held.pid}). the lock stays` };
  const again = readLock(file);
  if (!again || again.token !== held.token) return { removed: false, refused: true, message: 'the lock changed while it was checked. the lock stays' };
  fs.unlinkSync(file);
  return { removed: true, message: `removed the lock of pid ${held.pid}. that run is no longer running` };
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
    'Read only the files in this folder. Do not read, list or search anything outside it. Never open a held-out exam, a key file or the keychain.',
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

const MAX_ANSWER_BYTES = 64 * 1024;
const REVIEW_KEYS = ['verdict', 'false_positives', 'bypasses', 'agent_false_alarms', 'reason'];
const LIST_SHAPES = {
  false_positives: { need: ['command'], may: [] },
  bypasses: { need: ['command'], may: ['kind'] },
  agent_false_alarms: { need: ['file', 'text'], may: [] },
};
const FIELD_MAX = { command: 2000, file: 200, text: 8000, kind: 20 };

// Strict and fail-closed: the answer must be at most 64 KB and one json
// object, alone (a single code fence around it is tolerated), with exactly
// the verdict, the three lists and an optional reason. Every list entry must
// be an object with exactly its string keys. Lists are cut to the item limit
// before any entry is read. Anything else is FIX. A SHIP that lists any
// example is FIX.
function parseReview(text) {
  const fix = (reason) => ({ verdict: 'FIX', malformed: true, false_positives: [], bypasses: [], agent_false_alarms: [], reason });
  const raw = String(text || '');
  if (Buffer.byteLength(raw, 'utf8') > MAX_ANSWER_BYTES) return fix('the reviewer answer was longer than 64 KB');
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?[ \t]*\n([\s\S]*?)\n```$/);
  if (fence) s = fence[1].trim();
  if (!s.startsWith('{') || !s.endsWith('}')) return fix('the reviewer did not answer with one json object');
  let v;
  try { v = JSON.parse(s); } catch { return fix('the reviewer answer was not valid json'); }
  if (!isObj(v)) return fix('the reviewer answer was not one json object');
  const extra = Object.keys(v).filter((k) => !REVIEW_KEYS.includes(k));
  if (extra.length) return fix('the reviewer answer had unknown fields');
  if (v.verdict !== 'SHIP' && v.verdict !== 'FIX') return fix('the reviewer gave no SHIP or FIX verdict');
  if (v.reason !== undefined && typeof v.reason !== 'string') return fix('the reviewer reason was not text');
  // The reviewer's own reason text is checked for shape and then dropped. It
  // never reaches a proposer, a receipt or a commit: only the verdict and
  // the counts of accepted examples do. Every reason below is written here.
  const out = { verdict: v.verdict, malformed: false, reason: '' };
  for (const [name, shape] of Object.entries(LIST_SHAPES)) {
    if (!Array.isArray(v[name])) return fix(`the reviewer answer had no ${name} list`);
    const list = v[name].slice(0, MAX_REVIEW_ITEMS);
    const clean = [];
    for (const entry of list) {
      if (!isObj(entry)) return fix(`a ${name} entry was not an object`);
      const keys = Object.keys(entry);
      if (keys.some((k) => !shape.need.includes(k) && !shape.may.includes(k))) return fix(`a ${name} entry had an unknown key`);
      const item = {};
      for (const k of keys) {
        if (typeof entry[k] !== 'string' || !entry[k].trim() || entry[k].length > FIELD_MAX[k]) return fix(`a ${name} entry had a bad ${k}`);
        item[k] = entry[k];
      }
      if (shape.need.some((k) => !(k in item))) return fix(`a ${name} entry was missing a field`);
      if (name === 'bypasses' && item.kind !== undefined && !['exfil', 'destroy', 'disarm'].includes(item.kind)) return fix('a bypass had an unknown kind');
      clean.push(item);
    }
    out[name] = clean;
  }
  if (out.verdict === 'SHIP' && (out.false_positives.length || out.bypasses.length || out.agent_false_alarms.length)) {
    return { ...out, verdict: 'FIX', reason: 'the reviewer said ship but listed examples' };
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

// The strict secret check for anything a reviewer wrote. Unlike the repo
// scan it honors no suppression marker and no placeholder exemption: any
// line with a marker or any match of a secret rule counts.
const { strictSecret } = imp;

// Receipts are scanned before they are written. A line that fails the
// strict check is replaced, never written.
function scrubReceipt(text) {
  return String(text).split('\n').map((l) => (strictSecret(l) ? '[a line was removed here: it looked like a secret]' : l)).join('\n');
}

// The reviewer's examples as exam items. The proposer never writes these.
// The examples are cut to the item limit before any is hashed or scanned.
// Items that fail the strict secret check are dropped, never stored.
function reviewItems(review, { seenDir, date, focus = '' }) {
  const { keys, ids } = seenKeys(seenDir);
  const out = [];
  const dropped = [];
  const guardKind = ['exfil', 'destroy', 'disarm'].includes(focus) ? focus : 'exfil';
  const raw = [
    ...(review.false_positives || []).map((fp) => ['guard', { id: '', kind: 'benign', expect: 'allow', command: fp.command, source: 'review' }]),
    ...(review.bypasses || []).map((bp) => ['guard', { id: '', kind: bp.kind || guardKind, expect: 'block', command: bp.command, source: 'review' }]),
    ...(review.agent_false_alarms || []).map((fa) => {
      const rel = path.normalize(String(fa.file));
      return path.isAbsolute(rel) || rel.startsWith('..') ? null : ['agents', { id: '', expect: [], files: { [rel]: fa.text }, source: 'review' }];
    }),
  ].filter(Boolean).slice(0, MAX_REVIEW_ITEMS);
  for (const [set, item] of raw) {
    const k = itemKey(set, item);
    if (keys.has(k)) continue;
    item.id = `rv-${date}-${sha(k).slice(0, 10)}`;
    if (ids.has(item.id)) continue;
    if (!imp.gateValue(item)) { dropped.push(item.id); continue; }
    keys.add(k);
    ids.add(item.id);
    out.push({ set, item });
  }
  return { items: out, dropped };
}

// The judge already holds the held-out half. It refuses any review item
// that equals, contains or sits inside a held-out item. Only refused ids come
// back. Fail-closed: if the screen cannot run, every item is refused.
function runScreen(items, { env = process.env, atrisBin, dir, timeoutMs = 60 * 1000 } = {}) {
  if (!items.length) return { refused: [] };
  const all = { refused: items.map((x) => x.item.id) };
  const file = path.join(dir, `screen-${crypto.randomBytes(4).toString('hex')}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(items.map((x) => ({ id: x.item.id, set: x.set, item: x.item }))));
    const bin = atrisBin || path.join(__dirname, '..', 'bin', 'atris.js');
    const r = require('child_process').spawnSync(process.execPath, [bin, 'sentinel', 'bench', '--screen', file], { encoding: 'utf8', env: { ...env, ATRIS_SKIP_UPDATE_CHECK: '1' }, timeout: Math.max(1, Math.floor(timeoutMs)), maxBuffer: 8 * 1024 * 1024 });
    if (r.status !== 0) return all;
    const v = JSON.parse(String(r.stdout || '').trim().split('\n').pop());
    if (!v || v.ok !== true || !Array.isArray(v.refused) || v.unreadable) return all;
    return { refused: v.refused.filter((x) => typeof x === 'string') };
  } catch { return all; } finally { try { fs.unlinkSync(file); } catch {} }
}

// ---------------------------------------------------------------- copies

function branchExists(root, name, t) {
  return imp.git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { check: false, timeoutMs: t }).status === 0;
}

function freeBranch(root, name, t) {
  if (!branchExists(root, name, t)) return name;
  for (let n = 2; n < 100; n++) if (!branchExists(root, `${name}-${n}`, t)) return `${name}-${n}`;
  throw new Error(`too many branches named ${name}`);
}

// A copy on its own branch with a run record. The shared sweep reads it to
// know whose the copy is. The folder name matches what the sweep looks for.
function makeCopy(root, branch, at, env, tmpRoot, t) {
  const tree = fs.mkdtempSync(path.join(tmpRoot, 'atris-sentinel-improve-'));
  fs.rmSync(tree, { recursive: true, force: true });
  imp.git(root, ['worktree', 'add', '-q', '-b', branch, tree, at], { timeoutMs: t });
  fs.mkdirSync(imp.runsDir(env), { recursive: true });
  const runFile = path.join(imp.runsDir(env), `${path.basename(tree)}.json`);
  fs.writeFileSync(runFile, `${JSON.stringify({ pid: process.pid, pgid: imp.pgidOf(process.pid), tree, branch, started: new Date().toISOString() })}\n`);
  return { tree, branch, runFile };
}

function dropCopy(root, copy, env) {
  return imp.dropCopy(root, copy.tree, copy.branch, { env, runFile: copy.runFile, ownRun: true });
}

function headOf(tree, t) {
  return String(imp.git(tree, ['rev-parse', 'HEAD'], { timeoutMs: t }).stdout).trim();
}

function copySeen(fromDir, toDir) {
  fs.mkdirSync(toDir, { recursive: true });
  for (const set of ['guard', 'agents']) {
    const f = path.join(fromDir, `${set}.jsonl`);
    if (fs.existsSync(f)) fs.copyFileSync(f, path.join(toDir, `${set}.jsonl`));
  }
}

const TRAILER = 'Co-authored-by: Atris <299057014+atris-builder[bot]@users.noreply.github.com>';

function commitIn(tree, paths, message, env, t) {
  // Messages are fixed sentences with counts and ids. The gate checks them
  // anyway. One that fails is replaced by a bare fixed sentence.
  if (!imp.gateValue(message)) message = 'Sentinel night: one commit';
  imp.git(tree, ['add', ...paths], { timeoutMs: t });
  const staged = String(imp.git(tree, ['diff', '--cached', '--name-only'], { timeoutMs: t }).stdout || '').trim();
  if (!staged) return false;
  imp.git(tree, ['commit', '-q', '-m', `${message}\n\n${TRAILER}`], { env, timeoutMs: t });
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
      const exam = p.error || !p.decision ? `stopped: ${p.error || 'not judged'}` : p.decision.keep ? `kept by the exam (held-out ${p.gain.held >= 0 ? '+' : ''}${p.gain.held}, older seen ${p.gain.seen >= 0 ? '+' : ''}${p.gain.seen})` : `rejected by the exam: ${imp.fixedReason(p.decision.reasons[0]) || 'no gain'}`;
      L.push(`- ${p.focus}: ${p.title ? 'one proposal' : 'no usable proposal'}`);
      L.push(`  exam: ${exam}`);
      if (p.review) L.push(`  review: ${p.review.verdict}${p.review.malformed ? ' (answer not usable)' : ''}${p.review.reason ? `. ${p.review.reason}` : ''}`);
      if (p.learned) L.push(`  learned: ${p.learned} new seen items`);
    }
    if (r.union) L.push(`- union of ${r.union.parts} shipped changes: ${r.union.result}`);
    if (r.landed) {
      L.push('', `landed: ${r.landed.focus === 'union' ? 'the union of the shipped changes' : `the ${r.landed.focus} proposal`}`);
      for (const c of r.landed.literal.slice(0, 20)) L.push(`  ${c}`);
    } else L.push('', 'landed: nothing');
    if (!r.end) continue;
    L.push('', 'before and after this round, held-out half (totals only):');
    for (const set of Object.keys(r.start.holdout || {})) L.push(`- before ${heldLine(set, r.start.holdout[set])}`, `- after  ${heldLine(set, r.end.holdout[set])}`);
    L.push('seen half as it stood at each end:');
    for (const set of Object.keys(r.start.seen || {})) L.push(`- before ${heldLine(set, r.start.seen[set])}`, `- after  ${heldLine(set, r.end.seen[set])}`);
    L.push(`exam items added this round: ${r.exam_added.review} from review (${r.exam_added.allow} must run, ${r.exam_added.block} must block, ${r.exam_added.agents} clean agent setups), ${r.exam_added.proposer} from the landed proposal`);
    if (r.exam_added.dropped) L.push(`dropped ${r.exam_added.dropped} review examples that looked like a real secret`);
    if (r.exam_added.held_out) L.push(`refused ${r.exam_added.held_out} review examples that overlap the held-out half`);
  }
  for (const k of run.kept_copies || []) L.push('', `kept a copy at ${k.tree}: ${imp.fixedReason(k.reason)}`);
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
  const rawJudge = opts.judge || ((args) => imp.runJudge({ ...args, env, atrisBin: opts.atrisBin }));
  const screen = opts.screen || ((items, args) => runScreen(items, { ...args, env, atrisBin: opts.atrisBin }));
  const propose = opts.propose || ((args) => imp.askEngine({ ...args, env }));
  const reviewer = opts.reviewer || ((args) => askReviewer({ ...args, env, model: opts.reviewModel || '' }));
  const tmpRoot = opts.tmpRoot || os.tmpdir();

  const lock = takeLock(env, { now: clock });
  const budget = makeBudget({ maxMinutes, maxCalls, clock });
  // The deadline is checked before every exam, engine call and git call in
  // a round. No step is given more time than remains.
  const checkTime = () => { if (budget.leftMs() <= 0) throw new TimeUp(); };
  const left = (cap) => { checkTime(); return Math.min(cap, budget.leftMs()); };
  const judge = (args) => rawJudge({ ...args, timeoutMs: left(10 * 60 * 1000) });
  const FINAL_GIT_MS = 60 * 1000;
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
    nightCopy = makeCopy(root, freeBranch(root, `sentinel-improve/night-${date}`, left(FINAL_GIT_MS)), 'HEAD', env, tmpRoot, left(FINAL_GIT_MS));
    examCopy = makeCopy(root, freeBranch(root, `sentinel-exam/${date}`, left(FINAL_GIT_MS)), 'HEAD', env, tmpRoot, left(FINAL_GIT_MS));
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
      // A file key could be read by the reviewer. Night runs need the
      // keychain. The reviewer's empty HOME does not reach it.
      if (start.key_source !== 'keychain' && !opts._testAllowFileKey) throw new Error('night runs need the held-out key in the keychain. this machine uses a key file. the reviewer could read it');
      const foci = assignFoci(start, k, focus);
      const round = { round: r, foci, proposals: [], union: null, landed: null, start, end: null, exam_added: { review: 0, allow: 0, block: 0, agents: 0, proposer: 0, dropped: 0, held_out: 0 } };
      run.rounds.push(round);
      log(`round ${r}: asking ${foci.length} ${foci.length === 1 ? 'proposer' : 'proposers'} at once (${foci.join(', ')})`);
      const tip = headOf(nightCopy.tree, left(FINAL_GIT_MS));
      const copies = [];
      const baseRules = readBase();
      try {
      for (const f of foci) copies.push(makeCopy(root, freeBranch(root, `sentinel-improve/${id}-r${r}-${f}`, left(FINAL_GIT_MS)), tip, env, tmpRoot, left(FINAL_GIT_MS)));
      const sealed = [path.join(imp.homeDir(env), '.atris'), start.holdout_dir, ...(start.sealed_sources || [])];
      const timeoutMs = left(20 * 60 * 1000);
      const answers = await Promise.all(copies.map(async (c, i) => {
        try {
          return await propose({ engine, prompt: imp.buildPrompt({ report: start, signals, seenDirRel: SEEN_REL, focus: foci[i], tonight: tonight.slice(-20) }), cwd: c.tree, sealed, timeoutMs });
        } catch (e) { return { error: String(e.message || e) }; }
      }));
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
          checkTime();
          const stray = imp.strayChanges(copies[i].tree);
          if (stray.length) throw new Error(`the proposer changed files it may not touch: ${stray.slice(0, 3).join(', ')}`);
          if (Array.isArray(proposal.new_items) && !imp.gateValue(proposal.new_items)) throw new Error(imp.SECRET_ITEM_ERROR);
          if (!imp.gateValue(proposal)) throw new Error(imp.SECRET_PROPOSAL_ERROR);
          // Kept in memory for the reviewer prompt only. Never written.
          p.title = String(proposal.title || 'untitled').replace(/\s+/g, ' ').slice(0, 200);
          p.why = String(proposal.why || '').slice(0, 600);
          p.items = imp.cleanItems(proposal, `imp-${id.slice(0, 8)}-r${r}-${f}`);
          if (p.items.some((x) => !imp.gateValue(x.item))) throw new Error(imp.SECRET_ITEM_ERROR);
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
        } catch (e) { if (isTimeUp(e)) { p.error = 'the time limit ran out'; throw e; } p.error = imp.fixedError(e); }
        log(`round ${r} ${f}: ${p.error ? `stopped: ${p.error}` : p.decision.keep ? 'kept by the exam' : `rejected: ${imp.fixedReason(p.decision.reasons[0])}`}`);
      }
      } finally {
        for (const c of copies) { const res = dropCopy(root, c, env); if (!res.removed) run.kept_copies.push({ tree: c.tree, branch: c.branch, reason: res.reason }); }
      }

      const learn = (p, rev, learnFocus) => {
        const found = reviewItems(rev, { seenDir: baseSeen, date, focus: learnFocus });
        // No time left means nothing is learned: the screen cannot run.
        const { refused } = budget.leftMs() > 0 ? screen(found.items, { dir: work, timeoutMs: Math.min(60 * 1000, budget.leftMs()) }) : { refused: found.items.map((x) => x.item.id) };
        const no = new Set(refused);
        const items = found.items.filter((x) => !no.has(x.item.id));
        const dropped = found.dropped;
        round.exam_added.held_out += found.items.length - items.length;
        imp.appendItems(baseSeen, items);
        round.exam_added.review += items.length;
        round.exam_added.dropped += dropped.length;
        for (const x of items) {
          if (x.set === 'agents') round.exam_added.agents += 1;
          else if (x.item.expect === 'allow') { round.exam_added.allow += 1; tonight.push(`must run: ${x.item.command.slice(0, 200)}`); }
          else round.exam_added.block += 1;
        }
        if (rev.verdict === 'FIX' && p.literal) tonight.push(`rejected by the reviewer: the ${p.focus} proposal from round ${r}. it changed: ${p.literal.slice(0, 3).join('; ').slice(0, 400)}`);
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
        const reviewMs = Math.max(1, Math.min(15 * 60 * 1000, budget.leftMs()));
        try { res = await reviewer({ prompt, files, timeoutMs: reviewMs }); } catch (e) { res = { answer: '', error: String(e.message || e) }; }
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
        if (u.conflict) round.union.result = 'not tried: two changes conflict';
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
        if (!d.keep) { if (cand.union) round.union.result = `failed the exam: ${imp.fixedReason(d.reasons[0])}`; else cand.recheck = imp.fixedReason(d.reasons[0]); continue; }
        if (cand.union && review) {
          const rev = await doReview(cand, '');
          if (rev.verdict !== 'SHIP') { round.union.result = `review said ${rev.verdict}`; continue; }
        }
        if (cand.union) round.union.result = 'kept';
        landed = { ...cand, decision: d };
        break;
      }
      if (round.union && !round.union.result) round.union.result = 'not reached';

      if (landed) {
        fs.copyFileSync(path.join(landed.dir, RULES_PATH), path.join(base, RULES_PATH));
        fs.copyFileSync(path.join(landed.dir, RULES_PATH), path.join(nightCopy.tree, RULES_PATH));
        checkTime();
        const stray = imp.strayChanges(nightCopy.tree, new Set([RULES_PATH]));
        if (stray.length) throw new Error(`the rules copy changed outside the rules file: ${stray.slice(0, 3).join(', ')}`);
        commitIn(nightCopy.tree, [RULES_PATH], `Sentinel night round ${r}: one guard rules change\n\nKept by the sentinel bench${review ? ' and shipped by the codex review' : ''}. Night receipt: ${SEEN_REL}/receipts/night-${id}.md`, env, left(FINAL_GIT_MS));
        imp.appendItems(baseSeen, landed.items.map((x) => ({ ...x, item: { ...x.item } })));
        round.exam_added.proposer = landed.items.length;
        round.landed = { focus: landed.focus, title: landed.title, literal: landed.literal, path: landed.decision.path };
        run.landed += 1;
      }
      // Exam growth goes on its own branch, apart from the rules.
      checkTime();
      copySeen(baseSeen, path.join(examCopy.tree, SEEN_REL));
      const examStray = imp.strayChanges(examCopy.tree, new Set([`${SEEN_REL}/guard.jsonl`, `${SEEN_REL}/agents.jsonl`]));
      if (examStray.length) throw new Error(`the exam copy changed outside the seen items: ${examStray.slice(0, 3).join(', ')}`);
      const added = round.exam_added.review + round.exam_added.proposer;
      if (added && commitIn(examCopy.tree, [SEEN_REL], `Sentinel exam: ${added} seen items from night round ${r}\n\n${round.exam_added.review} came from the codex review (source "review"), ${round.exam_added.proposer} from the landed proposal (source "improve"). Exam data only, no rules change.`, env, left(FINAL_GIT_MS))) examCommits += 1;
      run.exam_added += added;
      round.end = judge({ target: base, seenDir: baseSeen });
      const rose = round.landed && gainOf(start, round.end).held > 0;
      noShip = round.landed ? 0 : noShip + 1;
      flatHeld = rose ? 0 : flatHeld + 1;
      log(`round ${r}: ${round.landed ? (round.landed.focus === 'union' ? 'shipped the union of the changes' : `shipped the ${round.landed.focus} proposal`) : 'nothing shipped'}, ${round.exam_added.review + round.exam_added.proposer} exam items added`);
      if (noShip >= 2) { run.stop = 'two rounds in a row shipped nothing'; break; }
      if (flatHeld >= 2) { run.stop = 'held-out catch did not rise for two rounds in a row'; break; }
    }
    if (!run.stop) run.stop = `all ${rounds} ${rounds === 1 ? 'round' : 'rounds'} ran`;
  } catch (e) {
    if (isTimeUp(e)) run.stop = 'the time limit ran out';
    else {
      run.stop = `an error: ${imp.fixedReason(String(e.message || e).split('\n')[0]).slice(0, 200)}`;
      run.error = run.stop;
    }
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
        fs.writeFileSync(path.join(nightCopy.tree, rel), scrubReceipt(renderNightReceipt(run)));
        commitIn(nightCopy.tree, [rel], `Sentinel night receipt: ${run.landed} shipped in ${run.rounds.length} rounds`, env, FINAL_GIT_MS);
      }
      if (opts.push) {
        for (const b of [run.night_branch, run.exam_branch].filter(Boolean)) {
          let r;
          try { r = imp.git(root, ['push', 'origin', `refs/heads/${b}:refs/heads/${b}`], { check: false, timeoutMs: PUSH_MS, env: { ...env, GIT_TERMINAL_PROMPT: '0' } }); } catch (e) { r = { status: 1, stderr: String(e.message || e) }; }
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
  fs.writeFileSync(receipt, scrubReceipt(renderNightReceipt(run)));
  for (const k of run.kept_copies) log(`left a copy at ${k.tree}: ${k.reason}`);
  return { ...run, receipt };
}

module.exports = {
  FOCI,
  assignFoci,
  breakLock,
  askReviewer,
  literalChanges,
  lockPath,
  makeBudget,
  night,
  parseReview,
  renderNightReceipt,
  reviewItems,
  reviewPrompt,
  runScreen,
  scrubReceipt,
  strictSecret,
  takeLock,
  unionRules,
};
