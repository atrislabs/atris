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
//   - a run woken by a handoff (the fixed handoff seal) runs on an allowlist:
//     only the commands named under "the handoff seal" below run without a
//     yes, and everything else is held
//   - every held command is its own request on the step that holds it, bound
//     to the exact command by a hash; the owner's yes on that card lets that
//     one command start once (the yes is used when it starts, success or not)
//   - a command the lock refuses outright is a request too, on the first step

const crypto = require('crypto');
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
  spend: 'spend money',
};

// A member woken by a handoff always runs under this fixed seal, whatever
// job handed off to it. Under it only an allowlist of reads, local work, PR
// and branch-push commands runs without a yes (sealedVerdict below); every
// other command is one yes card, and a yes lets that one command run once.
// It still opens PRs and pushes branches; autoland lands those under its own
// policy. The job that handed off is kept only to show the card on it
// (parent_mission_id); it never changes what is held.
const HANDOFF_SEAL_TEXT = 'a handed-off job asks before anything goes out or lands on master';

function handoffSeal() {
  return Object.keys(CATEGORY_WORDS).map((category, i) => ({ step: i + 1, text: HANDOFF_SEAL_TEXT, categories: [category] }));
}

const handoffAsk = command => `a handed-off job wants to ${command}`;

function handoffParent(stateDir, missionId) {
  const data = readState(stateDir, missionId);
  return (data && data.parent_mission_id) || null;
}

// Yes cards for held handed-off runs: every lock record under the handoff
// seal, asked and not yet answered, with the job it was handed off from.
// The card says who wants what to go where, in plain words; the raw command
// stays in the lock record (command).
function handoffYesCards(stateDir) {
  let files = [];
  try { files = fs.readdirSync(path.join(stateDir, 'yes-locks')).filter(f => f.endsWith('.json')); } catch { return []; }
  const cards = [];
  for (const name of files) {
    let data = null;
    try { data = JSON.parse(fs.readFileSync(path.join(stateDir, 'yes-locks', name), 'utf8')); } catch { continue; }
    if (!data || !data.mission_id || !Array.isArray(data.locks) || !data.locks.length || !data.locks.every(l => l && l.text === HANDOFF_SEAL_TEXT)) continue;
    for (const lock of askedYesLocks(stateDir, data.mission_id)) {
      const who = data.owner || 'a handed-off job';
      cards.push({ mission_id: data.mission_id, parent_mission_id: data.parent_mission_id || null, who, step: lock.step, hash: lock.hash, command: lock.held_command || null, ask: `${who} wants to ${plainWhat(lock.held_key, who)}` });
    }
  }
  return cards;
}

// What a held command would do, for the owner's yes card: what goes out and
// where, with no flags, settings, or paths. key is the request's record of
// the exact command ({ tool, args, cwd }).
function plainWhat(key, who = '') {
  let cmd = {};
  try { cmd = JSON.parse(key); } catch { return 'run a command the lock holds'; }
  const name = path.basename(String(cmd.tool || ''));
  const args = (Array.isArray(cmd.args) ? cmd.args : []).map(String);
  const cwd = cmd.cwd || process.cwd();
  if (name === 'git') {
    const p = parseGit(args);
    if (p.sub === 'push') return plainPush(p, cwd, who);
    if (p.sub === 'send-pack' || p.sub === 'http-push') return 'push to another computer';
    return 'use a setting that could let a push skip the lock';
  }
  // gh: said exactly, verb and target, or else where it goes and the words
  // it names; a delete never reads as a release
  if (name === 'gh') return describeGh(args) || `run a command that changes GitHub: "${args.join(' ')}"`;
  if (name === 'npm' || name === 'yarn' || name === 'pnpm') {
    const [sub = '', folder = ''] = packageWords(args).words.map(String);
    // the package it names: a folder given to publish, else this folder
    let pkg = 'a package';
    for (const dir of [folder && path.resolve(cwd, folder), cwd].filter(Boolean)) {
      try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name || pkg; break; } catch { /* not a package folder */ }
    }
    if (PKG_PUBLISH.has(sub)) return sub.startsWith('dist-tag') ? `change which version of ${pkg} npm installs` : `publish ${pkg} to npm`;
    if (sub === 'version') return `make a new version of ${pkg}`;
    return `run ${name} in a way the lock does not know`;
  }
  if (name === 'npx' || name === 'pnpx' || name === 'bunx') return 'run a tool downloaded from npm';
  if (name === 'atris') {
    const [verb = ''] = positionals(args, new Set(['--account', '--as', '--from', '--to', '--channel']));
    const read = readAtris(args);
    if (read.cats.includes('spend')) return `spend Atris credits on ${verb}`;
    // one phrase, the weightiest kind it touches
    const phrase = { deploy: 'deploy a site', publish: 'publish something', merge: 'land work on master', tag: 'push a version tag', post: 'post in public', send: 'send a message' };
    const kind = ['deploy', 'publish', 'merge', 'tag', 'post', 'send'].find(c => read.cats.includes(c));
    if (kind) return phrase[kind];
    if (ATRIS_REFUSED.has(verb)) return 'answer one of your asks for you';
    return `run atris ${verb}`;
  }
  return 'run a command the lock holds';
}

// "push its job deck branch to GitHub": the branch in words, and the host
function plainPush(p, cwd, who) {
  const words = positionals(p.rest, PUSH_VALUE_FLAGS);
  const remote = words[0] || 'origin';
  let url = '';
  try { url = String(spawnSync('git', [...p.prefix, 'remote', 'get-url', '--push', remote], { cwd, encoding: 'utf8', timeout: 5000 }).stdout || '').trim(); } catch { /* no repo */ }
  const host = (url.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)/i) || url.match(/^[^@/:]+@([^:/]+):/) || [])[1] || '';
  const where = /github\.com$/i.test(host) ? 'GitHub' : /gitlab\.com$/i.test(host) ? 'GitLab' : host ? host : (url ? 'a folder on this computer' : 'its remote');
  if (p.rest.some(a => /^--(tags|follow-tags|mirror|all)/.test(a))) return `push tags or every branch to ${where}`;
  const ref = String(words[1] || '');
  const dst = ref.replace(/^\+/, '').split(':').pop().replace(/^refs\/(heads|tags)\//, '');
  // a delete is said as a delete, with the name it removes
  if (p.rest.some(a => a === '--delete' || a === '-d') || /^\+?:/.test(ref)) return dst ? `delete ${dst} on ${where}` : `delete something on ${where}`;
  const force = /^\+/.test(ref) || p.rest.some(a => /^(--force|-f|--force-with-lease|--force-if-includes)(=|$)/.test(a));
  const said = pushWords(dst, ref, where, who);
  return force ? `force ${said}, replacing what is there` : said;
}

function pushWords(dst, ref, where, who) {
  if (!dst) return `push to ${where}`;
  if (isMainRef(dst)) return `push to master on ${where}`;
  if (/^refs\/tags\//.test(ref.split(':').pop()) || /^v?\d+\.\d+/.test(dst)) return `push the tag ${dst} to ${where}`;
  const first = String(who).toLowerCase();
  const plain = dst.split('/').pop().replace(/[-_]\d{8}(?:[-_]\d{4,6})?$/, '').split(/[-_.]+/).filter((w, i) => w && !(i === 0 && w.toLowerCase() === first)).join(' ');
  return plain ? `push its ${plain} branch to ${where}` : `push a branch to ${where}`;
}

// One command's flags as it takes them: known switches, known options with
// one value each, and the words left over. Anything else is null.
function readArgs(words, { switches = [], values = [] } = {}) {
  const out = { flags: new Set(), opts: {}, rest: [] };
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (!w.startsWith('-') || w === '-') { out.rest.push(w); continue; }
    const eq = w.indexOf('=');
    const name = eq > 0 ? w.slice(0, eq) : w;
    if (values.includes(name)) {
      const v = eq > 0 ? w.slice(eq + 1) : words[(i += 1)];
      if (!v || v.startsWith('-')) return null;
      out.opts[name] = v;
    } else if (eq < 0 && switches.includes(w)) out.flags.add(w);
    else return null;
  }
  return out;
}

const NAME = /^[\w.@+-]+$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;

// Exact words for a held command, verb and target, or null when it
// cannot be said exactly. words: the tool, then its arguments.
function describeCommand(words) {
  if (words[0] === 'gh') return describeGh(words.slice(1));
  if (words[0] === 'git' && words[1] === 'push') return describePush(words.slice(2));
  if ((words[0] === 'npm' || words[0] === 'pnpm') && words[1] === 'publish') return describePublish(words.slice(2));
  return null;
}

function describeGh([group, verb, ...more]) {
  const repo = a => {
    const r = a.opts['-R'] || a.opts['--repo'];
    if (!r) return 'in this repo';
    return REPO.test(r) ? `in ${r}` : null;
  };
  const has = (a, ...names) => names.some(n => a.flags.has(n));
  if (group === 'release' && verb === 'delete') {
    const a = readArgs(more, { switches: ['--yes', '-y', '--cleanup-tag'], values: ['-R', '--repo'] });
    if (!a || a.rest.length !== 1 || !NAME.test(a.rest[0]) || !repo(a)) return null;
    return `delete the GitHub release ${a.rest[0]}${has(a, '--cleanup-tag') ? ' and its tag' : ''} ${repo(a)}`;
  }
  if (group === 'release' && verb === 'create') {
    const a = readArgs(more, { switches: ['--draft', '-d', '--prerelease', '-p', '--generate-notes'], values: ['-R', '--repo', '--title', '-t', '--notes', '-n', '--target'] });
    if (!a || a.rest.length !== 1 || !NAME.test(a.rest[0]) || !repo(a)) return null;
    const target = a.opts['--target'];
    if (target && !NAME.test(target)) return null;
    const kind = [has(a, '--draft', '-d') && ' as a draft', has(a, '--prerelease', '-p') && ' as a prerelease'].filter(Boolean).join(' and');
    return `create the GitHub release ${a.rest[0]}${kind}${target ? ` from ${target}` : ''} ${repo(a)}`;
  }
  if (group === 'pr' && (verb === 'merge' || verb === 'close')) {
    const a = readArgs(more, { switches: verb === 'merge' ? ['--merge', '-m', '--squash', '-s', '--rebase', '-r', '--delete-branch', '-d'] : ['--delete-branch', '-d'], values: ['-R', '--repo'] });
    if (!a || a.rest.length > 1 || !repo(a)) return null;
    const which = a.rest[0];
    if (which && !NAME.test(which)) return null;
    const pr = !which ? 'the pull request for this branch' : /^\d+$/.test(which) ? `pull request ${which}` : `the pull request for ${which}`;
    const how = [has(a, '--merge', '-m') && 'merge', has(a, '--squash', '-s') && 'squash and merge', has(a, '--rebase', '-r') && 'rebase and merge'].filter(Boolean);
    if (how.length > 1) return null;
    const act = verb === 'close' ? 'close' : how[0] || 'merge';
    return `${act} ${pr}${has(a, '--delete-branch', '-d') ? ' and delete its branch' : ''} ${repo(a)}`;
  }
  return null;
}

function describePush(args) {
  const a = readArgs(args, { switches: ['--tags', '--force', '-f', '--delete', '-d', '--set-upstream', '-u'] });
  if (!a || a.rest.length > 2) return null;
  const [remote, ref] = a.rest;
  if (remote && !NAME.test(remote)) return null;
  const to = remote || 'the default remote';
  const force = a.flags.has('--force') || a.flags.has('-f');
  const del = a.flags.has('--delete') || a.flags.has('-d');
  if (a.flags.has('--tags')) return ref || force || del ? null : `push every tag to ${to}`;
  if (!ref) return del ? null : `${force ? 'force push' : 'push'} this branch to ${to}${force ? ', replacing what is there' : ''}`;
  const plus = ref.startsWith('+');
  const parts = (plus ? ref.slice(1) : ref).split(':');
  if (parts.length > 2 || parts.some(x => x && !/^[\w./-]+$/.test(x))) return null;
  const [src, dst] = parts;
  if (del || (parts.length === 2 && !src)) return del && parts.length === 2 ? null : plus || force ? null : `delete ${dst || src} on ${to}`;
  if (parts.length === 2 && !dst) return null;
  const strong = force || plus;
  return `${strong ? 'force push' : 'push'} ${dst ? `${src} to ${dst} on ${to}` : `${src} to ${to}`}${strong ? ', replacing what is there' : ''}`;
}

function describePublish(args) {
  const a = readArgs(args, { values: ['--tag', '--access'] });
  if (!a || a.rest.length > 1) return null;
  const access = a.opts['--access'];
  if (access && access !== 'public' && access !== 'restricted') return null;
  const tag = a.opts['--tag'];
  if (tag && !NAME.test(tag)) return null;
  const extra = [tag && `under the ${tag} tag`, access].filter(Boolean).join(', ');
  return `publish ${a.rest.length ? `the package in "${a.rest[0]}"` : 'this package'} to npm${extra ? ` ${extra}` : ''}`;
}

// ---- what an owner step locks ------------------------------------------------------

const STEP_WORDS = [
  [/\b(publish|publishes|published|release|releases|released|npm)\b/, ['publish', 'tag']],
  [/\b(tag|tags)\b/, ['tag']],
  [/\b(post|posts|tweet|tweets|thread|announce|launch|show hn|hacker news|linkedin|reddit)\b/, ['post']],
  [/\b(send|sends|email|emails|dm|dms|message|messages|text|reply|invite|invites|outreach)\b/, ['send']],
  [/\b(merge|merges|merged|land|lands)\b/, ['merge']],
  [/\b(deploy|deploys|deployed)\b/, ['deploy']],
  [/\b(pay|pays|paid|buy|buys|bought|purchase|purchases|spend|spends|subscribe|top up|topup|checkout|order|orders)\b/, ['spend']],
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

function writeYesLocks(stateDir, missionId, { betId = null, seal = [], parentMissionId = null, owner = null } = {}) {
  const locks = normalizeSeal(seal).map(s => ({ ...s, asked_at: null, approved_at: null, consumed_at: null }));
  writeState(stateDir, missionId, { mission_id: missionId, bet_id: betId, ...(parentMissionId ? { parent_mission_id: parentMissionId } : {}), ...(owner ? { owner } : {}), locks });
  return locks;
}

// One held command, on the step that holds it: its exact text and folder
// (key), a short hash of the key that the yes card carries, when it was
// asked, when the owner said yes, and when that yes was used.
const commandHash = key => crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16);

function rowRequests(row) {
  if (row && Array.isArray(row.requests)) return row.requests.filter(r => r && r.key && r.hash).map(r => ({ ...r }));
  return [];
}

// What a step looks like from outside: its newest waiting command, and its
// yes that is given and not used yet.
function stepSummary(requests) {
  const pending = requests.filter(r => !r.approved_at && !r.used_at && !r.denied_at);
  const open = requests.find(r => r.approved_at && !r.used_at) || null;
  const used = requests.filter(r => r.used_at);
  const last = pending[pending.length - 1] || null;
  const lastUsed = used[used.length - 1] || null;
  return {
    asked_at: last ? last.asked_at : null,
    approved_at: open ? open.approved_at : (lastUsed ? lastUsed.approved_at : null),
    consumed_at: !open && lastUsed ? lastUsed.used_at : null,
    ...(last ? { held_command: last.command, held_key: last.key } : {}),
    ...(open ? { approved_command: open.key } : {}),
  };
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
  const build = (s, requests) => ({ ...s, requests, ...stepSummary(requests) });
  if (!trusted) return { locks: sealed.map(s => build(s, [])), trusted: false };
  return { trusted: true, locks: sealed.map(s => build(s, rowRequests(rows.find(r => r.step === s.step)))) };
}

// A yes is taken by the one run it allows, with a file only one process can
// create, as that run starts.
function claimFile(stateDir, missionId, lock, request) {
  return `${stateFile(stateDir, missionId)}.step-${lock.step}.${request.hash}.${String(request.approved_at).replace(/[^0-9A-Za-z]/g, '')}.claim`;
}

function saveLocks(stateDir, missionId, locks, betId) {
  const prior = readState(stateDir, missionId);
  const rows = locks.map(l => ({ step: l.step, text: l.text, categories: l.categories, requests: rowRequests(l) }));
  writeState(stateDir, missionId, { mission_id: missionId, bet_id: (prior && prior.bet_id) || betId || null, ...(prior && prior.parent_mission_id ? { parent_mission_id: prior.parent_mission_id } : {}), ...(prior && prior.owner ? { owner: prior.owner } : {}), locks: rows });
}

// The yes covers the one command on the card the owner answered: the waiting
// request with that hash. Without a hash (an older caller), the newest
// waiting request on the step. null when nothing matches.
function approveYesLock(stateDir, missionId, step, seal, at = new Date().toISOString(), { hash = null } = {}) {
  const { locks } = effectiveLocks(stateDir, missionId, seal || sealFromState(stateDir, missionId));
  const lock = locks.find(l => l.step === step);
  if (!lock) return null;
  const waiting = lock.requests.filter(r => !r.approved_at && !r.used_at && !r.denied_at);
  const target = hash ? waiting.find(r => r.hash === hash) : waiting[waiting.length - 1];
  if (!target) return null;
  target.approved_at = at || new Date().toISOString();
  saveLocks(stateDir, missionId, locks);
  return { ...lock, ...stepSummary(lock.requests), approved: target };
}

// The owner's no: the one waiting request with that hash is told no for good.
// It never runs, its card is gone, and asking again only hears the no.
// Without a hash (an older caller), the newest waiting request on the step.
function denyYesLock(stateDir, missionId, step, { hash = null, at = new Date().toISOString() } = {}) {
  const { locks } = effectiveLocks(stateDir, missionId, sealFromState(stateDir, missionId));
  const lock = locks.find(l => l.step === step);
  const waiting = lock ? lock.requests.filter(r => !r.approved_at && !r.used_at && !r.denied_at) : [];
  const target = hash ? waiting.find(r => r.hash === hash) : waiting[waiting.length - 1];
  if (!target) return null;
  target.denied_at = at;
  saveLocks(stateDir, missionId, locks);
  return { ...lock, denied: target };
}

// For readers that have no mission record at hand (the desk), the state file
// is its own seal: it is only ever used to show and answer cards, never to let
// a command through.
function sealFromState(stateDir, missionId) {
  const data = readState(stateDir, missionId);
  return data && Array.isArray(data.locks) ? data.locks : [];
}

// Every held command still waiting for a yes: one card each.
function askedYesLocks(stateDir, missionId) {
  const data = readState(stateDir, missionId);
  if (!data || !Array.isArray(data.locks)) return [];
  const cards = [];
  for (const row of data.locks) {
    for (const r of rowRequests(row)) {
      if (r.approved_at || r.used_at || r.denied_at) continue;
      cards.push({ step: row.step, text: row.text, categories: row.categories, held_command: r.command, held_key: r.key, hash: r.hash, asked_at: r.asked_at });
    }
  }
  return cards;
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

// Every non-option word, in order, as the tool reads them: "--" only ends
// the options, so in `npm -- publish` the command is publish. An option this
// code does not know might take the next word as its value, so it must use
// --key=value.
function packageWords(args) {
  const words = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i] || '');
    if (a === '--') { words.push(...args.slice(i + 1).map(String)); break; }
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

// atris. Audited from lib/known-commands.js (Codex review round 6 on #1483):
// every verb that spends, posts, sends, publishes, deploys, or lands is held
// by kind; verbs that do both read and write are held unless the sub-command
// is a read by name; the run's own machinery and plain reads go; a verb not
// on any list is held, so a new outward command never slips through.
const ATRIS_OUTWARD = {
  pay: ['spend'], buy: ['spend'], topup: ['spend'], hire: ['spend'], stripe: ['spend'],
  publish: ['publish'], pack: ['publish'], release: ['publish', 'tag'], push: ['publish'], sync: ['publish'],
  host: ['deploy'], vercel: ['deploy'], supabase: ['deploy'],
  land: ['merge'], autoland: ['merge'],
  msg: ['send'], invite: ['send'], feedback: ['send'], signup: ['send'], join: ['send'],
  social: ['post'], follow: ['post'], unfollow: ['post'], x: ['post'],
};
// outward unless the sub-command is a read: what the write would touch
const ATRIS_MIXED = {
  feed: ['post'], twitter: ['post', 'send'], slack: ['send', 'post'], gmail: ['send'], mail: ['send'], email: ['send'],
  imessage: ['send'], calendar: ['send'], meet: ['send'], drive: ['send'], site: ['publish', 'deploy'], deck: ['publish'],
  app: ['deploy'], apps: ['deploy'], plugin: ['publish'], cloud: ['publish'], github: ['merge', 'publish'], fork: ['publish'], business: ['deploy', 'publish'],
  'api-key': ['spend'], linear: ['post'], people: ['send'], card: ['publish'], reel: ['publish'],
};
const ATRIS_READ_SUBS = new Set(['', 'list', 'ls', 'status', 'show', 'view', 'get', 'read', 'search', 'find', 'info', 'check', 'help', 'preview', 'history', 'log', 'logs', 'inbox', 'unread', 'stats', 'whoami', 'events', 'today', 'upcoming', 'agenda', 'pull', 'download', 'export', 'diff', 'doctor', 'draft', 'drafts']);
// owner answers and account changes: never from inside a held run
const ATRIS_REFUSED = new Set(['approve', 'decide', 'login', 'logout', 'switch', 'use', 'sign', 'trust']);
// the run's own machinery, and plain reads
const ATRIS_INTERNAL = new Set([
  'init', 'guide', 'doctor', 'doc-health', 'install', 'workspace', 'log', 'logs', 'later', 'done', 'wish', 'ask', 'stop', 'ready', 'check', 'drill', 'dream', 'now', 'goal', 'wtf',
  'founder', 'orb', 'radar', 'who', 'stream', 'ctop', 'launchpad', 'status', 'analytics', 'revisions', 'visualize', 'brain', 'brainstorm', 'autopilot', 'run', 'plan', 'do', 'review',
  'activate', '_activate', 'agent', 'team', 'chat', 'fast', 'ax', 'console', 'serve', 'whoami', 'accounts', '_resolve', '_profile-email', '_switch-session', 'shell-init', 'update', 'upgrade',
  'version', 'help', 'next', 'atris', 'clean', 'close', 'harvest', 'verify', 'recover', 'search', 'scout', 'skill', 'member', 'codex-goal', 'learn', 'lesson', 'taste', 'teach',
  'experiments', 'bench', 'router', 'tree', 'receipt', 'proof', 'openclaw', 'pull', 'watch', 'live', 'align', 'terminal', 'computer', 'diff', 'youtube', 'x-search',
  'ingest', 'query', 'lint', 'loop', 'pulse', 'task', 'mission', 'campaign', 'agents', 'probe', 'worktree', 'caretaker', 'aeo', 'slop', 'voice', 'strings', 'write',
  'security-review', 'secure', 'theme', 'improve', 'study', 'rainmaker', 'xp', 'play', 'gm', 'game', 'recap', 'report', 'clarity', 'interview', 'moves', 'unknowns', 'avail',
  'scoreboard', 'sync-checkout', 'zen', 'ci', 'balance', 'usage', 'agent-client', 'transactions', 'hires', 'design', 'mcp', 'integrations', 'setup', 'clean-workspace', 'cw',
  'browse', 'sleep', 'wake', 'errors', 'wiki', 'code-review', 'cr', 'soul', 'fleet', 'fleet-report', 'loops', 'self-improve', 'compile', 'spaceship', 'truth', 'engine',
  'engines', 'link', 'playbook', 'brief', 'inbox', 'friends', 'rsi',
]);

// Atris verbs that cost credits (Codex review round 9 on #1483), read from
// each verb's command file and the backend route it calls: hosted chat and
// Atris 2 turns, cloud computer runs and wakes (billed per hour while
// awake), image generation, paid search and video processing, AEO writes,
// improve ticks, cloud missions, and cloud campaign runs. Each test says
// whether this use of the verb is the paid one.
const HELP = new Set(['help', '--help', '-h']);
// an empty or unknown sub is spend, as with npm; only the subs named here are free
const paidUnless = (...free) => sub => !free.includes(sub) && !HELP.has(sub);
const ATRIS_PAID = {
  'x-search': paidUnless(),
  // plain search is local and free; --paid search, and processing a video (the default), cost credits
  youtube: (sub, args) => (sub === 'search' ? args.includes('--paid') : paidUnless('unsave', 'notes', 'teach', 'digest', 'bench', 'watch')(sub)),
  improve: paidUnless('doctor', 'revisions'),
  // init and draft wake the cloud computer and run there
  aeo: paidUnless('scan', 'log', 'status', 'packet', 'proofs', 'discover', 'audit'),
  computer: paidUnless('status', 'doctor'),
  visualize: paidUnless(),
  ask: paidUnless(),
  chat: paidUnless('scan'),
  fast: paidUnless(),
  ax: paidUnless(),
  agent: paidUnless('doctor', 'spawns', 'spawn-status'),
  campaign: paidUnless('start', 'status', 'list', 'show', 'export', 'features', 'keep', 'propose', 'rsi', 'schedule', 'sync', 'wake'),
  // these wake the cloud computer
  wake: paidUnless(),
  align: paidUnless(),
  terminal: paidUnless(),
  pull: paidUnless(),
  'fleet-report': paidUnless(),
  // the cloud wiki runs a hosted chat job
  wiki: (sub, args) => args.includes('--cloud'),
  ingest: (sub, args) => args.includes('--cloud'),
  query: (sub, args) => args.includes('--cloud'),
  lint: (sub, args) => args.includes('--cloud'),
};

function readAtris(args) {
  const words = positionals(args, new Set(['--account', '--as', '--from', '--to', '--channel']));
  const [cmd = '', sub = ''] = words;
  if (ATRIS_REFUSED.has(cmd)) return refused(`atris ${cmd} answers for the owner or changes the account, so it waits for the owner's yes`);
  const cats = [];
  if (ATRIS_OUTWARD[cmd]) cats.push(...ATRIS_OUTWARD[cmd]);
  else if (ATRIS_MIXED[cmd] && !ATRIS_READ_SUBS.has(sub)) cats.push(...ATRIS_MIXED[cmd]);
  if (Object.prototype.hasOwnProperty.call(ATRIS_PAID, cmd) && ATRIS_PAID[cmd](sub, args)) cats.push('spend');
  if (cats.length) return touches(...cats);
  if (cmd === '' || ATRIS_INTERNAL.has(cmd) || ATRIS_MIXED[cmd]) return CLEAR;
  return refused(`atris ${cmd} is not on the list of commands a locked job may run`);
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
  // a remote set up as a mirror pushes every branch and tag, whatever is named
  const remote = repoFlag ? null : words[0] || null;
  if (isGitTrue(ctx.config(`remote.${remote || ctx.config('remote.pushDefault') || 'origin'}.mirror`))) {
    return refused(`git push to a mirror remote pushes every branch and tag, so it is closed while owner steps wait`);
  }
  // no refspec given: where git would push by itself
  if (words.length <= 1 || (repoFlag && words.length === 0)) {
    for (const spec of ctx.remotePushSpecs(remote)) {
      const dest = spec.includes(':') ? spec.split(':').pop() : spec;
      for (const c of destCategory(dest, ctx) || []) cats.add(c);
    }
    const target = ctx.pushDest();
    if (target) for (const c of destCategory(target.replace(/^[^/]+\//, ''), ctx) || []) cats.add(c);
    else if (MAIN_BRANCHES.has(ctx.currentBranch())) cats.add('merge');
  }
  // followTags sends annotated tags along with any push, named branch or not
  if (isGitTrue(ctx.config('push.followTags')) && !rest.includes('--no-follow-tags')) cats.add('tag');
  return touches(...cats);
}

const isGitTrue = v => /^(true|yes|on|1)$/i.test(String(v || '').trim());

const ONTO_BRANCH = new Set(['merge', 'commit', 'cherry-pick', 'rebase', 'am', 'revert', 'reset']);

function readGit(args, ctx, depth = 0) {
  const p = parseGit(args);
  const repo = ctx.forRepo(p.prefix);
  const sub = p.sub;
  if (!sub) return CLEAR;
  // config that can reroute matters to a push, or a command that reaches a
  // network remote; local work passes whatever config it runs with
  const risky = [...p.configs.map(configKey), ...ctx.envConfigKeys()].find(k => RISKY_GIT_CONFIG.test(k));
  // an alias given with -c can turn any command into a push
  const reaches = ['push', 'send-pack', 'http-push'].includes(sub) || /^alias\./i.test(risky || '') || talksToNetwork(sub, p.rest, repo);
  if (risky && reaches) return refused(`git config ${risky} can change where a push goes, so it is closed while owner steps wait`);
  // git never applies an alias named after one of its own commands, so
  // neither does this: a stored alias.push is ignored and push is push
  const alias = isGitBuiltin(sub, repo) ? null : repo.alias(sub);
  if (alias !== null && alias !== undefined) {
    if (depth >= 5 || alias.startsWith('!')) return refused(`git ${sub} is an alias that runs a shell command, so it is closed while owner steps wait`);
    return readGit([...p.prefix, ...alias.trim().split(/\s+/), ...p.rest], ctx, depth + 1);
  }
  if (sub === 'push') return readPush(p.rest, repo);
  if (sub === 'config') return readGitConfig(p.rest);
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
  // symbolic-ref NAME REF makes NAME follow REF; pointing master at another
  // branch moves master with every commit there
  if (sub === 'symbolic-ref') {
    const refs = positionals(p.rest, new Set(['-m']));
    const writes = refs.length >= 2 || p.rest.some(a => a === '-d' || a === '--delete');
    if (writes && refs.some(r => isMainRef(r))) return touches('merge');
  }
  return CLEAR;
}

// master, or any ref under it, however it is spelled; any case, since on a
// case-insensitive disk refs/heads/MASTER is the same file as master
function isMainRef(name) {
  const rel = String(name || '').toLowerCase().replace(/^\+/, '').replace(/^refs\//, '').replace(/^heads\//, '');
  return [...MAIN_BRANCHES].some(b => rel === b || rel.startsWith(`${b}/`));
}

// The commands git runs itself, before it ever looks at an alias. The real
// list comes from the git in use; this short one stands in when it cannot be
// read, and names every command this lock reads.
const GIT_BUILTINS_FALLBACK = new Set(['push', 'fetch', 'pull', 'merge', 'commit', 'rebase', 'reset', 'update-ref', 'branch', 'checkout', 'switch', 'tag', 'config', 'send-pack', 'http-push', 'receive-pack', 'cherry-pick', 'am', 'revert', 'remote', 'status', 'log', 'diff', 'add', 'rm', 'mv', 'show', 'stash', 'worktree', 'clone', 'init']);

function isGitBuiltin(name, ctx) {
  if (GIT_BUILTINS_FALLBACK.has(name)) return true;
  try { return Boolean(ctx && typeof ctx.isBuiltin === 'function' && ctx.isBuiltin(name)); } catch { return false; }
}

// git config: reads run; writing a key that can reroute a push or define an
// alias, or opening the editor, is held.
function readGitConfig(rest) {
  const READ_FLAGS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l', '--get-color', '--get-colorbool']);
  if (rest.some(a => READ_FLAGS.has(String(a).split('=')[0]))) return CLEAR;
  if (rest.some(a => a === '-e' || a === '--edit')) return refused('git config --edit can write any setting, so it is closed while owner steps wait');
  const words = positionals(rest, new Set(['--file', '-f', '--blob', '--type', '--default', '--comment']));
  if (words[0] === 'get' || words[0] === 'list') return CLEAR;
  const keys = words[0] === 'set' || words[0] === 'unset' || words[0] === 'rename-section' || words[0] === 'remove-section' ? words.slice(1) : words;
  const risky = keys.find(k => RISKY_GIT_CONFIG.test(k) || /^alias(\.|$)/i.test(k));
  if (risky) return refused(`git config ${risky} can change what a git command does, so it is closed while owner steps wait`);
  return CLEAR;
}

// git questions answered by the real git, in the repo the command names
function gitContext(gitBin, cwd, env = process.env, prefix = []) {
  const run = a => spawnSync(gitBin || 'git', [...prefix, ...a], { cwd, env, encoding: 'utf8', timeout: 5000 });
  const out = a => { const r = run(a); return r.status === 0 ? String(r.stdout || '').trim() : null; };
  let builtins = null;
  return {
    currentBranch: () => out(['rev-parse', '--abbrev-ref', 'HEAD']) || '',
    isTag: name => Boolean(name) && run(['rev-parse', '-q', '--verify', `refs/tags/${name}`]).status === 0,
    isBranch: name => Boolean(name) && run(['rev-parse', '-q', '--verify', `refs/heads/${name}`]).status === 0,
    pushDest: () => out(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{push}']),
    remotePushSpecs: remote => (out(['config', '--get-all', `remote.${remote || out(['config', '--get', 'remote.pushDefault']) || 'origin'}.push`]) || '').split('\n').filter(Boolean),
    config: key => out(['config', '--get', key]) || '',
    configBool: key => out(['config', '--bool', '--get', key]) || '',
    configAll: key => (out(['config', '--get-all', key]) || '').split('\n').filter(Boolean),
    remoteNames: () => (out(['remote']) || '').split('\n').filter(Boolean),
    // with insteadOf, pushInsteadOf and pushurl applied, as git push sees them
    remoteUrls: (remote, { push = false } = {}) => (out(['remote', 'get-url', ...(push ? ['--push'] : []), '--all', remote]) || '').split('\n').filter(Boolean),
    alias: name => out(['config', '--get', `alias.${name}`]),
    isBuiltin: name => {
      if (builtins === null) builtins = new Set((out(['--list-cmds=builtins']) || '').split('\n').filter(Boolean));
      return builtins.has(name);
    },
    envConfigKeys: () => envConfigKeys(env),
    env: () => env,
    fullRefName: name => out(['rev-parse', '--symbolic-full-name', name]) || '',
    forRepo: more => (more && more.length ? gitContext(gitBin, cwd, env, [...prefix, ...more]) : gitContext(gitBin, cwd, env, prefix)),
  };
}

// ---- the handoff seal --------------------------------------------------------------
//
// A run woken by a handoff guards git push, not every git command. Nothing
// local publishes anything, and landing goes through origin/master, not
// local master; the engines and test suites run far more git than any list
// can name (3.74.0 to 3.74.4 held 546 harmless commands). What stays guarded
// is what can reach a network remote: a push, and the -c or environment that
// could run a push past the wrapper, since git runs a program named in its
// config with its own folder first on PATH. gh and npm, yarn, pnpm keep their
// lists below, and atris holds its outward and spend verbs. A bet's owner
// steps still lock by kind (analyze above).

const pass = (args = null) => ({ ok: true, args });
const hold = why => ({ ok: false, why });
const isHandoffSeal = sealed => sealed.some(s => s.text === HANDOFF_SEAL_TEXT);
const PUSH_HINT = 'a branch push runs without a yes as: git push origin <branch>';

// the shape of a branch name git accepts, without the corners that read as something else
const BRANCH_NAME = /^(?!-)(?!\.)(?!.*\.\.)(?!.*\/\/)(?!.*\/\.)(?!.*@\{)(?!.*\.lock(?:\/|$))[A-Za-z0-9._/-]+(?<![./])$/;

// -c a woken run may pass: a value that only turns something off, or a key
// that only changes how output looks or who a commit is by. The engines
// harden their own git calls this way. A -c that names a program, path,
// command, alias, helper, pager, editor, or route is held, and so are the
// keys whose value is a name, URL, or refspec (alias, remote, url, push,
// include, credential, branch routing), where even an empty value can
// reroute (url.<x>.insteadOf=).
const GIT_DISPLAY_KEYS = new Set(['format.pretty', 'log.showsignature', 'status.showuntrackedfiles', 'core.quotepath', 'core.safecrlf', 'safe.barerepository', 'color.ui', 'user.name', 'user.email']);
const GIT_ROUTE_KEYS = /^(alias|remote|url|push|include|includeif|credential)\.|^branch\..+\.(remote|pushremote|merge)$/;

function sealedGitConfigOk(pair) {
  const eq = String(pair).indexOf('=');
  const key = (eq < 0 ? String(pair) : String(pair).slice(0, eq)).trim().toLowerCase();
  const value = eq < 0 ? 'true' : String(pair).slice(eq + 1).trim();
  if (GIT_DISPLAY_KEYS.has(key)) return true;
  if (key === 'core.hookspath') return value === '/dev/null';
  if (GIT_ROUTE_KEYS.test(key)) return false;
  return /^(|false|never|0|no|off)$/i.test(value);
}

// The same, set through the environment. GIT_CONFIG_NOSYSTEM only turns the
// system file off, so it adds nothing git could run.
function gitEnvProblem(env) {
  const names = Object.keys(env || {}).filter(k => env[k] !== undefined && env[k] !== '');
  return names.find(k => (/^GIT_CONFIG/.test(k) && k !== 'GIT_CONFIG_NOSYSTEM') || k === 'GIT_EXEC_PATH') || null;
}

// git prints these and stops without running the command after them
const GIT_PRINT_AND_EXIT = new Set(['--exec-path', '--version', '--help', '-h', '--html-path', '--man-path', '--info-path']);

// The options before the command. -C, --git-dir, --work-tree, and
// --namespace pick the repo; a -c that fails the reading above, --config-env,
// and --exec-path=<dir> are noted as bad, which matters only for a command
// that talks to a network remote.
function sealedGitPrefix(args) {
  const prefix = [];
  let bad = null;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(a)) {
      const value = String(args[i + 1] === undefined ? '' : args[i + 1]);
      if (a === '-c' && !sealedGitConfigOk(value)) bad = bad || `-c ${value}`;
      prefix.push(a, value);
      i += 1;
      continue;
    }
    if (/^--config-env(=|$)/.test(a) || a.startsWith('--exec-path=')) bad = bad || a;
    if (a.startsWith('-')) { prefix.push(a); continue; }
    return { prefix, bad, sub: a, rest: args.slice(i + 1) };
  }
  return { prefix, bad, sub: '', rest: [] };
}

// Does this git command talk to a network remote? Pushes, fetches, pulls,
// ls-remote, and clones to a remote on disk are local work. When the remote
// cannot be read, it counts as a network one.
const GIT_REMOTE_SUBS = new Set(['push', 'send-pack', 'http-push', 'fetch', 'pull', 'ls-remote', 'clone']);
const GIT_REMOTE_VALUE_FLAGS = new Set(['--depth', '--deepen', '--shallow-since', '--shallow-exclude', '-j', '--jobs', '--upload-pack', '--negotiation-tip', '--refmap', '--filter', '-o', '--server-option', '--push-option', '--receive-pack', '--exec', '-s', '--strategy', '-X', '--strategy-option', '-b', '--branch', '--origin', '--template', '--reference', '--separate-git-dir', '-c', '--config']);

function talksToNetwork(sub, rest, repo) {
  if (!GIT_REMOTE_SUBS.has(sub)) return false;
  if (sub === 'http-push') return true;
  if (typeof repo.remoteUrls !== 'function') return true;
  const isPush = sub === 'push' || sub === 'send-pack';
  const repoFlag = rest.find(a => /^--repo=/.test(String(a)));
  const words = positionals(rest, GIT_REMOTE_VALUE_FLAGS);
  const branch = repo.currentBranch();
  const targets = sub === 'fetch' && rest.some(a => a === '--all' || a === '--multiple')
    ? (repo.remoteNames ? repo.remoteNames() : ['origin'])
    : [repoFlag ? repoFlag.slice('--repo='.length) : words[0]
      || (isPush && (repo.config(`branch.${branch}.pushRemote`) || repo.config('remote.pushDefault')))
      || repo.config(`branch.${branch}.remote`) || 'origin'];
  return targets.some((target) => {
    const urls = repo.remoteUrls(target, { push: isPush });
    if (urls.length) return !urls.every(isLocalUrl);
    // no URL read: a path is local; a remote name git could not read counts as network
    return !/^(file:\/\/|\/|\.\.?(\/|$)|~)/.test(String(target));
  });
}

function sealedGit(args, ctx, depth = 0) {
  const p = sealedGitPrefix(args);
  if (!p.sub || p.prefix.some(a => GIT_PRINT_AND_EXIT.has(a))) return pass();
  // the lock's own questions leave out options that could break them
  const repo = ctx.forRepo(p.prefix.filter(a => !GIT_PRINT_AND_EXIT.has(a) && !/^--(config-env|exec-path=)/.test(a)));
  // an alias that turns into a push is a push; one that runs a shell could
  // run a git that skips the wrapper
  const alias = isGitBuiltin(p.sub, repo) ? null : repo.alias(p.sub);
  if (alias !== null && alias !== undefined) {
    if (depth >= 5 || alias.startsWith('!')) return hold(`git ${p.sub} is an alias that runs a shell command`);
    return sealedGit([...p.prefix, ...alias.trim().split(/\s+/), ...p.rest], ctx, depth + 1);
  }
  // local work passes in any folder, whatever config the test suite or
  // engine runs git with; only a command that reaches a network remote is read
  if (!talksToNetwork(p.sub, p.rest, repo)) return pass();
  if (p.bad) return hold(`git ${p.bad} can run a program that skips the wrapper`);
  const envName = gitEnvProblem(typeof ctx.env === 'function' ? ctx.env() : {});
  if (envName) return hold(`git with ${envName} set can run a program that skips the wrapper`);
  // the low-level ways to update a remote are push too
  if (['send-pack', 'http-push'].includes(p.sub)) return hold(`git ${p.sub} updates a remote without git push`);
  if (p.sub !== 'push') return pass();
  return sealedPush(p, repo);
}

// a remote that is a folder on this computer: a path, a file:// URL, or a
// remote whose every push URL is one
function isLocalUrl(url) {
  const u = String(url || '');
  if (/^file:\/\//.test(u) || /^(\/|\.\.?(\/|$)|~)/.test(u)) return true;
  return !u.includes(':');
}

const PUSH_FLAGS_OK = new Set(['-u', '--set-upstream', '-q', '--quiet', '-v', '--verbose', '--progress', '--no-progress', '-f', '--force', '--force-if-includes', '--no-force-if-includes', '--no-verify', '--verify', '-n', '--dry-run', '--porcelain', '--atomic', '--no-atomic', '--thin', '--no-thin', '--no-follow-tags']);

// A push to a remote on disk runs as written: tests push tags and master to
// scratch repos. To a network remote it runs only as branch pushes that are
// not master, with followTags, the remote's mirror setting, and push options
// off, and each refspec written out in full, so the remote's own push lines
// cannot send it anywhere else. Tags, master, mirror, --all, --prune, a
// matching push (":"), and deleting master are held.
function sealedPush(p, repo) {
  const words = positionals(p.rest, PUSH_VALUE_FLAGS);
  const repoFlag = p.rest.find(a => /^--repo=/.test(a));
  const named = repoFlag ? repoFlag.slice('--repo='.length) : words[0];
  const remote = named || repo.config(`branch.${repo.currentBranch()}.pushRemote`) || repo.config('remote.pushDefault') || repo.config(`branch.${repo.currentBranch()}.remote`) || 'origin';
  const configured = repo.remoteUrls(remote, { push: true });
  if (configured.length ? configured.every(isLocalUrl) : isLocalUrl(remote)) return pass();
  if (isGitTrue(repo.configBool(`remote.${remote}.mirror`))) return hold(`${remote} is set up as a mirror, which pushes every branch and tag`);
  const kept = [];
  let deleting = false;
  for (const a of p.rest) {
    if (a === '-d' || a === '--delete') { deleting = true; continue; }
    if (PUSH_FLAGS_OK.has(a) || /^--force-with-lease(=|$)/.test(a)) { kept.push(a); continue; }
    if (a.startsWith('-')) return hold(`git push ${a} to a network remote can move master or tags; ${PUSH_HINT}`);
  }
  const specs = repoFlag ? words : words.slice(1);
  const current = repo.currentBranch();
  const out = [];
  if (!specs.length) {
    // no refspec: the branch's own push target, as one branch
    const dest = String(repo.pushDest() || '').replace(/^[^/]+\//, '');
    if (!dest || deleting) return hold(`git push with no branch named could push more than one; ${PUSH_HINT}`);
    specs.push(`HEAD:${dest}`);
  }
  for (const spec of specs) {
    const force = spec.startsWith('+') ? '+' : '';
    const body = spec.replace(/^\+/, '');
    if (body === ':' || body.includes('*')) return hold(`git push ${spec} pushes many branches at once; ${PUSH_HINT}`);
    let src;
    let dst;
    if (deleting) { src = ''; dst = body; } else if (body.includes(':')) {
      [src, dst] = [body.slice(0, body.indexOf(':')), body.slice(body.indexOf(':') + 1)];
    } else if (body === 'HEAD' || body === '@') { src = 'HEAD'; dst = current; } else {
      if (body.startsWith('refs/tags/') || (repo.isTag(body) && !repo.isBranch(body))) return hold(`git push ${spec} pushes a tag; ${PUSH_HINT}`);
      dst = body.replace(/^refs\/heads\//, '');
      src = `refs/heads/${dst}`;
    }
    const name = String(dst || '').replace(/^refs\/heads\/(?=.)/, '');
    if (String(dst || '').startsWith('refs/') && !String(dst).startsWith('refs/heads/')) return hold(`git push ${spec} does not go to a branch; ${PUSH_HINT}`);
    if (isMainRef(name)) return hold(`git push to master lands on master; ${PUSH_HINT}`);
    const why = targetProblem(name, repo);
    if (why) return hold(`git push ${spec}: ${why}; ${PUSH_HINT}`);
    out.push(`${force}${src}:refs/heads/${name}`);
  }
  const mirrorOff = /^[A-Za-z0-9._-]+$/.test(remote) ? ['-c', `remote.${remote}.mirror=false`] : [];
  return pass([...p.prefix, '-c', 'push.followTags=false', ...mirrorOff, '-c', 'push.pushOption=', 'push', '--no-follow-tags', ...kept, remote, ...out]);
}

// A ref a push writes must be a plain branch name that is not master and
// does not resolve to master: no @{-1}, @, HEAD~, ^, refs/.
function targetProblem(name, repo) {
  const n = String(name === undefined ? '' : name);
  if (n === 'HEAD' || n.startsWith('refs/') || !BRANCH_NAME.test(n)) return `${n || '(no name)'} is not a plain branch name`;
  if (isMainRef(n)) return `${n} is master`;
  const full = typeof repo.fullRefName === 'function' ? repo.fullRefName(n) : '';
  if (full && isMainRef(full)) return `${n} resolves to master`;
  return null;
}

// gh: reads, plus opening, reading, and commenting on a PR
const GH_SEALED = {
  pr: ['view', 'list', 'checks', 'diff', 'status', 'create', 'comment'],
  issue: ['view', 'list', 'status'],
  run: ['view', 'list', 'watch', 'download'],
  workflow: ['view', 'list'],
  repo: ['view', 'list'],
  release: ['view', 'list', 'download'],
  auth: ['status'],
  gist: ['view', 'list'],
  label: ['list'],
  search: ['repos', 'issues', 'prs', 'code', 'commits'],
};

function sealedGh(args) {
  const [group = '', verb = ''] = positionals(args, GH_VALUE_FLAGS);
  if (group === 'api') {
    const read = readGhApi(args.slice(args.indexOf('api')));
    return !read.refuse && !read.cats.length ? pass() : hold('gh api with any method but GET is held');
  }
  if (group === '' || group === 'help' || group === 'version' || group === 'status') return pass();
  if (GH_SEALED[group] && GH_SEALED[group].includes(verb)) return pass();
  return hold(`gh ${group} ${verb} is not on the list a handed-off job may run`.replace(/\s+$/, ''));
}

// npm, yarn, pnpm: install, ci, test, run, ls, view (and the spellings each tool takes)
const PKG_SEALED = {
  npm: ['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add', 'ci', 'clean-install', 'ic', 'install-clean', 'isntall-clean', 'test', 't', 'tst', 'run', 'run-script', 'rum', 'urn', 'ls', 'list', 'la', 'll', 'view', 'v', 'info', 'show'],
  yarn: ['install', 'add', 'test', 'run', 'list', 'info'],
  pnpm: ['install', 'i', 'add', 'test', 't', 'run', 'ls', 'list', 'll', 'view', 'info'],
};

function sealedPackage(name, args) {
  // the wrapper runs package scripts through its own shell; these would swap it out
  const shell = args.find(a => /^--(script-shell|shell-emulator)(=|$)/.test(String(a)));
  if (shell) return hold(`${name} ${shell} changes the shell package scripts run in`);
  const { unknownFlag, words } = packageWords(args);
  if (unknownFlag) return hold(`${name} option ${unknownFlag} could hide the command`);
  const sub = String(words[0] || '');
  // no command is held too: bare yarn installs, and a tool may read it as anything
  return PKG_SEALED[name].includes(sub) ? pass() : hold(`${name} ${sub || '(no command)'} is not on the list a handed-off job may run`);
}

// atris in a woken run: every verb runs except the outward and spend ones,
// read the same way a bet reads them (readAtris), plus these by name and
// accepting a task, which lands it.
const ATRIS_SEALED_HELD = new Set(['spend', 'publish', 'deploy', 'release', 'land', 'merge', 'accept', 'business', 'site', 'pay', 'feed']);
const TASK_ACCEPT = new Set(['accept', 'auto-accept-certified', 'auto-accept', 'accept-group']);

function sealedAtris(args) {
  const [cmd = '', sub = ''] = positionals(args, new Set(['--account', '--as', '--from', '--to', '--channel']));
  if (ATRIS_SEALED_HELD.has(cmd)) return hold(`atris ${cmd} goes out, lands, or spends`);
  if (cmd === 'task' && (TASK_ACCEPT.has(sub) || args.some(a => a === '--accept' || a === '--auto-accept'))) return hold('accepting a task lands it');
  const read = readAtris(args);
  if (read.cats.length) return hold(`atris ${cmd} would ${read.cats.map(c => CATEGORY_WORDS[c]).join(' and ')}`);
  if (read.refuse && ATRIS_REFUSED.has(cmd)) return hold(read.refuse);
  return pass();
}

function sealedVerdict(tool, args, ctx, missionId) {
  const name = path.basename(String(tool || ''));
  if (name === 'git') return sealedGit(args, ctx);
  if (name === 'gh') return sealedGh(args);
  if (name === 'npm' || name === 'yarn' || name === 'pnpm') return sealedPackage(name, args);
  if (name === 'atris') return sealedAtris(args);
  return hold(`${name} is not on the list a handed-off job may run`);
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

// Null: run it. { args }: run it with these words instead (a branch push in a
// woken run). { hold, message }: refuse with that message (the step is marked
// asked, which the phone shows as a yes card). { consume }: run it as written.
function check({ stateDir, missionId, seal, tool, args = [], gitBin = null, cwd = process.cwd(), env = process.env, ctx = null } = {}) {
  const sealed = normalizeSeal(seal);
  if (!missionId || !sealed.length) return null;
  const shown = `${path.basename(String(tool))} ${args.join(' ')}`.trim().slice(0, 120);
  const gitCtx = () => ctx || (path.basename(String(tool)) === 'git' ? gitContext(gitBin, cwd, env) : {});
  let read;
  if (isHandoffSeal(sealed)) {
    // a woken run: only the allowlist runs without a yes; the rest is one card
    const verdict = sealedVerdict(tool, args.map(String), gitCtx(), missionId);
    if (verdict.ok) return verdict.args ? { args: verdict.args } : null;
    read = refused(verdict.why);
  } else {
    read = analyze(tool, args, gitCtx());
  }
  const lockedCats = new Set(sealed.flatMap(s => s.categories));
  const needed = read.refuse ? [] : read.cats.filter(c => lockedCats.has(c));
  if (!read.refuse && !needed.length) return null;
  const { locks } = effectiveLocks(stateDir, missionId, sealed);
  const key = JSON.stringify({ tool: path.basename(String(tool)), args: args.map(String), cwd: path.resolve(cwd) });
  const hash = commandHash(key);
  // the steps that must say yes: one per kind the command touches; a command
  // the lock refuses outright asks the first step
  const owners = read.refuse ? [locks[0]] : [...new Set(needed.map(c => locks.find(l => l.categories.includes(c))))];
  const ready = owners.map(l => l.requests.find(r => r.hash === hash && r.approved_at && !r.used_at) || null);
  const now = new Date().toISOString();
  if (ready.every(Boolean)) {
    // the yes is used as the command starts: one yes, one attempt
    const claims = [];
    for (const [n, lock] of owners.entries()) {
      const file = claimFile(stateDir, missionId, lock, ready[n]);
      try {
        fs.closeSync(fs.openSync(file, 'wx'));
        claims.push(file);
      } catch {
        // another run took this yes first; give back the ones taken here
        for (const c of claims) { try { fs.unlinkSync(c); } catch { /* gone */ } }
        return { hold: true, steps: [lock.step], message: `held: "${shown}": the yes for step ${lock.step} is already being used by another run. one yes covers one run.` };
      }
    }
    for (const r of ready) r.used_at = now;
    saveLocks(stateDir, missionId, locks);
    return { consume: owners.map(l => l.step), claims };
  }
  // the owner said no to this exact command: it stays held, and no new card is asked
  if (owners.some(l => l.requests.some(r => r.hash === hash && r.denied_at && !r.approved_at))) {
    return { hold: true, steps: owners.map(l => l.step), message: `held: the owner said no to "${shown}". do not run it again; leave it undone and go on with the rest.` };
  }
  // held: a request on each step still missing a yes, one per exact command
  owners.forEach((lock, n) => {
    if (ready[n]) return;
    if (!lock.requests.some(r => r.hash === hash && !r.used_at)) lock.requests.push({ hash, key, command: shown, asked_at: now, approved_at: null, used_at: null });
  });
  saveLocks(stateDir, missionId, locks);
  const first = owners[ready.findIndex(r => !r)];
  const steps = [...new Set(owners.filter((l, n) => !ready[n]).map(l => l.step))];
  const after = 'a yes card is now on the owner\'s phone. wait for the ping that says yes, then run it again; one yes covers one run.';
  if (first.text === HANDOFF_SEAL_TEXT) return { hold: true, steps, message: `held: ${handoffAsk(shown)}. ${read.refuse ? `${read.refuse}. ` : ''}${after}` };
  if (read.refuse) return { hold: true, steps, message: `held: "${shown}": ${read.refuse}. ${after}` };
  return {
    hold: true,
    steps,
    message: `held: "${shown}" would ${needed.map(c => CATEGORY_WORDS[c]).join(' and ')}, and step ${first.step} ("${first.text}") needs the owner's yes first. ${after}`,
  };
}

// After a run a yes allowed. The yes was used when the run started, so a
// failed run does not get another go; this is kept for the wrappers that
// still call it.
function consume() {}

module.exports = {
  describeCommand,
  plainWhat,
  HELD_EXIT,
  handoffParent,
  handoffSeal,
  handoffYesCards,
  analyze,
  gitContext,
  approveYesLock,
  askedYesLocks,
  denyYesLock,
  check,
  consume,
  effectiveLocks,
  sealFor,
  stepLocks,
  writeYesLocks,
};
