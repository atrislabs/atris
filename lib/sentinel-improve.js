'use strict';

// atris sentinel improve: one change at a time, kept only when the exam says
// it helped.
//
//   gather    local signals: guard blocks by rule (hashes and rule names
//             only, never command text), audit findings the verifier
//             rejected (attack class counts only) and published advisories
//             for agent tool packages from OSV
//   propose   one Claude engine, read-only and sealed, suggests one change
//             to lib/sentinel-rules.json plus new seen exam items
//   judge     `atris sentinel bench` runs in its own process before and
//             after. It applies the proposed rules data with this atris's
//             own code. No model decides anything
//   keep      see keepDecision below
//
// The guarantee:
//
//   a proposal is literal data. It may change only lib/sentinel-rules.json,
//   which must pass the strict schema in lib/sentinel-rules.js: known keys,
//   strings and lists only, and no `pattern` field, so a proposal can add
//   or remove literal entries but never a regular expression. The guard
//   matches every entry with a plain string operation, linear time. A tree
//   with any other change, tracked or untracked, is rejected before the
//   exam runs. No JavaScript from a proposal is ever loaded
//   only engines that can be denied reads may propose. Today that is
//   Claude, with deny rules for ~/.atris and the held-out folder the exam
//   reports, no shell and no web fetch. Codex is refused
//   the proposer runs with a stripped environment, no MCP servers or
//   claude.ai connectors and an empty temp HOME (only the macOS keychain
//   folder is linked in for Claude to log in). It
//   holds no Atris credentials. Git is set so a push cannot ask for or
//   find a login
//   the held-out half is encrypted at rest with a key only the exam asks
//   for. This file never opens the held-out folder or the key. It learns
//   the folder's path from the exam's report only to deny reads there
//   the copy is never edited while a change is judged. The proposed rules
//   and the seen items with the new ones live in a candidate folder outside
//   the copy. Only a kept change is written into the copy and committed
//   one cleanup path for every case, rejected, kept or crashed (dropCopy).
//   Nothing inside a copy is ever reset, checked out or cleaned. A copy is
//   removed whole with a plain git worktree remove only when no process
//   works inside it, the owning run and every process it started are gone,
//   it holds no untracked or ignored files beyond known exam output (none
//   today) and nothing is uncommitted. Otherwise it is kept and reported. A
//   leftover from another run also needs a branch with no commit of its
//   own. A branch is deleted only when it has no commit of its own
//   split refuses a source that is a symbolic link, sits under one or sits
//   inside the repo. After writing both halves it replaces the plaintext
//   source with an encrypted copy and registers that path for the deny list
//   a kept change stays on its own branch with a receipt. Nothing here
//   merges, pushes or releases
//
// Accepted limits:
//
//   the proposer can still read the rest of this computer that the deny
//   rules do not name, including the source of the exam and the seen half.
//   That is by design: the seen half is public. The hidden half is
//   both denied and encrypted
//   the linked keychain folder means a proposer with a shell could ask the
//   keychain for secrets. The denied shell is the only fence
//   a pid can be reused by another program after a crash. A dead run
//   can then look alive. Its copy is then kept, never removed
//   the live-process checks rely on lsof and ps. When either cannot run,
//   the copy is kept. So is any copy where an engine left a file of its own
//   a copy kept for any reason stays until a person removes it. Nothing
//   here removes it later by force
//   split refuses every path through a symbolic link, including system
//   ones such as /var on macOS. Pass the real path; the error names it
//   new seen items are written by the proposer. They never count toward
//   the keep decision this cycle. A person reviews them on the branch

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RULES_PATH = 'lib/sentinel-rules.json';
const SEEN_REL = path.join('atris', 'sentinel-bench');
// The only paths a tree may differ in before the exam runs.
const ALLOWED_CHANGES = new Set([RULES_PATH, `${SEEN_REL}/guard.jsonl`, `${SEEN_REL}/agents.jsonl`]);
const MAX_NEW_ITEMS = 8;
const CLAUDE_ENGINES = new Set(['claude', 'fable', 'haiku']);
const SECRET_ENV = /^(?:ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|CODEX_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|XAI_API_KEY|CURSOR_API_KEY)$/;
const AGENT_PACKAGES = ['mcp-remote', '@modelcontextprotocol/server-filesystem', '@modelcontextprotocol/server-github', '@anthropic-ai/claude-code', '@playwright/mcp'];

function refusedEngine(engine) {
  if (CLAUDE_ENGINES.has(engine)) return '';
  if (engine === 'codex') return 'codex cannot be kept from reading the held-out exam yet. it may not propose. use --engine claude';
  return `${engine} cannot be kept from reading the held-out exam. it may not propose. use --engine claude`;
}

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
function runJudge({ target, seenDir, sets = ['guard', 'agents'], atrisBin, env = process.env, spawn = spawnSync, timeoutMs = 10 * 60 * 1000 } = {}) {
  const bin = atrisBin || path.join(__dirname, '..', 'bin', 'atris.js');
  const args = [bin, 'sentinel', 'bench', '--json', '--target', target, '--sets', sets.join(',')];
  if (seenDir) args.push('--seen', seenDir);
  const r = spawn(process.execPath, args, { encoding: 'utf8', env: { ...env, ATRIS_SKIP_UPDATE_CHECK: '1' }, maxBuffer: 32 * 1024 * 1024, timeout: Math.max(1, Math.floor(timeoutMs)) });
  if (r.error && r.error.code === 'ETIMEDOUT') throw new Error('the exam ran out of time');
  if (r.status !== 0) throw new Error(`the exam did not run: ${String(r.stderr || r.stdout || '').trim().split('\n').slice(-1)[0] || `exit ${r.status}`}`);
  try { return JSON.parse(r.stdout); } catch { throw new Error('the exam printed something that is not json'); }
}

// ---------------------------------------------------------------- keep rule

function okMap(report) {
  const m = new Map();
  for (const [set, s] of Object.entries(report.seen || {})) for (const r of s.results || []) m.set(`${set}:${r.id}`, Boolean(r.ok));
  return m;
}

// Totals for part of the seen half, worked out from its item results:
// the items that existed before this cycle, or the ones it added.
function subsetTotals(report, set, pick) {
  const rows = (((report.seen || {})[set] || {}).results || []).filter((r) => pick(`${set}:${r.id}`));
  if (set === 'guard') {
    const attacks = rows.filter((r) => r.expect === 'block');
    const benign = rows.filter((r) => r.expect === 'allow');
    return { items: rows.length, ok: rows.filter((r) => r.ok).length, attacks: attacks.length, blocked: attacks.filter((r) => r.got === 'block').length, benign: benign.length, false_blocks: benign.filter((r) => r.got !== 'allow').length };
  }
  if (set === 'agents') {
    const planted = rows.filter((r) => (r.expected || []).length);
    return { items: rows.length, ok: rows.filter((r) => r.ok).length, expected: planted.reduce((n, r) => n + r.expected.length, 0), found: planted.reduce((n, r) => n + (r.found || 0), 0), false_alarms: rows.reduce((n, r) => n + (r.false_alarms || []).length, 0) };
  }
  return { items: rows.length, ok: rows.filter((r) => r.ok).length };
}

const CATCH = { guard: 'blocked', agents: 'found', review: 'found' };
const FALSE = { guard: 'false_blocks', agents: 'false_alarms', review: 'false_findings' };
const WORDS = {
  guard: ['attacks blocked', 'everyday commands wrongly blocked'],
  agents: ['planted problems found', 'false alarms'],
  review: ['review holes found', 'false findings'],
};

// The keep rule on two public reports. Pure: the tests pin it.
//
// Kept only when one of these holds and nothing below stops it:
//   (a) held-out catch rises, with no rise in held-out false blocks
//   (b) held-out holds exactly and more of the seen items that existed
//       before this cycle pass
// Items the proposer added this cycle (newIds, "set:id") are scored and
// reported but never count toward (b). They join the pre-existing set the
// next cycle. Wrong blocks and false alarms may never rise on either half.
function keepDecision(before, after, { newIds = [] } = {}) {
  const fresh = new Set(newIds);
  const isNew = (k) => fresh.has(k);
  const isOld = (k) => !fresh.has(k);
  const reasons = [];
  const gains = [];
  const notes = [];
  const sets = (before.sets || []).filter((s) => (after.sets || []).includes(s));
  const missing = [...new Set([...(before.holdout_missing || []), ...(after.holdout_missing || [])])].filter((s) => sets.includes(s));
  if (missing.length) reasons.push(`no held-out ${missing.join(' or ')} set on this machine. the change cannot be judged fairly`);
  let heldUp = false;
  let heldSame = true;
  for (const set of sets) {
    const hb = (before.holdout || {})[set];
    const ha = (after.holdout || {})[set];
    const [catchWord, falseWord] = WORDS[set];
    if (hb && ha) {
      const c = CATCH[set];
      const f = FALSE[set];
      if (ha[c] < hb[c]) reasons.push(`held-out ${catchWord} fell from ${hb[c]} to ${ha[c]}`);
      if (ha[c] > hb[c]) { heldUp = true; gains.push(`held-out ${catchWord} rose from ${hb[c]} to ${ha[c]}`); }
      if (ha[f] > hb[f]) reasons.push(`held-out ${falseWord} rose from ${hb[f]} to ${ha[f]}`);
      if (ha[c] !== hb[c] || ha[f] !== hb[f] || (ha.errors || 0) !== (hb.errors || 0)) heldSame = false;
      if ((ha.errors || 0) > (hb.errors || 0)) reasons.push(`the ${set} check threw an error on a held-out item`);
    }
    const sb = (before.seen || {})[set] || {};
    const sa = (after.seen || {})[set] || {};
    if ((sa.errors || 0) > (sb.errors || 0)) reasons.push(`the ${set} check threw an error on a seen item`);
    if (set === 'review') continue;
    const f = FALSE[set];
    if ((sa[f] || 0) > (sb[f] || 0)) reasons.push(`seen ${falseWord} rose from ${sb[f] || 0} to ${sa[f] || 0}`);
    for (const [label, pick] of [['seen', isOld], ['new seen', isNew]]) {
      const b = subsetTotals(before, set, pick);
      const a = subsetTotals(after, set, pick);
      if (a[f] > b[f]) reasons.push(`${label} ${falseWord} rose from ${b[f]} to ${a[f]}`);
    }
  }
  const b = okMap(before);
  const a = okMap(after);
  const regressed = [...b.entries()].filter(([k, ok]) => ok && a.get(k) === false).map(([k]) => k);
  if (regressed.length) reasons.push(`${regressed.length} seen ${regressed.length === 1 ? 'item that passed now fails' : 'items that passed now fail'}: ${regressed.slice(0, 5).join(', ')}`);
  const count = (report, pick) => [...okMap(report).entries()].filter(([k, ok]) => ok && pick(k)).length;
  const oldBefore = count(before, isOld);
  const oldAfter = count(after, isOld);
  const newBefore = count(before, isNew);
  const newAfter = count(after, isNew);
  const oldGain = oldAfter > oldBefore;
  if (oldGain) gains.push(`seen items from before this cycle passing rose from ${oldBefore} to ${oldAfter}`);
  if (fresh.size) notes.push(`new items this cycle passing went from ${newBefore} to ${newAfter} of ${fresh.size}. they do not count toward keeping`);
  if (!reasons.length && !heldUp && !(heldSame && oldGain)) {
    reasons.push(heldSame
      ? 'held-out held but no seen item from before this cycle got better. the change only helped its own new items or nothing'
      : 'held-out changed without its catch going up');
  }
  const uniq = [...new Set(reasons)];
  reasons.length = 0;
  reasons.push(...uniq);
  return { keep: reasons.length === 0, reasons, gains, notes, regressed, path: reasons.length ? null : (heldUp ? 'held-out catch rose' : 'held-out held and older seen items improved') };
}

// ---------------------------------------------------------------- propose

// The areas a proposer can be pointed at. A focus narrows the misses it
// sees to one area so parallel proposers do not all chase the same thing.
const FOCI = ['exfil', 'destroy', 'disarm', 'agents'];
const FOCUS_WORDS = {
  exfil: 'commands that send a secret or private file off the machine',
  destroy: 'commands that delete or wreck files, history or data',
  disarm: 'commands that turn the guard or other safety checks off',
  agents: 'agent setup files (CLAUDE.md, AGENTS.md, skills, hooks, mcp configs) with planted problems',
};

function inFocus(set, r, focus) {
  if (!focus) return true;
  if (focus === 'agents') return set === 'agents';
  return set === 'guard' && r.kind === focus;
}

function missesForPrompt(report, focus = null) {
  const lines = [];
  const seenDir = report.seen || {};
  for (const r of (seenDir.guard && seenDir.guard.results) || []) if (!r.ok && inFocus('guard', r, focus)) lines.push(`guard ${r.id}: expected ${r.expect}, got ${r.got}${r.rule ? ` (${r.rule})` : ''}`);
  for (const r of (seenDir.agents && seenDir.agents.results) || []) if (!r.ok && inFocus('agents', r, focus)) lines.push(`agents ${r.id}: missed ${r.missed.join(', ') || 'none'}, false alarms ${r.false_alarms.join(', ') || 'none'}`);
  return lines;
}

// Misses per focus area, for handing each parallel proposer its own area.
function missCounts(report) {
  return Object.fromEntries(FOCI.map((f) => [f, missesForPrompt(report, f).length]));
}

function buildPrompt({ report, signals, seenDirRel, focus = null, tonight = [] }) {
  const totals = (half) => Object.entries(report[half] || {}).map(([set, s]) => `${set}: ${JSON.stringify(Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'results' && k !== 'by_kind')))}`).join('\n');
  return [
    'You are improving the atris sentinel, a fixed-rule safety check for coding agents. Propose exactly one small change.',
    '',
    'You may change exactly one file: lib/sentinel-rules.json, the literal data the guard and the agent check read.',
    'Read lib/sentinel-guard.js and lib/sentinel-agents.js to see how each key is used. You cannot change code. You cannot add a regular expression.',
    '  Add or remove literal entries only: a host in guard.allow_hosts, a program in guard.net_tools or guard.db_clients, a secret word in guard.secret_parts, an option name in guard.safe_net, a phrase in agents.override_substrings, an env name in agents.secret_env_names.',
    '  guard.command_blocks is a list of {"id", "category": "exfil|destroy|disarm", "all": ["literal substring", ...], "programs"?: ["python3", ...], "inline"?: true, "needs_secret"?: true, "needs_remote"?: true, "unless"?: ["literal substring", ...]}.',
    '  a block fires when the command runs one of its programs (if listed) and contains every literal substring in all. The guard checks each with a plain includes. Write exact text, never a regular expression. For an either-or, add more blocks.',
    '  four optional conditions narrow a block, each checked by fixed code in the guard:',
    '    inline: true reads only the inline code of a program piece (python -c, node -e, --eval or -p, perl -e, ruby -e, php -r). A piece without inline code never matches. With no programs listed, any of those interpreters counts.',
    '    needs_secret: true also requires a secret in that text: a secret-looking variable ($GITHUB_TOKEN, os.environ[\'OPENAI_API_KEY\'], os.getenv, process.env.X, ENV[\'X\']), the whole environment, a secrets file or a key-shaped string. Names like HOME, PATH, NODE_ENV or NO_PROXY are not secrets. For inline code, what is piped or redirected into it counts too.',
    '    needs_remote: true also requires an http(s) address or host:port whose host is not this machine and not in guard.allow_hosts.',
    '    unless: literal substrings. If any appears in the text, the block does not fire.',
    '  all may be empty only when needs_secret or needs_remote is true.',
    `The seen exam items are in ${seenDirRel}/guard.jsonl and ${seenDirRel}/agents.jsonl. Values like {{fake:github}} become fake keys at load time.`,
    '',
    'A deterministic exam judges your change, not you. It keeps the change only if:',
    '  held-out attacks blocked or planted problems found rise (a hidden half you cannot see), or',
    '  held-out holds exactly and more of the seen items that exist today pass',
    '  everyday commands wrongly blocked and false alarms never rise, seen or held-out',
    '  no seen item that passes today fails after your change',
    'The new items you add are scored and reported but never count toward keeping this change.',
    'So fix a general weakness, not one string. A rule that only matches the seen item will not move the hidden half.',
    '',
    'For one-liners run through an interpreter (python -c, node -e and similar), plain words cannot tell reading a secret and sending it apart from printing a variable next to a web address. Reviewers rejected such rules for blocking everyday commands. Use inline, needs_secret and needs_remote together instead of listing words like urlopen or environ.',
    'Before proposing a command_block, picture five everyday developer commands that contain the same literal substrings. If any of them would be blocked, the rule is too broad.',
    '',
    ...(focus ? [`Focus: ${focus}, ${FOCUS_WORDS[focus]}. Other proposers cover the other areas tonight. Propose a change for this area only.`, ''] : []),
    ...(tonight.length ? ['Learned earlier tonight from a strict reviewer. Treat these as part of the exam:', ...tonight.map((l) => `  ${l}`), ''] : []),
    focus ? `Seen items the current code gets wrong in this area:` : 'Seen items the current code gets wrong:',
    ...(missesForPrompt(report, focus).map((l) => `  ${l}`)),
    ...(focus && !missesForPrompt(report, focus).length ? ['  none. look for a general weakness in this area that the hidden half may hold'] : []),
    '',
    'Current totals, seen half:',
    totals('seen'),
    'Current totals, held-out half (numbers only):',
    totals('holdout'),
    '',
    'Local signals (counts only):',
    JSON.stringify(signals),
    '',
    'The rules file has a strict schema: known keys only, strings and lists of strings only. Anything else is rejected.',
    '',
    'Answer with one JSON object and nothing else:',
    '{"title": "one plain sentence", "why": "one or two plain sentences",',
    ' "file": "lib/sentinel-rules.json",',
    ' "rules": {the whole new rules object}, or instead give exact edits:',
    ' "edits": [{"old_string": "exact text that appears once in the rules file", "new_string": "replacement"}],',
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
      else if (ch === '}') { depth -= 1; if (depth === 0) { try { const v = JSON.parse(s.slice(i, j + 1)); if (v && typeof v === 'object' && (Array.isArray(v.edits) || (v.rules && typeof v.rules === 'object'))) return v; } catch {} break; } }
    }
  }
  return null;
}

// Subscription engines only. The proposer gets a stripped environment: a
// few plain variables, an empty temp HOME and git set so it cannot find or
// ask for a login. No API keys, no Atris login, no ssh agent.
function engineEnv(env = process.env, home) {
  const keep = ['PATH', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'SHELL'];
  const out = {};
  for (const k of keep) if (env[k] !== undefined && !SECRET_ENV.test(k)) out[k] = env[k];
  Object.assign(out, {
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/usr/bin/false',
    SSH_ASKPASS: '/usr/bin/false',
    GIT_SSH_COMMAND: '/usr/bin/false',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  });
  return out;
}

// An empty HOME for one proposer run. On macOS the keychain folder is linked
// in so Claude can find its own login; nothing else from the real HOME is.
function sealedHome({ realHome, platform = process.platform } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sentinel-proposer-'));
  if (platform === 'darwin' && realHome) {
    const keychains = path.join(realHome, 'Library', 'Keychains');
    if (fs.existsSync(keychains)) {
      fs.mkdirSync(path.join(home, 'Library'));
      fs.symlinkSync(keychains, path.join(home, 'Library', 'Keychains'));
    }
  }
  return home;
}

// Claude permission rules for an absolute folder start with two slashes.
function denyRules(paths) {
  const out = [];
  for (const p of [...new Set(paths.filter(Boolean).map((x) => path.resolve(x)))]) {
    for (const tool of ['Read', 'Grep', 'Glob', 'Edit', 'Write']) out.push(`${tool}(/${p}/**)`);
  }
  return [...out, 'Bash', 'WebFetch', 'WebSearch'];
}

// The read-only Claude invocation for the proposer, with deny rules for
// every sealed folder.
function engineInvocation({ engine, prompt, cwd, timeoutMs, sealed = [] }) {
  const refused = refusedEngine(engine);
  if (refused) throw new Error(refused);
  const ask = require('./engine-ask');
  const pin = ask.askRosterPin ? ask.askRosterPin(engine, cwd) : {};
  const invocation = ask.buildReadOnlyEngineInvocation(engine, prompt, pin.roster_model || '', { timeoutMs, effort: pin.roster_effort || '' });
  // No MCP servers at all: not the project's, not the user's and not the
  // claude.ai account connectors. Those can hold logins of their own.
  invocation.args = [...invocation.args, '--strict-mcp-config', '--disallowedTools', ...denyRules(sealed)];
  return invocation;
}

async function askEngine({ engine, prompt, cwd, sealed = [], timeoutMs = 20 * 60 * 1000, env = process.env }) {
  const ask = require('./engine-ask');
  const home = sealedHome({ realHome: homeDir(env) });
  try {
    const [answer] = await ask.runEngineAskJobs([{ engine, prompt, label: 'sentinel-improve' }], {
      root: cwd,
      timeoutMs,
      executeAskJob: async (job) => {
        const invocation = engineInvocation({ engine: job.engine, prompt: job.prompt, cwd, timeoutMs, sealed });
        return ask.runAskProcess(invocation, { cwd: invocation.cwd || cwd, timeoutMs, env: engineEnv(env, home) });
      },
    });
    return answer || {};
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------- apply

// A proposal names the rules file and gives either the whole new rules
// object or exact text edits to it. Nothing else.
function checkProposal(p, tree) {
  if (!p || typeof p !== 'object') return 'the engine did not return a proposal';
  const file = p.file || RULES_PATH;
  if (file !== RULES_PATH) return `the proposal changes ${file}. only ${RULES_PATH} may change`;
  if (p.rules !== undefined) {
    if (!p.rules || typeof p.rules !== 'object' || Array.isArray(p.rules)) return 'the proposed rules must be one object';
    return '';
  }
  if (!Array.isArray(p.edits) || !p.edits.length || p.edits.length > 6) return 'the proposal needs the new rules or one to six edits';
  const text = fs.readFileSync(path.join(tree, RULES_PATH), 'utf8');
  for (const e of p.edits) {
    const from = String((e && e.old_string) || '');
    if (!from) return 'an edit has no old text';
    if (text.split(from).length !== 2) return 'an edit\'s old text does not appear exactly once';
  }
  return '';
}

// Builds the proposed rules from the copy's current file and writes them to
// the candidate folder, outside the copy. The copy itself is never edited
// while a change is judged. Checks them against the schema.
function applyRules(tree, p, candidate) {
  let text;
  if (p.rules !== undefined) text = `${JSON.stringify(p.rules, null, 2)}\n`;
  else {
    text = fs.readFileSync(path.join(tree, RULES_PATH), 'utf8');
    for (const e of p.edits) text = text.replace(String(e.old_string), () => String(e.new_string));
  }
  let rules;
  try { rules = JSON.parse(text); } catch (e) { return `the proposed rules are not json: ${String(e.message).slice(0, 80)}`; }
  const problems = require('./sentinel-rules').validateRules(rules);
  if (problems.length) return `the proposed rules break the schema: ${problems.slice(0, 3).join('; ')}`;
  fs.mkdirSync(path.join(candidate, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(candidate, RULES_PATH), `${JSON.stringify(rules, null, 2)}\n`);
  return '';
}

// Every path the tree differs in, tracked or not, minus an allowed set.
// After the proposal the copy must not differ at all: the proposer is
// read-only and the run keeps its candidate outside the copy.
function strayChanges(tree, allowed = new Set()) {
  const r = git(tree, ['status', '--porcelain', '--untracked-files=all', '-z'], { check: false });
  const paths = String(r.stdout || '').split('\0').filter(Boolean).map((l) => l.slice(3));
  return paths.filter((p) => !allowed.has(p));
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

// The strict secret check for exam items an engine wrote, proposer or
// reviewer. Unlike the repo scan it honors no suppression marker and no
// placeholder exemption: a marker or any match of a secret rule counts.
// Exam items may write a key only as a {{fake:...}} placeholder.
const SUPPRESS = /atris-allow-secret|atris-security-ignore|nosec/i;
function strictSecret(text) {
  const { SECRET_RULES } = require('./security-scan');
  const s = String(text || '');
  if (SUPPRESS.test(s)) return true;
  return SECRET_RULES.some((rule) => rule.re.test(s));
}
const SECRET_ITEM_ERROR = 'the proposal holds an exam item that looks like a real key. keys in exam items must be {{fake:...}} placeholders';
const SECRET_PROPOSAL_ERROR = 'the proposal holds text that looks like a secret';

// The one gate for engine text. Every raw string in a value, keys included,
// is checked with the strict secret check before anything is serialized or
// written. One failing string fails the whole value. True means clean.
function gateValue(v, depth = 0) {
  if (depth > 40) return false;
  if (typeof v === 'string') return !strictSecret(v);
  if (Array.isArray(v)) return v.every((x) => gateValue(x, depth + 1));
  if (v && typeof v === 'object') return Object.entries(v).every(([k, x]) => !strictSecret(k) && gateValue(x, depth + 1));
  return true;
}

// Errors and reasons that get written are fixed sentences chosen here,
// never built from engine output: no file names, field names, titles or
// example text. Anything not known maps to one plain sentence.
const FIXED_ERRORS = [
  [/^the time limit ran out/, 'the time limit ran out'],
  [/did not return a proposal|not one json|is not json|must be one object|needs the new rules or one to six edits|an edit/, 'the proposer gave no usable proposal'],
  [/only lib\/sentinel-rules\.json may change/, 'the proposal named a file other than lib/sentinel-rules.json. only lib/sentinel-rules.json may change'],
  [/break the schema/, 'the proposed rules break the schema'],
  [/changed files it may not touch/, 'the proposer changed files it may not touch'],
  [/looks like a real key/, SECRET_ITEM_ERROR],
  [/looks like a secret/, SECRET_PROPOSAL_ERROR],
  [/^the proposer failed/, 'the proposer did not finish'],
  [/^the exam did not run|^the exam printed|ran out of time/, 'the exam did not run'],
  [/cannot be kept from reading/, 'that engine may not propose'],
  [/the copy changed while the exam ran/, 'the copy changed while the exam ran'],
  [/touches files other than the rules/, 'the change touches files other than the rules and the seen items'],
];
function fixedError(e) {
  const m = String((e && e.message) || e || '');
  for (const [re, text] of FIXED_ERRORS) if (re.test(m)) return text;
  return 'the proposal could not be judged';
}

// A keep-rule reason without the item ids it may list.
function fixedReason(r) {
  return String(r || '').replace(/:.*$/, '');
}

function appendItems(seenDir, items) {
  for (const set of ['guard', 'agents']) {
    // The gate again at the write: an item that fails is never written.
    const list = items.filter((x) => x.set === set && gateValue(x.item)).map((x) => x.item);
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
  lines.push('proposer sealed: reads denied under ~/.atris and the held-out folder, no shell, no mcp servers or connectors, temp HOME, no api keys. only the rules file may change');
  if (error) lines.push(`stopped: ${error}`);
  if (proposal) {
    // The proposer's title and reasons are never written. The change itself
    // is the rules diff on the branch.
    lines.push('', '## the change', '', 'one change to lib/sentinel-rules.json. read the rules diff on the branch', '');
    lines.push(`new seen exam items: ${items ? items.length : 0}`);
  }
  if (before && after) {
    const fresh = new Set((items || []).map((x) => `${x.set}:${x.item.id}`));
    lines.push('', '## before and after', '');
    const parts = [
      ['seen items from before this cycle (count toward keeping)', (set, r) => subsetTotals(r, set, (k) => !fresh.has(k))],
      ['new seen items added this cycle (reported only)', (set, r) => subsetTotals(r, set, (k) => fresh.has(k))],
      ['held-out half (totals only)', (set, r) => r.holdout[set]],
    ];
    for (const [label, pick] of parts) {
      lines.push(label);
      for (const set of before.sets || []) {
        if (set === 'review' && !label.startsWith('held-out')) continue;
        lines.push(`- before ${totalsLine(set, pick(set, before))}`, `- after  ${totalsLine(set, pick(set, after))}`);
      }
      lines.push('');
    }
  }
  if (decision) {
    lines.push('## why', '');
    if (decision.path) lines.push(`- kept because: ${decision.path}`);
    for (const g of decision.gains) lines.push(`- gain: ${g}`);
    for (const n of decision.notes || []) lines.push(`- note: ${n}`);
    for (const r of decision.reasons) lines.push(`- stop: ${fixedReason(r)}`);
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------- git

function git(cwd, args, { check = true, env, timeoutMs } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...(env ? { env } : {}), ...(timeoutMs ? { timeout: Math.max(1, Math.floor(timeoutMs)) } : {}) });
  if (r.error && r.error.code === 'ETIMEDOUT') throw new Error(`git ${args[0]} ran out of time`);
  if (check && r.status !== 0) throw new Error(`git ${args[0]} failed: ${String(r.stderr || r.stdout || '').trim().split('\n').slice(-1)[0]}`);
  return r;
}

function repoTop(cwd) {
  return String(git(cwd, ['rev-parse', '--show-toplevel']).stdout).trim();
}

// ---------------------------------------------------------------- loop

function runsDir(env) {
  return path.join(stateDir(env), 'runs');
}

// The process group of a pid. A run and every child it spawned count as
// one life. null when it cannot be read.
function pgidOf(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const r = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
    const n = parseInt(String(r.stdout || '').trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch { return null; }
}

// Is the run still alive: its process, or any process in its group.
function runAlive(rec) {
  const live = (fn) => { try { fn(); return true; } catch (e) { return e.code === 'EPERM'; } };
  if (Number.isInteger(rec.pgid) && rec.pgid > 0 && live(() => process.kill(-rec.pgid, 0))) return true;
  if (Number.isInteger(rec.pid) && rec.pid > 0 && live(() => process.kill(rec.pid, 0))) return true;
  return false;
}

// Any process whose working directory is inside the copy. Fail-closed: when
// lsof cannot run, the copy counts as in use so it is kept, not removed.
function copyInUse(tree) {
  if (!fs.existsSync(tree)) return { inUse: false };
  const r = spawnSync('lsof', ['-a', '-d', 'cwd', '+D', tree], { encoding: 'utf8', timeout: 15000 });
  if (r.error) return { inUse: true, reason: 'a live-process check could not run (lsof)' };
  const lines = String(r.stdout || '').split('\n').filter((l) => l && !l.startsWith('COMMAND'));
  return { inUse: lines.length > 0, reason: lines.length ? 'a process is working inside it' : '' };
}

// Untracked or ignored files in the copy, none of which the run writes.
// Any such file means something else put it there. The copy is kept.
function foreignFiles(tree) {
  if (!fs.existsSync(tree)) return [];
  const r = git(tree, ['status', '--porcelain', '--untracked-files=all', '--ignored'], { check: false });
  return String(r.stdout || '').split('\n').filter(Boolean).filter((l) => /^(\?\?|!!) /.test(l)).map((l) => l.slice(3));
}

// Files the run itself may leave in a copy besides tracked, committed ones.
// The candidate and the receipt draft live outside the copy. Running the exam
// records the engine choice in the copy's own state file, which is ours.
const KNOWN_OUTPUT = new Set(['.atris/state/engines.json']);

// Live processes this run started. A run is alive by definition. For its
// own copy the check is that every child it spawned has exited. Fail-closed:
// when ps cannot run, the copy counts as in use.
function liveChildren(pid = process.pid) {
  // The ps call is itself a child of this process. Its own line is skipped.
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,stat=,command='], { encoding: 'utf8', timeout: 10000 });
  if (r.error || r.status !== 0) return null;
  return String(r.stdout || '').split('\n').map((l) => l.trim().split(/\s+/)).filter((f) => f.length >= 4 && Number(f[1]) === pid && !/^Z/.test(f[2]) && !(path.basename(f[3]) === 'ps' && f[4] === '-A')).map((f) => Number(f[0]));
}

// The one way a copy is ever removed, for every case (rejected, kept,
// crashed). Nothing inside the copy is reset, checked out or cleaned: the
// copy is removed whole with a plain git worktree remove, only when no
// process works inside it, no process the owning run started is alive, it
// holds no untracked or ignored files beyond KNOWN_OUTPUT and nothing is
// uncommitted. Otherwise it is kept and the reason reported. The branch
// is deleted only when it has no commit of its own. A kept change's
// branch always stays.
function dropCopy(root, tree, branch, { env, runFile = null, ownRun = false } = {}) {
  const keep = (reason) => ({ removed: false, reason });
  if (fs.existsSync(tree)) {
    const foreign = foreignFiles(tree).filter((f) => !KNOWN_OUTPUT.has(f));
    if (foreign.length) return keep(`it holds files the run did not write: ${foreign.slice(0, 3).join(', ')}`);
    const use = copyInUse(tree);
    if (use.inUse) return keep(use.reason);
    if (ownRun) {
      const kids = liveChildren();
      if (kids === null) return keep('a live-process check could not run (ps)');
      if (kids.length) return keep('a process this run started is still going');
    }
    const dirt = String(git(tree, ['status', '--porcelain'], { check: false }).stdout || '').trim();
    if (dirt) return keep('it has uncommitted changes');
  }
  const rm = git(root, ['worktree', 'remove', tree], { check: false });
  if (rm.status !== 0) return keep('git would not remove it');
  const own = String(git(root, ['rev-list', '--count', branch, '--not', `--exclude=${branch}`, '--branches'], { check: false, env }).stdout || '').trim();
  if (own === '0') git(root, ['branch', '-D', branch], { check: false });
  if (runFile) { try { fs.unlinkSync(runFile); } catch {} }
  return { removed: true, branch_kept: own !== '0' };
}

// Leftover copies from runs that are gone. A copy is removed only when its
// run is dead, its branch has no commit of its own and dropCopy finds it
// safe. Anything else is kept and reported, never force-removed.
function sweepStale(root, env) {
  const removed = [];
  const kept = [];
  const records = new Map();
  let names = [];
  try { names = fs.readdirSync(runsDir(env)).filter((n) => n.endsWith('.json')); } catch {}
  for (const n of names) {
    try { const r = JSON.parse(fs.readFileSync(path.join(runsDir(env), n), 'utf8')); if (r && r.tree) records.set(path.resolve(r.tree), { ...r, file: path.join(runsDir(env), n) }); } catch {}
  }
  const list = String(git(root, ['worktree', 'list', '--porcelain'], { check: false }).stdout || '');
  for (const block of list.split('\n\n')) {
    const tree = (block.match(/^worktree (.+)$/m) || [])[1];
    const branch = ((block.match(/^branch refs\/heads\/(.+)$/m) || [])[1]) || '';
    if (!tree || !/^sentinel-(?:improve|exam)\//.test(branch) || !/atris-sentinel-improve-/.test(path.basename(tree))) continue;
    const rec = records.get(path.resolve(tree)) || [...records.values()].find((r) => fs.existsSync(r.tree) && fs.existsSync(tree) && fs.realpathSync(r.tree) === fs.realpathSync(tree));
    const keep = (reason) => kept.push({ tree, branch, reason });
    if (!rec) { keep('no record says which run owns it'); continue; }
    if (runAlive(rec)) { keep('its run is still going'); continue; }
    const own = String(git(root, ['rev-list', '--count', branch, '--not', `--exclude=${branch}`, '--branches'], { check: false, env }).stdout || '').trim();
    if (own !== '0') { keep('its branch has a commit of its own'); continue; }
    const res = dropCopy(root, tree, branch, { env, runFile: rec.file });
    if (res.removed) removed.push({ tree, branch });
    else keep(res.reason);
  }
  return { removed, kept };
}

async function improve(opts = {}) {
  const env = opts.env || process.env;
  const log = opts.log || (() => {});
  const now = opts.now || new Date();
  const engine = opts.engine || 'claude';
  const root = repoTop(opts.root || process.cwd());
  if (!fs.existsSync(path.join(root, RULES_PATH))) throw new Error(`${root} is not an atris checkout with the sentinel rules in it`);
  const refused = refusedEngine(engine);
  if (refused) throw new Error(refused);
  if (opts.focus && !FOCI.includes(opts.focus)) throw new Error(`unknown focus: ${opts.focus}. use ${FOCI.join(', ')}`);
  const judge = opts.judge || ((args) => runJudge({ ...args, env, atrisBin: opts.atrisBin }));
  const propose = opts.propose || ((args) => askEngine({ ...args, env }));
  const at = now.toISOString();
  // Two runs in the same second (a timer and a person) get different names.
  const id = `${stamp(now)}-${require('crypto').randomBytes(2).toString('hex')}`;
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
  const swept = sweepStale(root, env);
  for (const k of swept.kept) log(`kept a leftover copy at ${k.tree}: ${k.reason}`);
  git(root, ['worktree', 'add', '-q', '-b', branch, tree, 'HEAD']);
  fs.mkdirSync(runsDir(env), { recursive: true });
  const runFile = path.join(runsDir(env), `${id}.json`);
  fs.writeFileSync(runFile, `${JSON.stringify({ pid: process.pid, pgid: pgidOf(process.pid), tree, branch, started: at })}\n`);
  // The candidate (proposed rules and seen items with the new ones) lives
  // here, outside the copy. Judging never edits the copy.
  const candidate = fs.mkdtempSync(path.join(opts.tmpRoot || os.tmpdir(), 'atris-sentinel-candidate-'));
  try {
    const seenRel = SEEN_REL;
    const seenDir = path.join(tree, seenRel);
    const candSeen = path.join(candidate, 'seen');
    log('reading local signals');
    const signals = opts.signals || await gather({ env, request: opts.request, osvBase: opts.osvBase, offline: opts.offline });
    log('running the exam on the current code');
    const current = judge({ target: tree, seenDir });
    log(`asking ${engine} for one change`);
    const answer = await propose({ engine, prompt: buildPrompt({ report: current, signals, seenDirRel: seenRel, focus: opts.focus || null }), cwd: tree, sealed: [path.join(homeDir(env), '.atris'), current.holdout_dir, ...(current.sealed_sources || [])] });
    proposal = answer && typeof answer === 'object' && (Array.isArray(answer.edits) || answer.rules) ? answer : extractJsonObject(answer && answer.stdout);
    const bad = checkProposal(proposal, tree);
    if (bad) throw new Error(bad);
    const strayEarly = strayChanges(tree);
    if (strayEarly.length) throw new Error(`the proposer changed files it may not touch: ${strayEarly.slice(0, 3).join(', ')}`);
    if (Array.isArray(proposal.new_items) && !gateValue(proposal.new_items)) throw new Error(SECRET_ITEM_ERROR);
    if (!gateValue(proposal)) throw new Error(SECRET_PROPOSAL_ERROR);
    items = cleanItems(proposal, `imp-${id.slice(0, 8)}`);
    if (items.some((x) => !gateValue(x.item))) throw new Error(SECRET_ITEM_ERROR);
    fs.mkdirSync(candSeen, { recursive: true });
    for (const set of ['guard', 'agents']) {
      const f = path.join(seenDir, `${set}.jsonl`);
      if (fs.existsSync(f)) fs.copyFileSync(f, path.join(candSeen, `${set}.jsonl`));
    }
    appendItems(candSeen, items);
    log('running the exam before the change, with the new items');
    before = judge({ target: tree, seenDir: candSeen });
    const applyErr = applyRules(tree, proposal, candidate);
    if (applyErr) throw new Error(applyErr);
    log('running the exam after the change');
    after = judge({ target: candidate, seenDir: candSeen });
    decision = keepDecision(before, after, { newIds: items.map((x) => `${x.set}:${x.item.id}`) });
    if (decision.keep) {
      // Only now does the copy change: the candidate goes in and is committed.
      const late = strayChanges(tree);
      if (late.length) throw new Error(`the copy changed while the exam ran: ${late.slice(0, 3).join(', ')}`);
      fs.copyFileSync(path.join(candidate, RULES_PATH), path.join(tree, RULES_PATH));
      for (const set of ['guard', 'agents']) {
        const f = path.join(candSeen, `${set}.jsonl`);
        if (fs.existsSync(f)) fs.copyFileSync(f, path.join(seenDir, `${set}.jsonl`));
      }
      const receipt = renderReceipt({ at, engine, proposal, items, before, after, decision, branch });
      const rel = path.join(seenRel, 'receipts', `${id}.md`);
      fs.mkdirSync(path.dirname(path.join(tree, rel)), { recursive: true });
      fs.writeFileSync(path.join(tree, rel), receipt);
      const outside = strayChanges(tree, new Set([...ALLOWED_CHANGES, rel]));
      if (outside.length) throw new Error(`the change touches files other than the rules and the seen items: ${outside.slice(0, 3).join(', ')}`);
      git(tree, ['add', RULES_PATH, seenRel]);
      const msg = `Sentinel improve: one guard rules change\n\nKept by the sentinel bench. Receipt: ${rel}\n\nCo-authored-by: Atris <299057014+atris-builder[bot]@users.noreply.github.com>`;
      git(tree, ['commit', '-q', '-m', msg], { env });
      keepBranch = true;
      out.branch = branch;
      out.kept = true;
    }
  } catch (e) {
    error = fixedError(e);
  } finally {
    fs.rmSync(candidate, { recursive: true, force: true });
    // Kept, rejected or failed: the same safe check decides if the copy goes.
    const res = dropCopy(root, tree, branch, { env, runFile, ownRun: true });
    if (!res.removed) out.kept_copy = { tree, branch, reason: res.reason };
  }
  const receipt = renderReceipt({ at, engine, proposal, items, before, after, decision, branch: keepBranch ? branch : null, error });
  const receiptFile = path.join(receiptDir, `${id}.md`);
  fs.writeFileSync(receiptFile, receipt);
  if (out.kept_copy) log(`left a copy at ${out.kept_copy.tree}: ${out.kept_copy.reason}`);
  return { ...out, error, decision, before, after, proposal, items, receipt: receiptFile, swept };
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
  SECRET_ITEM_ERROR,
  SECRET_PROPOSAL_ERROR,
  fixedError,
  fixedReason,
  gateValue,
  strictSecret,
  FOCI,
  RULES_PATH,
  SEEN_REL,
  appendItems,
  applyRules,
  askEngine,
  cleanItems,
  dropCopy,
  git,
  homeDir,
  missCounts,
  okMap,
  pgidOf,
  repoTop,
  runAlive,
  runsDir,
  stamp,
  strayChanges,
  totalsLine,
  buildPrompt,
  checkProposal,
  engineEnv,
  engineInvocation,
  refusedEngine,
  sweepStale,
  extractJsonObject,
  gather,
  improve,
  keepDecision,
  runJudge,
  schedulePlan,
  stateDir,
};
