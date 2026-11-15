'use strict';

// The schema for lib/sentinel-rules.json, the literal rules of the guard and
// the agent check. `atris sentinel improve` may change only that file, so
// this is the wall between a proposal and the code that judges it:
//
//   known keys only, at every level. A missing or extra key is an error
//   strings and lists of strings only. No functions, no objects where a
//   list belongs. No `pattern` field anywhere: proposals may add or
//   remove literal entries, never a regular expression
//   every entry is a short literal: a host name, a program name, a secret
//   word, an option name or a command substring. The guard matches them
//   with plain string operations. There is no pattern to compile and
//   nothing that can stall on long input
//   a command block may add four plain conditions, each read by fixed code
//   in the guard: inline (true or false), needs_secret (true or false),
//   needs_remote (true or false) and unless (a list of literal substrings)
//
// validateRules() returns a list of plain problems. Empty means valid.

const MAX_LIST = 300;
const MAX_ITEM = 200;

const GUARD_KEYS = ['allow_hosts', 'net_tools', 'secret_parts', 'safe_net', 'safe_net_aliases', 'read_only', 'read_only_git', 'db_clients', 'command_blocks'];
const AGENT_KEYS = ['override_substrings', 'secret_env_names'];
const SAFE_NET_KEYS = ['flags', 'values', 'local_values', 'short_flags', 'short_values', 'items'];
const BLOCK_KEYS = ['id', 'category', 'all', 'programs', 'inline', 'needs_secret', 'needs_remote', 'unless'];
const BLOCK_OPTIONAL = ['programs', 'inline', 'needs_secret', 'needs_remote', 'unless'];
const BLOCK_FLAGS = ['inline', 'needs_secret', 'needs_remote'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A proposal may never carry a regex. `pattern` is the field name the old
// shape used. It is called out by name wherever it appears.
function noPatternField(obj, where, problems) {
  if (isObj(obj) && 'pattern' in obj) problems.push(`${where} has a pattern field. proposals may add literal entries only, never a regular expression`);
}

function exactKeys(obj, allowed, where, problems, optional = []) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) problems.push(`${where} has an unknown key: ${k}`);
  for (const k of allowed) if (!optional.includes(k) && !(k in obj)) problems.push(`${where} is missing ${k}`);
}

function strList(v, where, problems, shape = null, maxItem = MAX_ITEM) {
  if (!Array.isArray(v)) { problems.push(`${where} must be a list`); return; }
  if (v.length > MAX_LIST) problems.push(`${where} has more than ${MAX_LIST} items`);
  v.forEach((x, i) => {
    if (typeof x !== 'string') problems.push(`${where}[${i}] must be a string`);
    else if (!x.length) problems.push(`${where}[${i}] is empty`);
    else if (x.length > maxItem) problems.push(`${where}[${i}] is longer than ${maxItem} characters`);
    else if (shape && !shape.test(x)) problems.push(`${where}[${i}] has an odd shape: ${x.slice(0, 40)}`);
  });
}

function validateRules(rules) {
  const problems = [];
  if (!isObj(rules)) return ['the rules file must hold one object'];
  exactKeys(rules, ['version', 'guard', 'agents'], 'the rules file', problems);
  if (rules.version !== 2) problems.push('version must be 2');
  const g = rules.guard;
  if (!isObj(g)) problems.push('guard must be an object');
  else {
    noPatternField(g, 'guard', problems);
    exactKeys(g, GUARD_KEYS, 'guard', problems);
    strList(g.allow_hosts, 'guard.allow_hosts', problems, /^[a-z0-9.:_-]{1,100}$/i);
    for (const k of ['net_tools', 'read_only', 'db_clients']) strList(g[k], `guard.${k}`, problems, /^[A-Za-z0-9._+[-]{1,40}$/);
    strList(g.read_only_git, 'guard.read_only_git', problems, /^[a-z-]{1,30}$/);
    strList(g.secret_parts, 'guard.secret_parts', problems, /^[A-Z0-9]{1,30}$/);
    if (!isObj(g.safe_net)) problems.push('guard.safe_net must be an object');
    else {
      for (const [prog, spec] of Object.entries(g.safe_net)) {
        const where = `guard.safe_net.${prog}`;
        if (!/^[a-z]{1,20}$/.test(prog)) problems.push(`${where} is not a program name`);
        if (!isObj(spec)) { problems.push(`${where} must be an object`); continue; }
        noPatternField(spec, where, problems);
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
    if (!Array.isArray(g.command_blocks)) problems.push('guard.command_blocks must be a list');
    else {
      if (g.command_blocks.length > 50) problems.push('guard.command_blocks has more than 50 items');
      g.command_blocks.forEach((b, i) => {
        const where = `guard.command_blocks[${i}]`;
        if (!isObj(b)) { problems.push(`${where} must be an object`); return; }
        noPatternField(b, where, problems);
        exactKeys(b, BLOCK_KEYS, where, problems, BLOCK_OPTIONAL);
        if (typeof b.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(b.id)) problems.push(`${where}.id must be short lowercase words`);
        if (!['exfil', 'destroy', 'disarm'].includes(b.category)) problems.push(`${where}.category must be exfil, destroy or disarm`);
        for (const k of BLOCK_FLAGS) if (k in b && typeof b[k] !== 'boolean') problems.push(`${where}.${k} must be true or false`);
        strList(b.all, `${where}.all`, problems);
        // An empty all is allowed only when a secret or an outside address
        // must also be present, so a block can never fire on a program alone.
        if (Array.isArray(b.all) && !b.all.length && b.needs_secret !== true && b.needs_remote !== true) problems.push(`${where}.all needs at least one substring, unless needs_secret or needs_remote is true`);
        if ('programs' in b) strList(b.programs, `${where}.programs`, problems, /^[A-Za-z0-9._+-]{1,40}$/);
        if ('unless' in b) {
          strList(b.unless, `${where}.unless`, problems);
          if (Array.isArray(b.unless) && b.unless.length > 30) problems.push(`${where}.unless has more than 30 items`);
        }
      });
    }
  }
  const a = rules.agents;
  if (!isObj(a)) problems.push('agents must be an object');
  else {
    noPatternField(a, 'agents', problems);
    exactKeys(a, AGENT_KEYS, 'agents', problems);
    strList(a.override_substrings, 'agents.override_substrings', problems);
    strList(a.secret_env_names, 'agents.secret_env_names', problems, /^[A-Za-z_][A-Za-z0-9_.-]{0,80}$/);
  }
  return problems;
}

module.exports = { validateRules };
