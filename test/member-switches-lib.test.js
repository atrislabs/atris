'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  isLocalMember,
  getMemberSwitch,
  isMemberAwake,
  asleepMembers,
  setMemberAwake,
  setMemberLoopAwake,
  readLoopFlag,
  memberArgFromArgv,
} = require('../lib/member-switches');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-switches-lib-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeMember(root, name) {
  const dir = path.join(root, 'atris', 'team', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMBER.md'), `# ${name}\n`, 'utf8');
}

function switchesFile(root) {
  return path.join(root, '.atris', 'state', 'member-switches.json');
}

test('isLocalMember is true only for a real slug with a MEMBER.md', () => {
  const root = makeTempDir();
  try {
    writeMember(root, 'maze');
    assert.equal(isLocalMember('maze', root), true);
    assert.equal(isLocalMember('ghost', root), false);
    assert.equal(isLocalMember('', root), false);
    assert.equal(isLocalMember('--loop', root), false);
    assert.equal(isLocalMember('../escape', root), false);
    assert.equal(isLocalMember('has space', root), false);
  } finally {
    cleanupTempDir(root);
  }
});

test('unknown member defaults awake; setMemberAwake persists and round-trips', () => {
  const root = makeTempDir();
  try {
    assert.equal(isMemberAwake('maze', root), true);
    assert.deepEqual(getMemberSwitch('maze', root), { awake: true, loops: {} });

    const entry = setMemberAwake('maze', false, root);
    assert.deepEqual(entry, { awake: false, loops: {} });
    assert.equal(isMemberAwake('maze', root), false);

    const onDisk = JSON.parse(fs.readFileSync(switchesFile(root), 'utf8'));
    assert.equal(onDisk.members.maze.awake, false);

    setMemberAwake('maze', true, root);
    assert.equal(isMemberAwake('maze', root), true);
  } finally {
    cleanupTempDir(root);
  }
});

test('setMemberLoopAwake flips one loop without sleeping the member', () => {
  const root = makeTempDir();
  try {
    const entry = setMemberLoopAwake('maze', 'feedback', false, root);
    assert.equal(entry.loops.feedback, false);
    assert.equal(entry.awake, true);

    const onDisk = JSON.parse(fs.readFileSync(switchesFile(root), 'utf8'));
    assert.equal(onDisk.members.maze.loops.feedback, false);
    assert.equal(onDisk.members.maze.awake, true);
    assert.equal(isMemberAwake('maze', root), true);

    setMemberLoopAwake('maze', 'feedback', true, root);
    assert.equal(getMemberSwitch('maze', root).loops.feedback, true);
  } finally {
    cleanupTempDir(root);
  }
});

test('setMemberLoopAwake rejects an empty loop id', () => {
  const root = makeTempDir();
  try {
    assert.throws(() => setMemberLoopAwake('maze', '', root), /loop id required/);
    assert.throws(() => setMemberLoopAwake('maze', '   ', root), /loop id required/);
    assert.equal(fs.existsSync(switchesFile(root)), false);
  } finally {
    cleanupTempDir(root);
  }
});

test('asleepMembers lists only fully-slept members, sorted', () => {
  const root = makeTempDir();
  try {
    assert.deepEqual(asleepMembers(root), []);

    setMemberLoopAwake('beta', 'feedback', false, root);
    assert.deepEqual(asleepMembers(root), []);

    setMemberAwake('zeta', false, root);
    setMemberAwake('alpha', false, root);
    assert.deepEqual(asleepMembers(root), ['alpha', 'zeta']);

    setMemberAwake('alpha', true, root);
    assert.deepEqual(asleepMembers(root), ['zeta']);
  } finally {
    cleanupTempDir(root);
  }
});

test('corrupt or missing state file falls back to awake defaults', () => {
  const root = makeTempDir();
  try {
    fs.mkdirSync(path.dirname(switchesFile(root)), { recursive: true });
    fs.writeFileSync(switchesFile(root), 'not json{', 'utf8');
    assert.equal(isMemberAwake('maze', root), true);
    assert.deepEqual(asleepMembers(root), []);

    fs.writeFileSync(switchesFile(root), JSON.stringify({ members: 'nope' }), 'utf8');
    assert.deepEqual(getMemberSwitch('maze', root), { awake: true, loops: {} });
  } finally {
    cleanupTempDir(root);
  }
});

test('readLoopFlag parses --loop both split and joined, empty when missing', () => {
    assert.equal(readLoopFlag(['node', 'atris', 'sleep', 'maze', '--loop', 'feedback']), 'feedback');
    assert.equal(readLoopFlag(['node', 'atris', 'sleep', 'maze', '--loop=feedback']), 'feedback');
    assert.equal(readLoopFlag(['node', 'atris', 'sleep', 'maze']), '');
    assert.equal(readLoopFlag(['node', 'atris', 'sleep', 'maze', '--loop']), '');
    assert.equal(readLoopFlag(['node', 'atris', 'sleep', 'maze', '--loop', '--json']), '');
});

test('memberArgFromArgv returns argv[3] unless it is a flag', () => {
    assert.equal(memberArgFromArgv(['node', 'atris', 'sleep', 'maze']), 'maze');
    assert.equal(memberArgFromArgv(['node', 'atris', 'sleep', 'maze', '--loop', 'x']), 'maze');
    assert.equal(memberArgFromArgv(['node', 'atris', 'sleep', '--loop']), null);
    assert.equal(memberArgFromArgv(['node', 'atris', 'sleep']), null);
});
