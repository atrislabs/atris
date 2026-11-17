'use strict';

// launchd starts the hourly landing job with PATH=/usr/bin:/bin. gh lives in
// /opt/homebrew/bin, so from 2026-11-15 the backend's merged-work sweep said
// "gh is not installed" every half hour while gh worked in every shell, and
// the tick still printed a calm "0 landed".
//
// Fixtures only: a temp HOME and a fake launchctl for the job file, temp git
// repos and a fake PATH for the tick. The real LaunchAgents folder, launchctl
// and GitHub are never touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const toolPath = require('../lib/tool-path');
const autoland = require('../lib/autoland');

const CLI = path.join(__dirname, '..', 'bin', 'atris.js');
const LABEL = 'ai.atris.autoland.tool-project';

function tempDir(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A short PATH like the one launchd gives, minus gh: Linux runners keep gh
// in /usr/bin, so a bare /usr/bin:/bin would still find it there.
function shortPathWithoutGh(t) {
  const dir = tempDir(t, 'atris-short-path-');
  for (const from of ['/usr/bin', '/bin']) {
    let names = [];
    try { names = fs.readdirSync(from); } catch { continue; }
    for (const name of names) {
      if (name === 'gh' || fs.existsSync(path.join(dir, name))) continue;
      try { fs.symlinkSync(path.join(from, name), path.join(dir, name)); } catch {}
    }
  }
  return dir;
}

function fakeTool(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(file, 0o755);
  return file;
}

test('a tool off PATH is found in the named tool folders, and a missing one says where it looked', (t) => {
  const base = tempDir(t, 'atris-tool-path-');
  const tools = path.join(base, 'tools');
  const gh = fakeTool(tools, 'gh');
  const bare = path.join(base, 'bare');
  fs.mkdirSync(bare);
  const short = { PATH: bare, ATRIS_TOOL_PACKAGE_DIRS: '' };
  assert.equal(toolPath.findTool('gh', short), '', 'no gh on a short PATH with no package folders');
  assert.deepEqual(toolPath.missingTools(['gh'], short), ['gh']);
  const line = toolPath.missingToolLine(['gh'], short);
  assert.ok(line.startsWith(`autoland tick: gh not found (looked in ${bare}, `), line);
  assert.match(line, /could not check or land/);

  assert.equal(toolPath.findTool('gh', { ...short, ATRIS_TOOL_PACKAGE_DIRS: tools }), gh);
  assert.equal(toolPath.findTool('gh', { ...short, ATRIS_TOOL_DIRS: tools }), gh);
  assert.deepEqual(toolPath.missingTools(['gh'], { ...short, ATRIS_TOOL_DIRS: tools }), []);
});

test('the tool PATH keeps the caller first and adds only folders that exist', (t) => {
  const base = tempDir(t, 'atris-tool-path-');
  const tools = path.join(base, 'tools');
  fakeTool(tools, 'gh');
  const env = { PATH: '/usr/bin:/bin', ATRIS_TOOL_DIRS: `${tools}:${path.join(base, 'gone')}`, ATRIS_TOOL_PACKAGE_DIRS: '' };
  const added = toolPath.ensureToolPath(env);
  assert.ok(added.includes(tools));
  assert.ok(!added.includes(path.join(base, 'gone')));
  assert.ok(env.PATH.startsWith('/usr/bin:/bin:'), env.PATH);
  assert.deepEqual(toolPath.ensureToolPath(env), [], 'a second call adds nothing');
});

test('a short schedule PATH is repaired with the package folders first and keeps its own folders', () => {
  assert.equal(toolPath.schedulePathLacksTools('/usr/bin:/bin'), true);
  assert.equal(toolPath.schedulePathLacksTools(toolPath.SCHEDULE_PATH), false);
  assert.equal(toolPath.repairedSchedulePath('/usr/bin:/bin'), toolPath.SCHEDULE_PATH);
  assert.equal(toolPath.repairedSchedulePath('/usr/bin:/bin:/opt/mine'), `${toolPath.SCHEDULE_PATH}:/opt/mine`);
});

// --- the job file on a Mac ---

function scheduleFixture(t) {
  const base = tempDir(t, 'atris-tool-schedule-');
  const home = path.join(base, 'home');
  const root = path.join(base, 'tool-project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  const saved = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved; });
  return { home, root, file: path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`) };
}

function fakeLaunchctl({ loaded = [], running = [] } = {}) {
  const calls = [];
  const state = { loaded: new Set(loaded), running: new Set(running) };
  const spawn = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'crontab' && args[0] === '-l') return { status: 1, stdout: '', stderr: 'crontab: no crontab for someone' };
    if (cmd === 'launchctl' && args[0] === 'print') {
      const label = args[1].split('/').pop();
      if (!state.loaded.has(label)) return { status: 113, stdout: '', stderr: 'Could not find service' };
      return { status: 0, stdout: `gui/501/${label} = {\n\tstate = ${state.running.has(label) ? 'running' : 'not running'}\n}`, stderr: '' };
    }
    if (cmd === 'launchctl' && args[0] === 'bootstrap') { state.loaded.add(path.basename(args[2], '.plist')); return { status: 0, stdout: '', stderr: '' }; }
    if (cmd === 'launchctl' && args[0] === 'bootout') { state.loaded.delete(args[1].split('/').pop()); return { status: 0, stdout: '', stderr: '' }; }
    throw new Error(`unexpected spawn: ${cmd} ${args.join(' ')}`);
  };
  return { deps: { platform: 'darwin', homeDir: null, spawn, uid: 501 }, calls };
}

function oldPlist(root) {
  return autoland.buildLaunchAgentPlist(root, LABEL).replace(toolPath.SCHEDULE_PATH, '/usr/bin:/bin');
}

test('a new job file carries a PATH that finds gh in the package folders', (t) => {
  const { home, root, file } = scheduleFixture(t);
  const fake = fakeLaunchctl();
  const out = autoland.installSchedule(root, { ...fake.deps, homeDir: home });
  assert.equal(out.ok, true, out.error);
  const xml = fs.readFileSync(file, 'utf8');
  assert.match(xml, /<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/);
});

test('an old job file with the short PATH gets only its PATH fixed and is reloaded', (t) => {
  const { home, root, file } = scheduleFixture(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = oldPlist(root).replace('<integer>14</integer>', '<integer>44</integer>');
  fs.writeFileSync(file, before);
  const fake = fakeLaunchctl({ loaded: [LABEL] });
  const out = autoland.installSchedule(root, { ...fake.deps, homeDir: home });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.kept_existing, true);
  assert.equal(out.path_repaired, toolPath.SCHEDULE_PATH);
  const after = fs.readFileSync(file, 'utf8');
  assert.equal(after, before.replace('<string>/usr/bin:/bin</string>', `<string>${toolPath.SCHEDULE_PATH}</string>`), 'only the PATH changed; minute 44 kept');
  const moves = fake.calls.filter((c) => c[0] === 'launchctl' && (c[1] === 'bootout' || c[1] === 'bootstrap')).map((c) => c[1]);
  assert.deepEqual(moves, ['bootout', 'bootstrap']);
  assert.equal(autoland.schedulerState(root, { ...fake.deps, homeDir: home }).stale_path, undefined);

  // A second pass changes nothing.
  const again = autoland.installSchedule(root, { ...fake.deps, homeDir: home });
  assert.equal(again.path_repaired, undefined);
  assert.equal(fs.readFileSync(file, 'utf8'), after);
});

test('a job running a tick right now is not reloaded under it, and status names the short PATH', (t) => {
  const { home, root, file } = scheduleFixture(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = oldPlist(root);
  fs.writeFileSync(file, before);
  const fake = fakeLaunchctl({ loaded: [LABEL], running: [LABEL] });
  const out = autoland.installSchedule(root, { ...fake.deps, homeDir: home });
  assert.equal(out.ok, true, out.error);
  assert.match(out.path_repair_waiting, /a tick is running now/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fake.calls.some((c) => c[1] === 'bootout' || c[1] === 'bootstrap'), false);
  assert.equal(autoland.schedulerState(root, { ...fake.deps, homeDir: home }).stale_path, '/usr/bin:/bin');
});

// --- the tick ---

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

function tickRepo(t, origin) {
  const base = tempDir(t, 'atris-tool-tick-');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  git(['init', '-q', '-b', 'master'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.atris/\natris/runs/\natris/logs/\n');
  git(['add', '.'], repo);
  git(['commit', '-qm', 'init'], repo);
  if (origin) git(['remote', 'add', 'origin', origin], repo);
  fs.mkdirSync(path.join(repo, '.atris', 'policy'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.atris', 'policy', 'autoland.json'), JSON.stringify({
    enabled: true, enabled_by: 'keshav', daily_experiment: false, janitor: false, green_landing: false, map_fold: false,
  }));
  return { base, repo, shortPath: shortPathWithoutGh(t) };
}

function tick(fx, extraEnv = {}) {
  const env = {
    ...process.env,
    PATH: fx.shortPath,
    ATRIS_TOOL_PACKAGE_DIRS: '',
    ATRIS_TASKS_DB: path.join(fx.base, 'tasks.db'),
    ATRIS_SKIP_UPDATE_CHECK: '1',
    HOME: fx.base,
    ...extraEnv,
  };
  delete env.NODE_TEST_CONTEXT;
  delete env.ATRIS_AGENT_PROOF_ONLY;
  delete env.ATRIS_TOOL_DIRS;
  return spawnSync(process.execPath, [CLI, 'autoland', 'tick', '--json'], { cwd: fx.repo, encoding: 'utf8', env, timeout: 240000 });
}

test('a GitHub project whose tick cannot find gh fails out loud with one line and a non-zero exit', (t) => {
  const fx = tickRepo(t, 'https://github.com/example/fixture.git');
  const res = tick(fx);
  assert.equal(res.status, 1, res.stdout + res.stderr);
  const lines = res.stderr.split('\n').filter((l) => /gh not found/.test(l));
  assert.equal(lines.length, 1, res.stderr);
  const receipt = JSON.parse(res.stdout.trim().split('\n').pop());
  assert.deepEqual(receipt.tools_missing, ['gh']);
});

test('the same tick finds gh in a tool folder off PATH and exits 0', (t) => {
  const fx = tickRepo(t, 'https://github.com/example/fixture.git');
  const tools = path.join(fx.base, 'tools');
  fakeTool(tools, 'gh');
  const res = tick(fx, { ATRIS_TOOL_PACKAGE_DIRS: tools });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.doesNotMatch(res.stderr, /gh not found/);
  const receipt = JSON.parse(res.stdout.trim().split('\n').pop());
  assert.equal(receipt.tools_missing, undefined);
});

test('a project not on GitHub does not need gh', (t) => {
  const fx = tickRepo(t, null);
  const res = tick(fx);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.doesNotMatch(res.stderr, /gh not found/);
});
