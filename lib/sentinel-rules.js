'use strict';

// The schema for lib/sentinel-rules.json, the tunable rules of the guard and
// the agent check. `atris sentinel improve` may change only that file, so
// this is the wall between a proposal and the code that judges it:
//
//   known keys only, at every level. A missing or extra key is an error
//   strings and lists of strings only. No functions, no code, no objects
//   where a list belongs
//   every pattern is at most 400 characters, compiles, has no back
//   references and no repeated group that itself repeats (the shape behind
//   slow regular expressions)
//   then every compiled pattern runs against long hostile input in a child
//   process with a time limit. A pattern that stalls it is rejected
//
// validateRules() returns a list of plain problems. Empty means valid.

const path = require('path');
const { spawnSync } = require('child_process');

const MAX_PATTERN = 400;
const MAX_LIST = 300;
const MAX_ITEM = 200;
const STRESS_MS = 4000;

const GUARD_KEYS = ['allow_hosts', 'net_tools', 'secret_parts', 'key_shapes', 'secret_files', 'safe_net', 'safe_net_aliases', 'read_only', 'read_only_git', 'db_clients', 'drop_text', 'command_patterns'];
const AGENT_KEYS = ['secret_key_name', 'download', 'download_run', 'eval_fetched', 'skip_flags', 'override_phrases', 'comment_directive'];
const SAFE_NET_KEYS = ['flags', 'values', 'local_values', 'short_flags', 'short_values', 'items'];
const PATTERN_KEYS = ['id', 'category', 'pattern', 'programs'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function exactKeys(obj, allowed, where, problems, optional = []) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) problems.push(`${where} has an unknown key: ${k}`);
  for (const k of allowed) if (!optional.includes(k) && !(k in obj)) problems.push(`${where} is missing ${k}`);
}

function strList(v, where, problems, shape = null, maxItem = MAX_ITEM) {
  if (!Array.isArray(v)) { problems.push(`${where} must be a list`); return; }
  if (v.length > MAX_LIST) problems.push(`${where} has more than ${MAX_LIST} items`);
  v.forEach((x, i) => {
    if (typeof x !== 'string') problems.push(`${where}[${i}] must be a string`);
    else if (x.length > maxItem) problems.push(`${where}[${i}] is longer than ${maxItem} characters`);
    else if (shape && !shape.test(x)) problems.push(`${where}[${i}] has an odd shape: ${x.slice(0, 40)}`);
  });
}

// A repeated group whose inside also repeats: (a+)+, (?:x*|y)*, (a+){2,}.
function nestedRepeat(src) {
  const stack = [{ rep: false }];
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') { i += 1; continue; }
    if (inClass) { if (ch === ']') inClass = false; continue; }
    if (ch === '[') { inClass = true; continue; }
    if (ch === '(') { stack.push({ rep: false }); continue; }
    const top = stack[stack.length - 1];
    if (ch === ')') {
      const group = stack.pop();
      const next = src.slice(i + 1);
      const repeats = /^(?:[*+]|\{\d+,\d*\})/.test(next);
      if (repeats && group.rep) return true;
      if (stack.length) stack[stack.length - 1].rep = stack[stack.length - 1].rep || group.rep || repeats;
      continue;
    }
    if (ch === '*' || ch === '+' || (ch === '{' && /^\{\d+,\d*\}/.test(src.slice(i)))) top.rep = true;
  }
  return false;
}

function pattern(v, where, problems) {
  if (typeof v !== 'string') { problems.push(`${where} must be a string`); return; }
  if (v.length > MAX_PATTERN) { problems.push(`${where} is longer than ${MAX_PATTERN} characters`); return; }
  try { new RegExp(v.split('{HOME}').join('~').split('{DOWNLOAD}').join('curl')); } catch (e) { problems.push(`${where} does not compile: ${String(e.message).slice(0, 80)}`); return; }
  if (/\\[1-9]|\\k</.test(v)) problems.push(`${where} uses a back reference`);
  if (nestedRepeat(v)) problems.push(`${where} repeats a group that already repeats. that can stall on long input`);
}

function staticProblems(rules) {
  const problems = [];
  if (!isObj(rules)) return ['the rules file must hold one object'];
  exactKeys(rules, ['version', 'guard', 'agents'], 'the rules file', problems);
  if (rules.version !== 1) problems.push('version must be 1');
  const g = rules.guard;
  if (!isObj(g)) problems.push('guard must be an object');
  else {
    exactKeys(g, GUARD_KEYS, 'guard', problems);
    strList(g.allow_hosts, 'guard.allow_hosts', problems, /^[a-z0-9.:-]{1,100}$/i);
    for (const k of ['net_tools', 'read_only', 'db_clients']) strList(g[k], `guard.${k}`, problems, /^[A-Za-z0-9._+[-]{1,40}$/);
    strList(g.read_only_git, 'guard.read_only_git', problems, /^[a-z-]{1,30}$/);
    strList(g.secret_parts, 'guard.secret_parts', problems, /^[A-Z0-9]{1,30}$/);
    for (const k of ['key_shapes', 'secret_files']) {
      strList(g[k], `guard.${k}`, problems, null, MAX_PATTERN);
      if (Array.isArray(g[k])) g[k].forEach((x, i) => pattern(x, `guard.${k}[${i}]`, problems));
    }
    pattern(g.drop_text, 'guard.drop_text', problems);
    if (!isObj(g.safe_net)) problems.push('guard.safe_net must be an object');
    else {
      for (const [prog, spec] of Object.entries(g.safe_net)) {
        const where = `guard.safe_net.${prog}`;
        if (!/^[a-z]{1,20}$/.test(prog)) problems.push(`${where} is not a program name`);
        if (!isObj(spec)) { problems.push(`${where} must be an object`); continue; }
        exactKeys(spec, SAFE_NET_KEYS, where, problems);
        for (const k of ['flags', 'values', 'local_values']) strList(spec[k], `${where}.${k}`, problems, /^--?[A-Za-z0-9][A-Za-z0-9-]{0,40}$/);
        for (const k of ['short_flags', 'short_values']) if (typeof spec[k] !== 'string' || !/^[A-Za-z]{0,30}$/.test(spec[k])) problems.push(`${where}.${k} must be letters`);
        if (typeof spec.items !== 'boolean') problems.push(`${where}.items must be true or false`);
      }
    }
    if (!isObj(g.safe_net_aliases)) problems.push('guard.safe_net_aliases must be an object');
    else for (const [alias, target] of Object.entries(g.safe_net_aliases)) {
      if (!/^[a-z]{1,20}$/.test(alias) || typeof target !== 'string' || !(isObj(g.safe_net) && g.safe_net[target])) problems.push(`guard.safe_net_aliases.${alias} must name a program in safe_net`);
    }
    if (!Array.isArray(g.command_patterns)) problems.push('guard.command_patterns must be a list');
    else {
      if (g.command_patterns.length > 50) problems.push('guard.command_patterns has more than 50 items');
      g.command_patterns.forEach((p, i) => {
        const where = `guard.command_patterns[${i}]`;
        if (!isObj(p)) { problems.push(`${where} must be an object`); return; }
        exactKeys(p, PATTERN_KEYS, where, problems, ['programs']);
        if (typeof p.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(p.id)) problems.push(`${where}.id must be short lowercase words`);
        if (!['exfil', 'destroy', 'disarm'].includes(p.category)) problems.push(`${where}.category must be exfil, destroy or disarm`);
        pattern(p.pattern, `${where}.pattern`, problems);
        if ('programs' in p) strList(p.programs, `${where}.programs`, problems, /^[A-Za-z0-9._+-]{1,40}$/);
      });
    }
  }
  const a = rules.agents;
  if (!isObj(a)) problems.push('agents must be an object');
  else {
    exactKeys(a, AGENT_KEYS, 'agents', problems);
    for (const k of ['secret_key_name', 'download', 'skip_flags', 'comment_directive']) pattern(a[k], `agents.${k}`, problems);
    for (const k of ['download_run', 'eval_fetched', 'override_phrases']) {
      strList(a[k], `agents.${k}`, problems, null, MAX_PATTERN);
      if (Array.isArray(a[k])) a[k].forEach((x, i) => pattern(x, `agents.${k}[${i}]`, problems));
    }
  }
  return problems;
}

// Runs every compiled pattern over long hostile strings in a child process.
// A pattern that does not finish in time is the one to reject.
const STRESS_CHILD = `
const rules = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const g = require(${JSON.stringify(path.join(__dirname, 'sentinel-guard.js'))}).compileRules(rules);
const a = require(${JSON.stringify(path.join(__dirname, 'sentinel-agents.js'))}).compileRules(rules);
const res = [...g.keyShapes, ...g.secretFiles, g.dropText, ...g.commandPatterns.map((p) => p.re), a.secretKeyName, ...a.downloadRun, ...a.evalFetched, a.skipFlags, ...a.override, a.commentDirective];
const unit = ['a', ' ', '-', '/', 'curl ', '~/.', 'aA1_', '\\\\', '"', 'x='];
for (const u of unit) { const s = u.repeat(Math.ceil(8000 / u.length)) + '!'; for (const re of res) re.test(s); }
process.stdout.write('ok');
`;

function stressProblems(rules, { timeoutMs = STRESS_MS } = {}) {
  const r = spawnSync(process.execPath, ['-e', STRESS_CHILD], { input: JSON.stringify(rules), encoding: 'utf8', timeout: timeoutMs, env: { PATH: process.env.PATH || '' } });
  if (r.error && r.error.code === 'ETIMEDOUT') return [`a pattern took longer than ${timeoutMs / 1000} seconds on long input`];
  if (r.status !== 0 || r.stdout !== 'ok') return [`the patterns did not load: ${String(r.stderr || '').trim().split('\n').slice(-1)[0] || `exit ${r.status}`}`];
  return [];
}

function validateRules(rules, opts = {}) {
  const problems = staticProblems(rules);
  if (problems.length) return problems;
  return stressProblems(rules, opts);
}

module.exports = { validateRules, staticProblems, stressProblems };
