'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { ideaAtris } = require('../commands/idea');
const { addIdea } = require('../lib/idea-inbox');
const { planKeep } = require('../lib/campaign-keep');

function tempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function tempRepo() {
  const dir = tempDir('atris-idea-timer-');
  spawnSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

// A fake crontab: `crontab -l` prints what was last written with `crontab -`.
function fakeCron(initial = '') {
  const state = { crontab: initial, calls: [] };
  state.spawn = (cmd, args, options = {}) => {
    state.calls.push([cmd, ...args]);
    if (cmd === 'crontab' && args[0] === '-l') return { status: 0, stdout: state.crontab, stderr: '' };
    if (cmd === 'crontab' && args[0] === '-') {
      state.crontab = options.input;
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return state;
}

function run(args, cwd, keepDeps) {
  const lines = [];
  const code = ideaAtris(args, { cwd, log: (line) => lines.push(line), keepDeps });
  return { code, out: lines.join('\n') };
}

test('atris idea on puts one ten-minute tick for this repo in cron, and off takes it out', () => {
  const repo = tempRepo();
  const cron = fakeCron('0 9 * * * echo keep-me\n');
  const keepDeps = { spawn: cron.spawn, plan: { platform: 'linux', homeDir: tempDir('atris-home-') } };

  const on = run(['on'], repo, keepDeps);
  assert.equal(on.code, 0, on.out);
  assert.match(on.out, /every 10 minutes the oldest idea/);
  const lines = cron.crontab.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], '0 9 * * * echo keep-me');
  assert.match(lines[1], /^\*\/10 \* \* \* \* cd '/);
  assert.match(lines[1], /'idea' 'tick'/);
  assert.match(lines[1], /# ATRIS_IDEA_TICK_[0-9a-f]{8}$/);

  run(['on'], repo, keepDeps);
  assert.equal(cron.crontab.trim().split('\n').length, 2, 'turning it on twice keeps one line');

  const off = run(['off'], repo, keepDeps);
  assert.equal(off.code, 0);
  assert.equal(cron.crontab.trim(), '0 9 * * * echo keep-me');
});

test('on macOS the tick is a launchd agent that runs every 600 seconds', () => {
  const repo = tempRepo();
  const home = tempDir('atris-home-');
  const cron = fakeCron();
  const keepDeps = { spawn: cron.spawn, plan: { platform: 'darwin', homeDir: home } };
  const on = run(['on'], repo, keepDeps);
  assert.equal(on.code, 0, on.out);
  const agents = path.join(home, 'Library', 'LaunchAgents');
  const files = fs.readdirSync(agents);
  assert.equal(files.length, 1);
  assert.match(files[0], /^ai\.atris\.idea-tick\.[0-9a-f]{8}\.plist$/);
  const plist = fs.readFileSync(path.join(agents, files[0]), 'utf8');
  assert.match(plist, /<key>StartInterval<\/key><integer>600<\/integer>/);
  assert.match(plist, /<string>idea<\/string><string>tick<\/string>/);
  assert.ok(cron.calls.some((call) => call[0] === 'launchctl' && call[1] === 'bootstrap'));
  run(['off'], repo, keepDeps);
  assert.deepEqual(fs.readdirSync(agents), []);
});

test('the idea list says whether anything will build the waiting ideas', () => {
  const repo = tempRepo();
  addIdea(repo, 'make the inbox search faster');
  const cron = fakeCron();
  const keepDeps = { spawn: cron.spawn, plan: { platform: 'linux', homeDir: tempDir('atris-home-') } };
  assert.match(run([], repo, keepDeps).out, /nothing builds them yet\. start it: atris idea on/);
  run(['on'], repo, keepDeps);
  assert.match(run([], repo, keepDeps).out, /the next one starts within 10 minutes/);
});

test('--dry-run shows the timer without touching cron', () => {
  const repo = tempRepo();
  const cron = fakeCron();
  const keepDeps = { spawn: cron.spawn, plan: { platform: 'linux', homeDir: tempDir('atris-home-') } };
  const dry = run(['on', '--dry-run'], repo, keepDeps);
  assert.equal(dry.code, 0);
  assert.match(dry.out, /would start a cron timer/);
  assert.equal(cron.calls.length, 0);
});

test('campaign keep still plans its one-minute wake', () => {
  const plan = planKeep({ root: '/r', home: '/h', platform: 'linux', atrisBin: '/b/atris.js' });
  assert.match(plan.crontab_line, /^\* \* \* \* \* cd/);
  assert.match(plan.crontab_line, /'campaign' 'wake' '--json'/);
  assert.match(plan.crontab_line, /# ATRIS_CAMPAIGN_WAKE_/);
  assert.equal(plan.log_path, path.join('/h', 'campaign-wake.log'));
  const mac = planKeep({ root: '/r', home: '/h', platform: 'darwin', homeDir: '/u', atrisBin: '/b/atris.js' });
  assert.match(mac.label, /^ai\.atris\.campaign-wake\./);
  assert.match(mac.contents, /<integer>60<\/integer>/);
});
