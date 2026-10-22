'use strict';

// The your-yes lock: a seatbelt that keeps a job started from the orb from
// publishing, tagging, releasing, posting, sending, or merging to master
// before the owner says yes. It is not a sandbox. The job runs as the same
// user on the same machine, so a determined process could still call an API
// with curl, run a tool by its full path, or edit files this code reads. It
// stops an agent's mistakes through the commands it names, and it fails
// closed.
//
// How it works:
//   - at start, the mission record keeps a sealed list of the owner steps and
//     what each locks (publish, tag, post, send, merge, deploy)
//   - approvals live in a state file under ~/.atris/state/yes-locks, outside
//     the workspace; a missing, unreadable, or mismatched file means every
//     sealed step is locked
//   - the mission guard puts wrappers for git, npm, yarn, pnpm, npx, pnpx, gh,
//     and atris first on the job's PATH; each asks check() before running
//   - while the job is locked, npm, yarn, pnpm, and gh only run known read and
//     build commands; anything else is refused
//   - every category a command touches must be open; a yes opens one step for
//     one successful run, then that step closes again

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HELD_EXIT = 77;
const CATEGORY_WORDS = {
  publish: 'publish or release a package',
  tag: 'push a version tag',
  post: 'post in public',
  send: 'send a message',
  merge: 'change master',
  deploy: 'deploy',
};

// ---- what an owner step locks ------------------------------------------------------

const STEP_WORDS = [
  [/\b(publish|publishes|published|release|releases|released|npm)\b/, ['publish', 'tag']],
  [/\b(tag|tags)\b/, ['tag']],
  [/\b(post|posts|tweet|tweets|thread|announce|launch|show hn|hacker news|linkedin|reddit)\b/, ['post']],
  [/\b(send|sends|email|emails|dm|dms|message|messages|text|reply|invite|invites|outreach)\b/, ['send']],
  [/\b(merge|merges|merged|land|lands)\b/, ['merge']],
  [/\b(deploy|deploys|deployed)\b/, ['deploy']],
];

function stepLocks(text) {
  const t = String(text || '').toLowerCase();
  const out = new Set();
  for (const [re, cats] of STEP_WORDS) if (re.test(t)) cats.forEach(c => out.add(c));
  return [...out];
}

// The sealed list for a bet's steps: one entry per owner step that locks something.
function sealFor(steps) {
  return (Array.isArray(steps) ? steps : [])
    .map((s, i) => (s && s.who === 'you' ? { step: i + 1, text: String(s.text || ''), categories: stepLocks(s.text) } : null))
    .filter(l => l && l.categories.length);
}

function normalizeSeal(seal) {
  return (Array.isArray(seal) ? seal : [])
    .filter(s => s && Number.isInteger(s.step) && Array.isArray(s.categories) && s.categories.length)
    .map(s => ({ step: s.step, text: String(s.text || ''), categories: [...new Set(s.categories.map(String))].sort() }));
}

// ---- the state file, outside the workspace -----------------------------------------

function stateFile(stateDir, missionId) {
  return path.join(stateDir, 'yes-locks', `${String(missionId).replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

function readState(stateDir, missionId) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(stateDir, missionId), 'utf8'));
  } catch {
    return null;
  }
}

function writeState(stateDir, missionId, data) {
  const file = stateFile(stateDir, missionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function writeYesLocks(stateDir, missionId, { betId = null, seal = [] } = {}) {
  const locks = normalizeSeal(seal).map(s => ({ ...s, asked_at: null, approved_at: null, consumed_at: null }));
  writeState(stateDir, missionId, { mission_id: missionId, bet_id: betId, locks });
  return locks;
}

// The locks as they stand. Every sealed step must be in the state file with
// the same categories; otherwise the file is not trusted and every step is
// locked, with nothing approved.
function effectiveLocks(stateDir, missionId, seal) {
  const sealed = normalizeSeal(seal);
  if (!sealed.length) return { locks: [], trusted: true };
  const data = readState(stateDir, missionId);
  const rows = data && Array.isArray(data.locks) ? data.locks : null;
  const same = (a, b) => JSON.stringify([...new Set((a || []).map(String))].sort()) === JSON.stringify(b);
  const trusted = Boolean(rows) && sealed.every(s => rows.some(l => l && l.step === s.step && same(l.categories, s.categories)));
  if (!trusted) return { locks: sealed.map(s => ({ ...s, asked_at: null, approved_at: null, consumed_at: null })), trusted: false };
  return {
    trusted: true,
    locks: sealed.map((s) => {
      const l = rows.find(r => r.step === s.step);
      return { ...s, asked_at: l.asked_at || null, approved_at: l.approved_at || null, consumed_at: l.consumed_at || null, ...(l.held_command ? { held_command: l.held_command } : {}), ...(l.held_key ? { held_key: l.held_key } : {}), ...(l.approved_command ? { approved_command: l.approved_command } : {}) };
    }),
  };
}

// A yes is claimed by the one run it allows, with a file only one process
// can create, before that run starts. The claim is dropped if the run fails.
function claimFile(stateDir, missionId, lock) {
  return `${stateFile(stateDir, missionId)}.step-${lock.step}.${String(lock.approved_at).replace(/[^0-9A-Za-z]/g, '')}.claim`;
}

const isOpen = l => Boolean(l.approved_at) && !l.consumed_at;

function saveLocks(stateDir, missionId, locks, betId) {
  const prior = readState(stateDir, missionId);
  writeState(stateDir, missionId, { mission_id: missionId, bet_id: (prior && prior.bet_id) || betId || null, locks });
}

// The yes covers the command the job was held on (the one the owner saw on
// the card), in the folder it ran from, and nothing else.
function approveYesLock(stateDir, missionId, step, seal, at = new Date().toISOString()) {
  const { locks } = effectiveLocks(stateDir, missionId, seal || sealFromState(stateDir, missionId));
  const lock = locks.find(l => l.step === step);
  if (!lock) return null;
  Object.assign(lock, { approved_at: at, consumed_at: null, approved_command: lock.held_key || null });
  saveLocks(stateDir, missionId, locks);
  return lock;
}

// For readers that have no mission record at hand (the desk), the state file
// is its own seal: it is only ever used to show and answer cards, never to let
// a command through.
function sealFromState(stateDir, missionId) {
  const data = readState(stateDir, missionId);
  return data && Array.isArray(data.locks) ? data.locks : [];
}

function askedYesLocks(stateDir, missionId) {
  const data = readState(stateDir, missionId);
  return data && Array.isArray(data.locks) ? data.locks.filter(l => l.asked_at && !isOpen(l) && !l.consumed_at) : [];
}

// ---- reading commands ---------------------------------------------------------------

const MAIN_BRANCHES = new Set(['master', 'main']);
const RISKY_GIT_CONFIG = /^(alias\..+|remote\..+|push\..+|url\..+|branch\..+\.(remote|pushremote|merge)|core\.hookspath|include\..+|includeif\..+|core\.sshcommand|credential\..+)$/i;

// a parsed view of one command: the categories it touches, or a refusal
const touches = (...cats) => ({ cats: [...new Set(cats)], refuse: null });
const refused = why => ({ cats: [], refuse: why });
const CLEAR = { cats: [], refuse: null };

function positionals(args, valueFlags) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i] || '');
    if (a === '--') { out.push(...args.slice(i + 1).map(String)); break; }
    if (a.startsWith('-')) {
      if (!a.includes('=') && valueFlags.has(a)) i += 1;
      continue;
    }
    out.push(a);
  }
  return out;
}

// npm, yarn, pnpm: global options are skipped first, then only known read
// and build commands run. Publishing names map to publish; the exec family
// and anything unknown is refused.
const NPM_VALUE_FLAGS = new Set(['--registry', '--prefix', '-C', '--userconfig', '--globalconfig', '--cache', '--loglevel', '--workspace', '-w', '--tag', '--access', '--otp', '--scope', '--location', '--include', '--omit', '--before', '--auth-type', '--filter', '--dir', '--cwd']);
const PKG_READ = {
  npm: ['test', 't', 'tst', 'run', 'run-script', 'rum', 'urn', 'ci', 'clean-install', 'install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add', 'uninstall', 'remove', 'rm', 'r', 'un', 'ls', 'list', 'la', 'll', 'view', 'v', 'info', 'show', 'outdated', 'audit', 'explain', 'why', 'prefix', 'root', 'bin', 'help', 'doctor', 'fund', 'start', 'stop', 'restart', 'rebuild', 'rb', 'init', 'create', 'version', 'dedupe', 'prune', 'update', 'up', 'upgrade', 'find-dupes', 'query'],
  yarn: ['', 'install', 'add', 'remove', 'run', 'test', 'why', 'info', 'list', 'outdated', 'audit', 'upgrade', 'up', 'init', 'version', 'cache', 'check', 'licenses', 'config'],
  pnpm: ['install', 'i', 'add', 'remove', 'rm', 'un', 'uninstall', 'update', 'up', 'upgrade', 'run', 'test', 't', 'list', 'ls', 'll', 'why', 'outdated', 'audit', 'init', 'prune', 'store', 'root', 'bin', 'licenses', 'fetch', 'rebuild', 'rb'],
};
const PKG_PUBLISH = new Set(['publish', 'pub', 'publis', 'unpublish', 'deprecate', 'undeprecate', 'dist-tag', 'dist-tags', 'owner', 'access', 'team']);
const PKG_EXEC = new Set(['exec', 'x', 'dlx', 'create-exec']);

const PKG_BOOL_FLAGS = new Set(['-s', '--silent', '-q', '--quiet', '-d', '--loglevel=info', '--verbose', '-y', '--yes', '-f', '--force', '-g', '--global', '-D', '--save-dev', '-P', '--save-prod', '-O', '--save-optional', '-E', '--save-exact', '-B', '--save-bundle', '--no-save', '--save', '--dry-run', '--json', '--ignore-scripts', '--legacy-peer-deps', '--strict-peer-deps', '--prefer-offline', '--prefer-online', '--offline', '--no-audit', '--no-fund', '--workspaces', '--ws', '--include-workspace-root', '--if-present', '--production', '--frozen-lockfile', '--no-frozen-lockfile', '-r', '--recursive', '--color', '--no-color', '--no-progress', '--foreground-scripts', '--long', '-l', '--all', '-a', '--depth=0', '--parseable', '-p', '--version', '-v', '--help', '-h', '--watch', '--coverage', '--immutable', '--check-files', '--pure-lockfile', '--non-interactive', '--no-git-checks', '--dev', '--peer', '--optional', '--exact', '--tilde']);

// Every non-option word before "--", in order. An option this code does not
// know might take the next word as its value, so it must use --key=value.
function packageWords(args) {
  const words = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i] || '');
    if (a === '--') break;
    if (a.startsWith('-')) {
      if (a.includes('=') || PKG_BOOL_FLAGS.has(a)) continue;
      if (NPM_VALUE_FLAGS.has(a)) { i += 1; continue; }
      return { unknownFlag: a, words };
    }
    words.push(a);
  }
  return { unknownFlag: null, words };
}

function readPackageTool(name, args) {
  const { unknownFlag, words } = packageWords(args);
  if (unknownFlag) return refused(`${name} option ${unknownFlag} is not one this lock knows, so it could hide the command; write it as ${unknownFlag}=<value> while owner steps wait`);
  const sub = String(words[0] || '');
  // with unknown options refused, the first word is the command npm runs
  if (PKG_EXEC.has(sub)) return refused(`${name} ${sub} can run any command, so it is closed while owner steps wait`);
  if (PKG_PUBLISH.has(sub) || (name === 'yarn' && sub === 'npm' && words[1] === 'publish')) return touches('publish');
  if (sub === 'pack') return args.includes('--dry-run') ? CLEAR : refused(`${name} pack writes a package file; use --dry-run while owner steps wait`);
  if (sub === 'config' && !/^(get|list|ls)$/.test(String(words[1] || ''))) return refused(`${name} config can change where packages go; only get and list run while owner steps wait`);
  if (PKG_READ[name].includes(sub)) return CLEAR;
  return refused(`${name} ${sub || '(no command)'} is not on the list of commands a locked job may run`);
}

// gh: only read verbs run; writes map to their category; anything else is refused.
const GH_VALUE_FLAGS = new Set(['-R', '--repo', '--hostname', '-X', '--method', '-f', '-F', '--field', '--raw-field', '--input', '-H', '--header', '-q', '--jq', '-t', '--template', '--cache', '-p', '--preview']);
const GH_READ = {
  pr: ['view', 'list', 'checks', 'diff', 'status', 'create', 'checkout'],
  issue: ['view', 'list', 'status'],
  run: ['view', 'list', 'watch', 'download'],
  workflow: ['view', 'list'],
  repo: ['view', 'list', 'clone'],
  release: ['view', 'list', 'download'],
  auth: ['status'],
  gist: ['view', 'list'],
  label: ['list'],
  search: ['repos', 'issues', 'prs', 'code', 'commits'],
};
const GH_WRITE = {
  release: { create: 'publish', new: 'publish', upload: 'publish', edit: 'publish', delete: 'publish', 'delete-asset': 'publish' },
  pr: { merge: 'merge', comment: 'post', review: 'post', edit: 'post', close: 'post', reopen: 'post', ready: 'post' },
  issue: { create: 'post', new: 'post', comment: 'post', edit: 'post', close: 'post', reopen: 'post' },
  gist: { create: 'post', new: 'post', edit: 'post' },
};

function readGhApi(args) {
  // gh takes the last method given; a short cluster like -iXPUT or -if
  // carries its letters together
  let method = null;
  let writes = false;
  // long options that take a value: their value is never read as a flag
  const LONG_VALUES = new Set(['--method', '--field', '--raw-field', '--input', '--header', '--jq', '--template', '--cache', '--preview', '--hostname', '--repo']);
  // short letters that take a value: the rest of the cluster, or the next word
  const SHORT_VALUES = new Set(['X', 'f', 'F', 'H', 'q', 't', 'p', 'R']);
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i]);
    if (a === '--') break;
    if (a.startsWith('--')) {
      const [name, inline] = a.split(/=(.*)/s);
      const value = inline !== undefined ? inline : (LONG_VALUES.has(name) ? String(args[i + 1] || '') : null);
      if (inline === undefined && LONG_VALUES.has(name)) i += 1;
      if (name === '--method') method = String(value || '').toUpperCase();
      if (name === '--field' || name === '--raw-field' || name === '--input') writes = true;
      continue;
    }
    if (/^-[^-]/.test(a)) {
      const letters = a.slice(1);
      for (let k = 0; k < letters.length; k += 1) {
        const ch = letters[k];
        if (!SHORT_VALUES.has(ch)) continue;
        const rest = letters.slice(k + 1);
        const value = rest || String(args[i + 1] || '');
        if (!rest) i += 1;
        if (ch === 'X') method = value.toUpperCase();
        if (ch === 'f' || ch === 'F') writes = true;
        break;
      }
    }
  }
  if ((method === null || method === 'GET') && !writes) return CLEAR;
  // the route and every field, since a ref or a tag can be named in a field
  const route = args.slice(1).join(' ').toLowerCase();
  const cats = [];
  const anyRef = /git\/refs\b(?!\/(heads|tags)\/)/.test(route);
  if (/releases?\b/.test(route)) cats.push('publish');
  if (/refs\/tags/.test(route) || anyRef) cats.push('tag');
  if (/\/merges?\b|\/pulls\/[^/\s]+\/merge|refs\/heads|\/branches\//.test(route) || anyRef) cats.push('merge');
  if (/\/issues|\/comments|\/discussions/.test(route)) cats.push('post');
  return cats.length ? touches(...cats) : refused('gh api with a write is not on the list of commands a locked job may run');
}

function readGh(args) {
  const words = positionals(args, GH_VALUE_FLAGS);
  const [group = '', verb = ''] = words;
  if (group === 'api') return readGhApi(args.slice(args.indexOf('api')));
  if (['help', 'version', 'status', 'browse', '--version'].includes(group) || group === '') return CLEAR;
  const write = GH_WRITE[group] && GH_WRITE[group][verb];
  if (write) return touches(write);
  if (GH_READ[group] && GH_READ[group].includes(verb)) return CLEAR;
  return refused(`gh ${group} ${verb} is not on the list of commands a locked job may run`);
}

// atris: the send and post commands touch every category they can reach;
// everything else is the mission's own machinery and runs.
function readAtris(args) {
  const words = positionals(args, new Set(['--account', '--as', '--from', '--to', '--channel']));
  const [cmd = '', sub = ''] = words;
  if (['gmail', 'mail', 'email'].includes(cmd) && /^(send|reply|forward)$/.test(sub)) return touches('send');
  if (cmd === 'slack' && /^(send|dm|post|reply)$/.test(sub)) return touches('send', 'post');
  if (cmd === 'imessage' && sub === 'send') return touches('send');
  if (cmd === 'twitter' && /^(post|reply|tweet)$/.test(sub)) return touches('post', 'send');
  return CLEAR;
}

// ---- git ------------------------------------------------------------------------

function parseGit(args) {
  const out = { prefix: [], configs: [], sub: '', rest: [] };
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i] || '');
    if (a === '-C' || a === '--git-dir' || a === '--work-tree' || a === '--namespace') { out.prefix.push(a, String(args[i + 1] || '')); i += 1; continue; }
    if (/^--(git-dir|work-tree|namespace)=/.test(a)) { out.prefix.push(a); continue; }
    if (a === '-c') { out.configs.push(String(args[i + 1] || '')); i += 1; continue; }
    if (/^-c./.test(a)) { out.configs.push(a.slice(2)); continue; }
    if (a === '--config-env') { out.configs.push(String(args[i + 1] || '')); i += 1; continue; }
    if (a.startsWith('--config-env=')) { out.configs.push(a.slice(13)); continue; }
    if (a.startsWith('-')) continue;
    out.sub = a;
    out.rest = args.slice(i + 1).map(String);
    break;
  }
  return out;
}

const configKey = c => String(c || '').split('=')[0].trim();

// Config set through the environment counts the same as -c.
function envConfigKeys(env = process.env) {
  const keys = [];
  const n = Number(env.GIT_CONFIG_COUNT);
  if (Number.isInteger(n)) for (let i = 0; i < n; i += 1) keys.push(String(env[`GIT_CONFIG_KEY_${i}`] || ''));
  for (const m of String(env.GIT_CONFIG_PARAMETERS || '').matchAll(/'([^'=]+)/g)) keys.push(m[1]);
  return keys;
}

const PUSH_VALUE_FLAGS = new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec']);
const PUSH_REFUSED = ['--all', '--branches', '--mirror', '--tags', '--follow-tags', '--prune'];
// git takes any unambiguous start of a long option, so --tag means --tags
const isAbbrevOf = (arg, full) => arg.length >= 3 && full.startsWith(arg);

function destCategory(dest, ctx) {
  const d = String(dest || '').replace(/^\+/, '');
  if (!d) return null;
  if (d.includes('*')) return ['merge', 'tag'];
  // git finds a short name under refs/, so heads/master and tags/v1 count
  const rel = d.replace(/^refs\//, '');
  if (rel.startsWith('tags/')) return ['tag'];
  const branch = rel.replace(/^heads\//, '');
  if (MAIN_BRANCHES.has(branch)) return ['merge'];
  if (!d.startsWith('refs/') && ctx.isTag(d) && !ctx.isBranch(d)) return ['tag'];
  return null;
}

function readPush(rest, ctx) {
  const bad = rest.find(a => a.startsWith('--') && PUSH_REFUSED.some(full => isAbbrevOf(a.split('=')[0], full)));
  if (bad) return refused(`git push ${bad} can move master or tags all at once, so it is closed while owner steps wait`);
  const words = positionals(rest, PUSH_VALUE_FLAGS);
  const repoFlag = rest.some(a => a.startsWith('--re') && isAbbrevOf(a.split('=')[0], '--repo'));
  const cats = new Set();
  // every word may be a refspec (with --repo, even the first one)
  for (const w of words) {
    if (w === ':' ) return refused('git push ":" pushes every matching branch, so it is closed while owner steps wait');
    const [src, ...dstParts] = w.split(':');
    const dest = dstParts.length ? dstParts.join(':') : (src.replace(/^\+/, '') === 'HEAD' || src === '@' ? ctx.currentBranch() : src);
    for (const c of destCategory(dest, ctx) || []) cats.add(c);
  }
  // no refspec given: where git would push by itself
  if (words.length <= 1 || (repoFlag && words.length === 0)) {
    const remote = repoFlag ? null : words[0] || null;
    for (const spec of ctx.remotePushSpecs(remote)) {
      const dest = spec.includes(':') ? spec.split(':').pop() : spec;
      for (const c of destCategory(dest, ctx) || []) cats.add(c);
    }
    const target = ctx.pushDest();
    if (target) for (const c of destCategory(target.replace(/^[^/]+\//, ''), ctx) || []) cats.add(c);
    else if (MAIN_BRANCHES.has(ctx.currentBranch())) cats.add('merge');
    if (/^true$/i.test(ctx.config('push.followTags'))) cats.add('tag');
  }
  return touches(...cats);
}

const ONTO_BRANCH = new Set(['merge', 'commit', 'cherry-pick', 'rebase', 'am', 'revert', 'reset']);

function readGit(args, ctx, depth = 0) {
  const p = parseGit(args);
  const risky = [...p.configs.map(configKey), ...ctx.envConfigKeys()].find(k => RISKY_GIT_CONFIG.test(k));
  if (risky) return refused(`git config ${risky} can change where a push goes, so it is closed while owner steps wait`);
  const repo = ctx.forRepo(p.prefix);
  const sub = p.sub;
  if (!sub) return CLEAR;
  const alias = repo.alias(sub);
  if (alias !== null && alias !== undefined) {
    if (depth >= 5 || alias.startsWith('!')) return refused(`git ${sub} is an alias that runs a shell command, so it is closed while owner steps wait`);
    return readGit([...p.prefix, ...alias.trim().split(/\s+/), ...p.rest], ctx, depth + 1);
  }
  if (sub === 'push') return readPush(p.rest, repo);
  // the low-level ways to update a remote are closed outright
  if (['send-pack', 'http-push', 'receive-pack', 'remote-ext', 'remote-fd'].includes(sub)) return refused(`git ${sub} can update a remote without git push, so it is closed while owner steps wait`);
  // fetch and pull can write straight into a local branch: HEAD:refs/heads/master
  if (sub === 'fetch' || sub === 'pull') {
    const cats = new Set();
    for (const w of positionals(p.rest, new Set(['--depth', '--deepen', '--shallow-since', '--shallow-exclude', '-j', '--jobs', '--upload-pack', '--negotiation-tip']))) {
      if (!w.includes(':')) continue;
      for (const c of destCategory(w.split(':').pop(), repo) || []) if (c === 'merge') cats.add(c);
    }
    if (sub === 'pull' && MAIN_BRANCHES.has(repo.currentBranch())) cats.add('merge');
    return touches(...cats);
  }
  if ((sub === 'checkout' || sub === 'switch') && p.rest.some(a => /^-(B|C|-force-create)$/.test(a)) && p.rest.some(a => MAIN_BRANCHES.has(a))) return touches('merge');
  if (ONTO_BRANCH.has(sub) && MAIN_BRANCHES.has(repo.currentBranch())) return touches('merge');
  if (sub === 'update-ref') {
    if (p.rest.includes('--stdin')) return refused('git update-ref --stdin can move any branch, so it is closed while owner steps wait');
    const ref = String(positionals(p.rest, new Set(['-m'])).filter(a => a !== '-d')[0] || '');
    return touches(...(destCategory(ref, repo) || []));
  }
  if (sub === 'branch' && p.rest.some(a => /^(-f|--force|-M|-C|-m|-D|-d|--delete)$/.test(a)) && p.rest.some(a => MAIN_BRANCHES.has(a))) return touches('merge');
  return CLEAR;
}

// git questions answered by the real git, in the repo the command names
function gitContext(gitBin, cwd, env = process.env, prefix = []) {
  const run = a => spawnSync(gitBin || 'git', [...prefix, ...a], { cwd, env, encoding: 'utf8', timeout: 5000 });
  const out = a => { const r = run(a); return r.status === 0 ? String(r.stdout || '').trim() : null; };
  return {
    currentBranch: () => out(['rev-parse', '--abbrev-ref', 'HEAD']) || '',
    isTag: name => Boolean(name) && run(['rev-parse', '-q', '--verify', `refs/tags/${name}`]).status === 0,
    isBranch: name => Boolean(name) && run(['rev-parse', '-q', '--verify', `refs/heads/${name}`]).status === 0,
    pushDest: () => out(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{push}']),
    remotePushSpecs: remote => (out(['config', '--get-all', `remote.${remote || out(['config', '--get', 'remote.pushDefault']) || 'origin'}.push`]) || '').split('\n').filter(Boolean),
    config: key => out(['config', '--get', key]) || '',
    alias: name => out(['config', '--get', `alias.${name}`]),
    envConfigKeys: () => envConfigKeys(env),
    forRepo: more => (more && more.length ? gitContext(gitBin, cwd, env, [...prefix, ...more]) : gitContext(gitBin, cwd, env, prefix)),
  };
}

function analyze(tool, args = [], ctx = {}) {
  const name = path.basename(String(tool || ''));
  if (name === 'npm' || name === 'yarn' || name === 'pnpm') return readPackageTool(name, args.map(String));
  if (name === 'npx' || name === 'pnpx' || name === 'bunx') return refused(`${name} can run any command, so it is closed while owner steps wait`);
  if (name === 'gh') return readGh(args.map(String));
  if (name === 'atris') return readAtris(args.map(String));
  if (name === 'git') return readGit(args.map(String), ctx);
  return CLEAR;
}

// ---- the check each wrapper makes -------------------------------------------------------

// Null: run it. { hold, message }: refuse with that message (the step is
// marked asked, which the phone shows as a yes card). { consume }: run it,
// and on success close those steps.
function check({ stateDir, missionId, seal, tool, args = [], gitBin = null, cwd = process.cwd(), env = process.env, ctx = null } = {}) {
  const sealed = normalizeSeal(seal);
  if (!missionId || !sealed.length) return null;
  const shown = `${path.basename(String(tool))} ${args.join(' ')}`.trim().slice(0, 120);
  const read = analyze(tool, args, ctx || (path.basename(String(tool)) === 'git' ? gitContext(gitBin, cwd, env) : {}));
  if (read.refuse) return { hold: true, message: `held: "${shown}": ${read.refuse}. use an allowed command, or finish the other steps and say what you need in your report.` };
  const lockedCats = new Set(sealed.flatMap(s => s.categories));
  const needed = read.cats.filter(c => lockedCats.has(c));
  if (!needed.length) return null;
  const { locks } = effectiveLocks(stateDir, missionId, sealed);
  const key = JSON.stringify({ tool: path.basename(String(tool)), args: args.map(String), cwd: path.resolve(cwd) });
  // open for this run: approved, not used, approved for exactly this command, and not claimed by another run
  const usable = l => isOpen(l) && l.approved_command === key && !fs.existsSync(claimFile(stateDir, missionId, l));
  const use = [];
  const waiting = [];
  for (const cat of needed) {
    const open = locks.find(l => usable(l) && l.categories.includes(cat));
    if (open) use.push(open);
    else waiting.push(locks.find(l => !usable(l) && l.categories.includes(cat)));
  }
  if (!waiting.length) {
    const claimed = [];
    for (const lock of new Set(use)) {
      try {
        fs.closeSync(fs.openSync(claimFile(stateDir, missionId, lock), 'wx'));
        claimed.push(lock);
      } catch {
        // another run took this yes first
        for (const c of claimed) { try { fs.unlinkSync(claimFile(stateDir, missionId, c)); } catch { /* gone */ } }
        return { hold: true, steps: [lock.step], message: `held: "${shown}": the yes for step ${lock.step} is already being used by another run. one yes covers one run.` };
      }
    }
    return { consume: claimed.map(l => l.step), claims: claimed.map(l => claimFile(stateDir, missionId, l)) };
  }
  const now = new Date().toISOString();
  for (const lock of new Set(waiting)) Object.assign(lock, { asked_at: now, approved_at: null, consumed_at: null, approved_command: null, held_command: shown, held_key: key });
  saveLocks(stateDir, missionId, locks);
  const first = waiting[0];
  const cats = needed.filter(c => !locks.some(l => isOpen(l) && l.categories.includes(c)));
  return {
    hold: true,
    steps: [...new Set(waiting.map(w => w.step))],
    message: `held: "${shown}" would ${cats.map(c => CATEGORY_WORDS[c]).join(' and ')}, and step ${first.step} ("${first.text}") needs the owner's yes first. a yes card is now on the owner's phone. wait for the ping that says yes, then run it again; one yes covers one run.`,
  };
}

// After the run a yes allowed: on success those steps close; on failure the
// claim is dropped so the same yes can be used again.
function consume(stateDir, missionId, seal, steps, { ok = true, claims = [] } = {}) {
  if (!ok) {
    for (const c of claims) { try { fs.unlinkSync(c); } catch { /* gone */ } }
    return;
  }
  const { locks, trusted } = effectiveLocks(stateDir, missionId, seal);
  if (!trusted) return;
  const at = new Date().toISOString();
  for (const l of locks) if (steps.includes(l.step) && isOpen(l)) l.consumed_at = at;
  saveLocks(stateDir, missionId, locks);
}

module.exports = {
  HELD_EXIT,
  analyze,
  approveYesLock,
  askedYesLocks,
  check,
  consume,
  effectiveLocks,
  sealFor,
  stepLocks,
  writeYesLocks,
};
