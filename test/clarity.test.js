'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const clarity = require('../lib/clarity');
const { parseSets } = require('../commands/clarity');
const { scrubAgentEnv } = require('./helpers/agent-env');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-clarity-'));
}
function runCli(args, cwd) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...scrubAgentEnv(), ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
}

test('mergeProfile keeps only known keys and trims (fresh profile)', () => {
  const p = clarity.mergeProfile({}, { voice: '  plain  ', bogus: 'x', focus: 'atris' }, '2026-06-25');
  assert.equal(p.voice, 'plain');
  assert.equal(p.focus, 'atris');
  assert.equal('bogus' in p, false);
  assert.equal(p.updated_at, '2026-06-25');
});

test('parseSets pins the key=value boundary contract', () => {
  assert.deepEqual(parseSets(['--set', 'focus']), {}, 'no = is dropped');
  assert.deepEqual(parseSets(['--set', '=plain']), {}, 'empty key is dropped');
  assert.deepEqual(parseSets(['--set', 'voice=a = b']), { voice: 'a = b' }, 'value keeps embedded =');
  assert.deepEqual(parseSets(['--set', 'bogus=z']), {}, 'unknown key filtered by KEYS');
});

test('`atris clarity --set voice=` (empty value) reports nothing saved and writes no field', () => {
  const root = tmp();
  try {
    const res = runCli(['clarity', '--set', 'voice='], root);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /nothing to set/);
    const p = path.join(root, '.atris', 'clarity.json');
    if (fs.existsSync(p)) assert.equal('voice' in JSON.parse(fs.readFileSync(p, 'utf8')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('mergeProfile is incremental and does not wipe prior fields', () => {
  const first = clarity.mergeProfile({}, { voice: 'plain' }, 's1');
  const second = clarity.mergeProfile(first, { cadence: 'overnight autonomous' }, 's2');
  assert.equal(second.voice, 'plain');
  assert.equal(second.cadence, 'overnight autonomous');
  assert.equal(second.updated_at, 's2');
});

test('renderClarityMd shows set fields, flags empty, and uses no em dash', () => {
  const md = clarity.renderClarityMd({ voice: 'terse', updated_at: 's' });
  assert.match(md, /- Voice: terse/);
  assert.equal(md.includes('—'), false);
  const empty = clarity.renderClarityMd({});
  assert.match(empty, /not set yet/);
});

test('`atris clarity --set` writes both the json and the readable CLARITY.md', () => {
  const root = tmp();
  try {
    const res = runCli(['clarity', '--set', 'voice=plain', '--set', 'cadence=overnight autonomous'], root);
    assert.equal(res.status, 0, res.stderr);
    const json = JSON.parse(fs.readFileSync(path.join(root, '.atris', 'clarity.json'), 'utf8'));
    assert.equal(json.voice, 'plain');
    assert.equal(json.cadence, 'overnight autonomous');
    const md = fs.readFileSync(path.join(root, 'atris', 'CLARITY.md'), 'utf8');
    assert.match(md, /Clarity profile/);
    assert.match(md, /- Voice: plain/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('`atris clarity --json` and `show` read back the saved profile', () => {
  const root = tmp();
  try {
    runCli(['clarity', '--set', 'focus=ship atris'], root);
    const j = runCli(['clarity', '--json'], root);
    assert.equal(JSON.parse(j.stdout).focus, 'ship atris');
    const s = runCli(['clarity', 'show'], root);
    assert.match(s.stdout, /- Focus: ship atris/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('`atris clarity` is non-interactive-safe (no hang, prints profile + guidance)', () => {
  const root = tmp();
  try {
    const res = runCli(['clarity'], root);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Clarity profile/);
    assert.match(res.stdout, /terminal to fill this in/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('atris activate surfaces a one-line clarity profile from clarity.json', () => {
  const root = tmp();
  try {
    runCli(['init'], root);
    fs.mkdirSync(path.join(root, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(root, '.atris', 'clarity.json'), JSON.stringify({
      focus: 'ship atris',
      voice: 'plain',
      leash: 'proceed and report',
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(root, 'atris', 'CLARITY.md'), clarity.renderClarityMd({
      focus: 'ship atris',
      voice: 'plain',
      leash: 'proceed and report',
    }), 'utf8');
    const res = runCli(['activate'], root);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /clarity: focus ship atris, voice plain, leash proceed and report \(see atris\/CLARITY\.md\)/);
    assert.doesNotMatch(res.stdout, /How you work \(atris clarity\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('atris activate keeps the existing clarity nudge when no profile exists', () => {
  const root = tmp();
  try {
    runCli(['init'], root);
    const res = runCli(['activate'], root);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Tip: run atris clarity once so agents learn how you work\./);
    assert.doesNotMatch(res.stdout, /clarity:/);
    assert.doesNotMatch(res.stdout, /atris\/CLARITY\.md/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('atris activate skips corrupt clarity json without crashing', () => {
  const root = tmp();
  try {
    runCli(['init'], root);
    fs.mkdirSync(path.join(root, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(root, '.atris', 'clarity.json'), '{ not valid json', 'utf8');
    fs.writeFileSync(path.join(root, 'atris', 'CLARITY.md'), clarity.renderClarityMd({ voice: 'plain' }), 'utf8');
    const res = runCli(['activate'], root);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Tip: run atris clarity once so agents learn how you work\./);
    assert.doesNotMatch(res.stdout, /clarity:/);
    assert.doesNotMatch(res.stdout, /voice plain/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('`atris clarity --reset` clears the profile fields', () => {
  const root = tmp();
  try {
    runCli(['clarity', '--set', 'voice=plain'], root);
    runCli(['clarity', '--reset'], root);
    const json = JSON.parse(fs.readFileSync(path.join(root, '.atris', 'clarity.json'), 'utf8'));
    assert.equal('voice' in json, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
