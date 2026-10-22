'use strict';

// The your-yes lock. A job started from the orb gets a lock file listing each
// step the owner must say yes to, and what kind of action that step is
// (publish, tag, post, send, merge, deploy). The mission guard puts small
// wrappers for git, npm, yarn, pnpm, gh, and atris first on the job's PATH;
// each wrapper asks holdIfLocked before running the real tool. A held command
// marks its step as asked (the phone shows a yes card) and exits 77 with a
// plain message. The owner's yes approves that one step and nothing else.
//
// What this cannot stop: anything that skips those commands, such as a curl
// to an API, a script that calls a registry directly, or a tool called by its
// full path. It covers the named commands only.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HELD_EXIT = 77;
const CATEGORY_WORDS = {
  publish: 'publish or release a package',
  tag: 'push a version tag',
  post: 'post in public',
  send: 'send a message',
  merge: 'merge to master',
  deploy: 'deploy',
};

// What a your-yes step locks, read from its words. A step whose words name
// none of these locks nothing here (for example "approve the prize"), because
// no command can be told apart for it.
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

function yesLockFile(root, missionId) {
  return path.join(root, '.atris', 'state', 'yes-locks', `${String(missionId).replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

function readYesLocks(root, missionId) {
  if (!root || !missionId) return null;
  try {
    return JSON.parse(fs.readFileSync(yesLockFile(root, missionId), 'utf8'));
  } catch {
    return null;
  }
}

function writeLocks(root, missionId, data) {
  const file = yesLockFile(root, missionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// One lock per your-yes step that names an action we can hold. Step numbers
// are the bet's own (1-based).
function writeYesLocks(root, missionId, { betId = null, steps = [] } = {}) {
  const locks = steps.map((s, i) => (s && s.who === 'you' ? { step: i + 1, text: String(s.text || ''), categories: stepLocks(s.text), asked_at: null, approved_at: null } : null))
    .filter(l => l && l.categories.length);
  writeLocks(root, missionId, { mission_id: missionId, bet_id: betId, locks });
  return locks;
}

function updateLock(root, missionId, step, patch) {
  const data = readYesLocks(root, missionId);
  if (!data) return null;
  const lock = data.locks.find(l => l.step === step);
  if (!lock) return null;
  Object.assign(lock, patch);
  writeLocks(root, missionId, data);
  return lock;
}

function approveYesLock(root, missionId, step, at = new Date().toISOString()) {
  return updateLock(root, missionId, step, { approved_at: at });
}

// Steps a job tried and is waiting on: each is a yes card.
function askedYesLocks(root, missionId) {
  const data = readYesLocks(root, missionId);
  return data ? data.locks.filter(l => l.asked_at && !l.approved_at) : [];
}

function firstWord(args, takesValue = new Set()) {
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i] || '');
    if (takesValue.has(a)) { i += 1; continue; }
    if (a.startsWith('-')) continue;
    return { word: a, rest: args.slice(i + 1) };
  }
  return { word: '', rest: [] };
}

const MAIN_BRANCHES = new Set(['master', 'main']);
const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env']);

// The kind of action a command is, or null. ctx answers git questions
// (isTag(name), currentBranch()) so tests and the wrapper share one reading.
function commandCategory(tool, args = [], ctx = {}) {
  const name = path.basename(String(tool || ''));
  if (name === 'npm' || name === 'yarn' || name === 'pnpm') {
    const { word, rest } = firstWord(args);
    if (word === 'publish' || word === 'unpublish' || word === 'deprecate') return 'publish';
    if (word === 'dist-tag' && /^(add|rm)$/.test(String(rest[0] || ''))) return 'publish';
    return null;
  }
  if (name === 'gh') {
    const { word, rest } = firstWord(args);
    const sub = String(rest[0] || '');
    if (word === 'release' && /^(create|upload|edit|delete)$/.test(sub)) return 'publish';
    if (word === 'pr' && sub === 'merge') return 'merge';
    return null;
  }
  if (name === 'git') {
    const { word, rest } = firstWord(args, GIT_VALUE_FLAGS);
    const branch = () => (typeof ctx.currentBranch === 'function' ? ctx.currentBranch() : '');
    if (word === 'push') {
      const plain = rest.filter(a => !String(a).startsWith('-'));
      if (rest.some(a => a === '--tags' || a === '--follow-tags') || plain.some(a => /refs\/tags\//.test(a))) return 'tag';
      const refspecs = plain.slice(1);
      if (refspecs.some(r => typeof ctx.isTag === 'function' && ctx.isTag(String(r).replace(/^\+/, '').split(':')[0]))) return 'tag';
      const target = r => String(r).replace(/^\+/, '').split(':').pop().replace(/^refs\/heads\//, '');
      if (refspecs.some(r => MAIN_BRANCHES.has(target(r)))) return 'merge';
      if (!refspecs.length && MAIN_BRANCHES.has(branch())) return 'merge';
      return null;
    }
    if ((word === 'merge' || word === 'cherry-pick' || word === 'rebase') && MAIN_BRANCHES.has(branch())) return 'merge';
    return null;
  }
  if (name === 'atris') {
    const { word, rest } = firstWord(args);
    const sub = String(rest[0] || '');
    if ((word === 'gmail' || word === 'mail' || word === 'email') && /^(send|reply|forward)$/.test(sub)) return 'send';
    if (word === 'slack' && /^(send|dm|post)$/.test(sub)) return 'send';
    if (word === 'imessage' && sub === 'send') return 'send';
    if (word === 'twitter' && sub === 'post') return 'post';
    return null;
  }
  return null;
}

function gitContext(gitBin, cwd) {
  const run = a => spawnSync(gitBin || 'git', a, { cwd, encoding: 'utf8', timeout: 5000 });
  return {
    isTag: name => Boolean(name) && run(['rev-parse', '-q', '--verify', `refs/tags/${name}`]).status === 0,
    currentBranch: () => String(run(['rev-parse', '--abbrev-ref', 'HEAD']).stdout || '').trim(),
  };
}

// The check every wrapper makes. Null to run the real tool; otherwise the
// message to print, after the step is marked as asked.
// The lock lives in the workspace the bet was started from. A tick that runs
// in a separate worktree finds it through the main checkout.
function lockRoot(root, missionId, gitBin) {
  if (readYesLocks(root, missionId)) return root;
  const common = spawnSync(gitBin || 'git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8', timeout: 5000 });
  const main = common.status === 0 ? path.dirname(String(common.stdout || '').trim()) : null;
  return main && main !== root && readYesLocks(main, missionId) ? main : root;
}

function holdIfLocked({ root: startRoot, missionId, tool, args = [], gitBin = null, cwd = process.cwd(), ctx = null } = {}) {
  if (!startRoot || !missionId) return null;
  const root = lockRoot(startRoot, missionId, gitBin);
  const data = readYesLocks(root, missionId);
  if (!data || !Array.isArray(data.locks) || !data.locks.length) return null;
  const category = commandCategory(tool, args, ctx || (path.basename(String(tool)) === 'git' ? gitContext(gitBin, cwd) : {}));
  if (!category) return null;
  const lock = data.locks.find(l => !l.approved_at && l.categories.includes(category));
  if (!lock) return null;
  const shown = `${path.basename(String(tool))} ${args.join(' ')}`.trim().slice(0, 120);
  updateLock(root, missionId, lock.step, { asked_at: lock.asked_at || new Date().toISOString(), held_command: shown });
  return {
    category,
    step: lock.step,
    message: `held: "${shown}" would ${CATEGORY_WORDS[category]}, and step ${lock.step} ("${lock.text}") needs the owner's yes first. a yes card is now on the owner's phone. wait for the ping that says yes, then run it again.`,
  };
}

module.exports = {
  HELD_EXIT,
  approveYesLock,
  askedYesLocks,
  commandCategory,
  holdIfLocked,
  readYesLocks,
  stepLocks,
  writeYesLocks,
};
