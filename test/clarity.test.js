'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const clarity = require('../lib/clarity');
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

test('buildProfile keeps only known keys and trims', () => {
  const p = clarity.buildProfile({ voice: '  plain  ', bogus: 'x', focus: 'atris' }, '2026-06-25');
  assert.equal(p.voice, 'plain');
  assert.equal(p.focus, 'atris');
  assert.equal('bogus' in p, false);
  assert.equal(p.updated_at, '2026-06-25');
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

test('atris activate surfaces the clarity profile so agents read it', () => {
  const root = tmp();
  try {
    runCli(['init'], root);
    runCli(['clarity', '--set', 'voice=plain, terse'], root);
    const res = runCli(['activate'], root);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /How you work \(atris clarity\)/);
    assert.match(res.stdout, /voice: plain, terse/);
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
