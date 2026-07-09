'use strict';

const fs = require('fs');
const path = require('path');

const SWITCHES_REL = path.join('.atris', 'state', 'member-switches.json');

function switchesPath(root = process.cwd()) {
  return path.join(root, SWITCHES_REL);
}

function emptyState() {
  return { members: {} };
}

function loadMemberSwitches(root = process.cwd()) {
  const file = switchesPath(root);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return emptyState();
    if (!raw.members || typeof raw.members !== 'object') return emptyState();
    return { members: raw.members };
  } catch {
    return emptyState();
  }
}

function writeAtomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function saveMemberSwitches(state, root = process.cwd()) {
  const next = state && typeof state === 'object' ? state : emptyState();
  if (!next.members || typeof next.members !== 'object') next.members = {};
  writeAtomicJson(switchesPath(root), next);
  return next;
}

function isLocalMember(name, root = process.cwd()) {
  const slug = String(name || '').trim();
  if (!slug || slug.startsWith('-')) return false;
  if (!/^[a-zA-Z0-9._-]+$/.test(slug)) return false;
  return fs.existsSync(path.join(root, 'atris', 'team', slug, 'MEMBER.md'));
}

function normalizeMemberEntry(entry) {
  const base = entry && typeof entry === 'object' ? entry : {};
  const loops = base.loops && typeof base.loops === 'object' ? { ...base.loops } : {};
  return {
    awake: base.awake !== false,
    loops,
  };
}

function getMemberSwitch(name, root = process.cwd()) {
  const state = loadMemberSwitches(root);
  return normalizeMemberEntry(state.members[name]);
}

function isMemberAwake(name, root = process.cwd()) {
  return getMemberSwitch(name, root).awake !== false;
}

function isMemberLoopAwake(name, loopId, root = process.cwd()) {
  const entry = getMemberSwitch(name, root);
  if (entry.awake === false) return false;
  const id = String(loopId || '').trim();
  if (!id) return entry.awake !== false;
  if (Object.prototype.hasOwnProperty.call(entry.loops, id)) {
    return entry.loops[id] !== false;
  }
  return true;
}

function ensureMemberEntry(state, name) {
  if (!state.members[name] || typeof state.members[name] !== 'object') {
    state.members[name] = { awake: true, loops: {} };
  }
  if (!state.members[name].loops || typeof state.members[name].loops !== 'object') {
    state.members[name].loops = {};
  }
  if (typeof state.members[name].awake !== 'boolean') {
    state.members[name].awake = state.members[name].awake !== false;
  }
  return state.members[name];
}

function setMemberAwake(name, awake, root = process.cwd()) {
  const state = loadMemberSwitches(root);
  const entry = ensureMemberEntry(state, name);
  entry.awake = awake !== false;
  saveMemberSwitches(state, root);
  return normalizeMemberEntry(entry);
}

function setMemberLoopAwake(name, loopId, awake, root = process.cwd()) {
  const id = String(loopId || '').trim();
  if (!id) throw new Error('loop id required');
  const state = loadMemberSwitches(root);
  const entry = ensureMemberEntry(state, name);
  entry.loops[id] = awake !== false;
  saveMemberSwitches(state, root);
  return normalizeMemberEntry(entry);
}

function readLoopFlag(argv = process.argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--loop') {
      const value = argv[i + 1];
      if (value && !String(value).startsWith('-')) return String(value).trim();
      return '';
    }
    if (String(arg).startsWith('--loop=')) {
      return String(arg).slice('--loop='.length).trim();
    }
  }
  return '';
}

function memberArgFromArgv(argv = process.argv) {
  // atris sleep|wake <name> [--loop <id>]
  const raw = argv[3];
  if (!raw || String(raw).startsWith('-')) return null;
  return String(raw).trim();
}

module.exports = {
  SWITCHES_REL,
  switchesPath,
  loadMemberSwitches,
  saveMemberSwitches,
  isLocalMember,
  getMemberSwitch,
  isMemberAwake,
  isMemberLoopAwake,
  setMemberAwake,
  setMemberLoopAwake,
  readLoopFlag,
  memberArgFromArgv,
};
