'use strict';

// `atris member roster` used to fall through to the job launcher: "roster" is
// not a member, so it was read as a job and started a paid member run. These
// spawn the real CLI in a temp workspace. Every call passes --dry-run so a
// regression shows up as a failed assertion, never as a real paid run.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'atris.js');

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'member-roster-'));
  for (const name of ['navigator', 'executor']) {
    const dir = path.join(root, 'atris', 'team', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'MEMBER.md'), `---\nname: ${name}\nrole: ${name} role\n---\n# ${name}\n`, 'utf8');
  }
  return root;
}

function runMember(root, args) {
  return spawnSync(process.execPath, [CLI, 'member', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, HOME: root, ATRIS_SKIP_UPDATE_CHECK: '1' },
    timeout: 60000,
  });
}

test('atris member roster shows the team', () => {
  const root = makeWorkspace();
  try {
    const result = runMember(root, ['roster', '--json', '--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.count, 2);
    assert.deepEqual(payload.members.map((m) => m.name).sort(), ['executor', 'navigator']);

    const text = runMember(root, ['roster', '--dry-run']);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /^MEMBER\s+STATUS\s+ENGINE\s+WHAT IT DOES$/m);
    assert.match(text.stdout, /navigator/);
    assert.match(text.stdout, /executor/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a single unknown word starts nothing and points at the nearest name', () => {
  const root = makeWorkspace();
  try {
    const result = runMember(root, ['navigatr', '--dry-run']);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /No member or command named "navigatr", so nothing started/);
    assert.match(result.stdout, /Did you mean: atris member navigator/);
    assert.match(result.stdout, /Your team: .*navigator/);
    assert.doesNotMatch(result.stdout, /dispatch|steer|picked/i);
    // Nothing was queued or logged for any member.
    assert.equal(fs.existsSync(path.join(root, '.atris', 'state', 'missions')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a single unknown word with no near match still starts nothing', () => {
  const root = makeWorkspace();
  try {
    const result = runMember(root, ['zzqx', '--dry-run']);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /nothing started/);
    assert.doesNotMatch(result.stdout, /Did you mean/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a multi-word job still reaches the launcher', () => {
  const root = makeWorkspace();
  try {
    const result = runMember(root, ['fix', 'the', 'flaky', 'login', 'test', '--dry-run', '--json']);
    assert.doesNotMatch(result.stdout, /nothing started/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
