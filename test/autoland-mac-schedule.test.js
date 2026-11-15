'use strict';

// On a Mac the hourly pass must run inside the login so gh can read its
// token from the login keychain. cron runs outside it: every scheduled pass
// read pull requests signed out and never landed anything by itself.
//
// Every test here runs against a temp HOME and a fake scheduler. The real
// crontab, the real LaunchAgents folder and the real launchctl are never
// touched; the Linux case puts a fake crontab first on PATH.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const autoland = require('../lib/autoland');
const { turnOn, turnOff } = require('../commands/autoland');
const { summaryLine } = require('../lib/land-green');

const MARKER = 'ATRIS_AUTOLAND_MY_PROJECT_V2';
const LABEL = 'ai.atris.autoland.my-project-v2';

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mac-schedule-'));
  const home = path.join(base, 'home');
  const root = path.join(base, 'My Project__v2');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH };
  process.env.HOME = home;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { base, home, root };
}

// A fake crontab and launchctl in one spawn. `table` is the crontab text, or
// null when crontab -l fails; `loaded` is the set of labels launchctl knows.
function fakeScheduler({ home, table = '', loaded = [], platform = 'darwin', bootstrapFails = false } = {}) {
  const calls = [];
  const state = { table, loaded: new Set(loaded) };
  const spawn = (cmd, args, opts = {}) => {
    calls.push([cmd, ...args]);
    if (cmd === 'crontab' && args[0] === '-l') {
      if (state.table === null) return { status: 1, stdout: '', stderr: 'crontab: tmp/tmp.123: Operation not permitted' };
      if (state.table === '') return { status: 1, stdout: '', stderr: 'crontab: no crontab for someone' };
      return { status: 0, stdout: state.table, stderr: '' };
    }
    if (cmd === 'crontab' && args[0] === '-') {
      state.table = String(opts.input || '');
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'launchctl' && args[0] === 'print') {
      const label = args[1].split('/').pop();
      return state.loaded.has(label) ? { status: 0, stdout: `${label} = {}`, stderr: '' } : { status: 113, stdout: '', stderr: 'Could not find service' };
    }
    if (cmd === 'launchctl' && args[0] === 'bootstrap') {
      if (bootstrapFails) return { status: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };
      const file = args[2];
      state.loaded.add(path.basename(file, '.plist'));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'launchctl' && args[0] === 'bootout') {
      state.loaded.delete(args[1].split('/').pop());
      return { status: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected spawn: ${cmd} ${args.join(' ')}`);
  };
  return { deps: { platform, homeDir: home, spawn, uid: 501 }, calls, state };
}

function quiet(t) {
  const log = console.log;
  const lines = [];
  console.log = (...args) => { lines.push(args.join(' ')); };
  t.after(() => { console.log = log; });
  return lines;
}

function plistFile(home) {
  return path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

test('the label is the folder name lowercased with each run of other characters one dash', () => {
  assert.equal(autoland.launchAgentLabel('/tmp/My Project__v2'), LABEL);
  assert.equal(autoland.launchAgentLabel('/tmp/atris-cli'), 'ai.atris.autoland.atris-cli');
  assert.equal(autoland.launchAgentLabel('/tmp/Atris.OS  Backend'), 'ai.atris.autoland.atris-os-backend');
});

test('on a Mac, on installs one LaunchAgent with the cron command, the short PATH and minute 14', (t) => {
  const { home, root } = fixture(t);
  const fake = fakeScheduler({ home });
  const out = autoland.installSchedule(root, fake.deps);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.kind, 'launchd');
  assert.equal(out.kept_existing, false);
  const xml = fs.readFileSync(plistFile(home), 'utf8');
  assert.match(xml, new RegExp(`<key>Label</key>\\s*<string>${LABEL.replace(/\./g, '\\.')}</string>`));
  assert.match(xml, /<string>\/bin\/sh<\/string>\s*<string>-c<\/string>/);
  const escaped = autoland.buildTickCommand(root).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  assert.ok(xml.includes(`<string>${escaped}</string>`), 'the plist runs the same command as the cron line');
  assert.ok(autoland.buildCronLine(root).includes(autoland.buildTickCommand(root)));
  assert.match(xml, /<key>PATH<\/key>\s*<string>\/usr\/bin:\/bin<\/string>/);
  assert.match(xml, /<key>StartCalendarInterval<\/key>\s*<array>\s*<dict>\s*<key>Minute<\/key>\s*<integer>14<\/integer>/);
  assert.deepEqual(fake.calls.filter((c) => c[0] === 'launchctl' && c[1] === 'bootstrap'), [['launchctl', 'bootstrap', 'gui/501', plistFile(home)]]);
  assert.equal(fake.calls.some((c) => c[0] === 'crontab' && c[1] === '-'), false, 'an empty crontab is never rewritten');
});

test('an existing LaunchAgent is kept byte for byte and on says so in one line', (t) => {
  const { home, root } = fixture(t);
  const tuned = '<?xml version="1.0"?>\n<plist><dict><key>Label</key><string>tuned by hand, minute 44</string></dict></plist>\n';
  fs.mkdirSync(path.dirname(plistFile(home)), { recursive: true });
  fs.writeFileSync(plistFile(home), tuned);
  const fake = fakeScheduler({ home, loaded: [LABEL] });
  const lines = quiet(t);
  assert.equal(turnOn(root, [], { scheduler: fake.deps }), 0);
  assert.equal(fs.readFileSync(plistFile(home), 'utf8'), tuned);
  assert.equal(fake.calls.some((c) => c[0] === 'launchctl' && (c[1] === 'bootout' || c[1] === 'bootstrap')), false);
  const kept = lines.filter((l) => /kept the hourly job already set up on this Mac exactly as it is/.test(l));
  assert.equal(kept.length, 1);
});

test('an existing LaunchAgent that launchctl does not know is loaded without being rewritten', (t) => {
  const { home, root } = fixture(t);
  fs.mkdirSync(path.dirname(plistFile(home)), { recursive: true });
  fs.writeFileSync(plistFile(home), 'hand tuned\n');
  const fake = fakeScheduler({ home });
  const out = autoland.installSchedule(root, fake.deps);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.kept_existing, true);
  assert.equal(fs.readFileSync(plistFile(home), 'utf8'), 'hand tuned\n');
  assert.deepEqual(fake.calls.filter((c) => c[0] === 'launchctl' && c[1] !== 'print'), [['launchctl', 'bootstrap', 'gui/501', plistFile(home)]]);
});

test('on a Mac, on removes the live cron line and keeps commented, foreign and look-alike lines', (t) => {
  const { home, root } = fixture(t);
  const table = [
    '0 5 * * * /usr/bin/other-job',
    `# 14 * * * * cd old && atris autoland tick # ${MARKER}`,
    `14 * * * * cd '${root}' && atris autoland tick >> log 2>&1 # ${MARKER}`,
    `14 * * * * cd elsewhere && atris autoland tick # ${MARKER}_OLD`,
    '',
    '30 2 * * * /usr/bin/backup',
    '',
  ].join('\n');
  const fake = fakeScheduler({ home, table });
  const lines = quiet(t);
  turnOn(root, [], { scheduler: fake.deps });
  assert.equal(fake.state.table, [
    '0 5 * * * /usr/bin/other-job',
    `# 14 * * * * cd old && atris autoland tick # ${MARKER}`,
    `14 * * * * cd elsewhere && atris autoland tick # ${MARKER}_OLD`,
    '',
    '30 2 * * * /usr/bin/backup',
    '',
  ].join('\n'));
  assert.ok(lines.some((l) => /removed the old cron line for this project/.test(l)));
});

test('the cron line stays when the LaunchAgent cannot be loaded, so there is still one schedule', (t) => {
  const { home, root } = fixture(t);
  const table = `14 * * * * tick # ${MARKER}\n`;
  const fake = fakeScheduler({ home, table, bootstrapFails: true });
  const out = autoland.installSchedule(root, fake.deps);
  assert.equal(out.ok, true);
  assert.equal(out.kind, 'cron');
  assert.equal(out.kept_cron_line, true);
  assert.match(out.launchd_error, /Bootstrap failed/);
  assert.equal(fake.state.table, table);
  assert.equal(fs.existsSync(plistFile(home)), false);
});

test('off removes the LaunchAgent and any live cron line', (t) => {
  const { home, root } = fixture(t);
  const fake = fakeScheduler({ home, table: `0 5 * * * other\n14 * * * * tick # ${MARKER}\n# 14 * * * * old # ${MARKER}\n` });
  quiet(t);
  turnOn(root, [], { scheduler: fake.deps });
  fake.state.table += `14 * * * * tick again # ${MARKER}\n`;
  assert.equal(turnOff(root, { scheduler: fake.deps }), 0);
  assert.equal(fs.existsSync(plistFile(home)), false);
  assert.ok(fake.calls.some((c) => c[0] === 'launchctl' && c[1] === 'bootout' && c[2] === `gui/501/${LABEL}`));
  assert.equal(fake.state.loaded.has(LABEL), false);
  assert.equal(fake.state.table, `0 5 * * * other\n# 14 * * * * old # ${MARKER}\n`);
  assert.equal(autoland.readPolicy(root).enabled, false);
});

test('Linux still installs and removes the cron line and never writes a LaunchAgent', (t) => {
  const { base, home, root } = fixture(t);
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  const tableFile = path.join(base, 'crontab.txt');
  fs.writeFileSync(path.join(bin, 'crontab'), `#!/bin/sh\nif [ "$1" = "-l" ]; then cat '${tableFile}' 2>/dev/null; exit 0; fi\ncat > '${tableFile}'\n`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  const deps = { platform: 'linux', homeDir: home, uid: 501 };
  const out = autoland.installSchedule(root, deps);
  assert.deepEqual(out, { ok: true, kind: 'cron' });
  assert.match(fs.readFileSync(tableFile, 'utf8'), new RegExp(`^14 \\* \\* \\* \\* .*autoland tick.*# ${MARKER}\\n$`));
  assert.equal(fs.existsSync(path.join(home, 'Library')), false);
  assert.deepEqual(autoland.uninstallSchedule(root, deps), { ok: true, kind: 'cron' });
  assert.equal(fs.readFileSync(tableFile, 'utf8'), '');
});

test('on keeps every policy key it does not set itself', (t) => {
  const { home, root } = fixture(t);
  const before = {
    enabled: false,
    enabled_by: 'someone',
    green_landing: false,
    verify_command: 'node --test test/one.test.js',
    green_landing_local_suites: 2,
    green_landing_hold_labels: ['hold', 'do not merge'],
    janitor: false,
    idle_sweep: false,
    live_updates: { to: 'the log' },
    a_key_nobody_knows_yet: 7,
    daily_experiment: false,
  };
  autoland.writePolicy(root, before);
  quiet(t);
  turnOn(root, ['--as', 'owner'], { scheduler: fakeScheduler({ home }).deps });
  const after = JSON.parse(fs.readFileSync(autoland.policyPath(root), 'utf8'));
  for (const key of ['green_landing', 'verify_command', 'green_landing_local_suites', 'green_landing_hold_labels', 'janitor', 'idle_sweep', 'live_updates', 'a_key_nobody_knows_yet']) {
    assert.deepEqual(after[key], before[key], key);
  }
  assert.equal(after.enabled, true);
  assert.equal(after.enabled_by, 'owner');
  assert.equal(after.daily_experiment, false);
  assert.equal('default' in after, false, 'the inferred default is never written down');
});

test('liveness reads the real scheduler, not a saved flag', (t) => {
  const { home, root } = fixture(t);
  autoland.writePolicy(root, { enabled: true, heartbeat_installed: true });

  let fake = fakeScheduler({ home });
  assert.equal(autoland.heartbeatLiveness(root, fake.deps), false, 'nothing scheduled despite the saved flag');
  assert.equal(autoland.heartbeatStatusText(root, autoland.schedulerState(root, fake.deps)), 'not installed - run atris autoland on');

  fs.mkdirSync(path.dirname(plistFile(home)), { recursive: true });
  fs.writeFileSync(plistFile(home), 'x');
  assert.equal(autoland.heartbeatLiveness(root, fake.deps), false);
  assert.equal(autoland.heartbeatStatusText(root, autoland.schedulerState(root, fake.deps)), 'set up but not loaded - run atris autoland on');

  fake = fakeScheduler({ home, loaded: [LABEL] });
  assert.deepEqual(autoland.schedulerState(root, fake.deps), { installed: true, kind: 'launchd', label: LABEL, mac_cron_only: false });
  assert.equal(fake.calls.some((c) => c[0] === 'crontab'), false, 'a loaded LaunchAgent needs no crontab read');

  fs.rmSync(plistFile(home));
  fake = fakeScheduler({ home, table: `14 * * * * tick # ${MARKER}\n` });
  const cronOnly = autoland.schedulerState(root, fake.deps);
  assert.equal(cronOnly.installed, true);
  assert.equal(cronOnly.mac_cron_only, true);
  const text = autoland.heartbeatStatusText(root, cronOnly);
  assert.match(text, /scheduled runs cannot use the GitHub sign-in/);
  assert.match(text, /run atris autoland on again to fix it/);

  fake = fakeScheduler({ home, table: `# 14 * * * * tick # ${MARKER}\n` });
  assert.equal(autoland.heartbeatLiveness(root, fake.deps), false, 'a commented line is not a schedule');

  fake = fakeScheduler({ home, table: null });
  assert.equal(autoland.heartbeatLiveness(root, fake.deps), null, 'an unreadable crontab is unknown');

  fake = fakeScheduler({ home, platform: 'linux', table: `14 * * * * tick # ${MARKER}\n` });
  assert.deepEqual(autoland.schedulerState(root, fake.deps), { installed: true, kind: 'cron', mac_cron_only: false });
  assert.equal(fake.calls.some((c) => c[0] === 'launchctl'), false);
});

test('status says cron cannot use the sign-in when cron is the only schedule on a Mac', (t) => {
  const { home, root } = fixture(t);
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({ tasks: [] }));
  const fake = fakeScheduler({ home, table: `14 * * * * tick # ${MARKER}\n` });
  const lines = quiet(t);
  const { showStatus } = require('../commands/autoland');
  showStatus(root, [], { scheduler: fake.deps, home });
  const heartbeat = lines.find((l) => l.startsWith('  heartbeat: '));
  assert.match(heartbeat, /cron runs it outside your login on this Mac, so scheduled runs cannot use the GitHub sign-in; run atris autoland on again to fix it/);
});

test('under the test runner the real home and the system scheduler tools are refused', (t) => {
  const { root } = fixture(t);
  const never = () => { throw new Error('must not run'); };
  const realHome = os.userInfo().homedir;
  const out = autoland.installSchedule(root, { platform: 'darwin', homeDir: realHome, spawn: never, uid: 501 });
  assert.equal(out.ok, false);
  assert.match(out.error, /refused/);
  assert.equal(autoland.uninstallSchedule(root, { platform: 'darwin', homeDir: realHome, spawn: never, uid: 501 }).ok, false);
  // No injected runner: launchctl would be the system one.
  process.env.PATH = '/usr/bin:/bin';
  const plain = autoland.installSchedule(root, { platform: 'darwin', homeDir: process.env.HOME });
  assert.equal(plain.ok, false);
  assert.match(plain.error, /refused/);
  assert.equal(fs.existsSync(path.join(process.env.HOME, 'Library')), false);
});

test('a tick with no GitHub sign-in says so once with the fix and keeps each branch row', () => {
  const detail = 'its pull request could not be read (HTTP 401: This endpoint requires you to be authenticated. (https://api.github.com/graphql)); could not tell, tries again next run';
  const result = {
    candidates: ['feat/a', 'feat/b'],
    landed: [],
    red: [],
    verdicts: [
      { branch: 'feat/a', action: 'unknown', reason: 'pull_request_unreadable', detail },
      { branch: 'feat/b', action: 'unknown', reason: 'pull_request_unreadable', detail },
    ],
  };
  const line = summaryLine(result);
  assert.equal(line.match(/no GitHub sign-in/g).length, 1);
  assert.match(line, /^this run had no GitHub sign-in and could not read pull requests; to fix it run gh auth login if you are signed out, and on a Mac run atris autoland on again/);
  assert.match(line, /gh auth login/);
  assert.match(line, /could not tell feat\/a, feat\/b \(its pull request could not be read \(HTTP 401/);

  const other = summaryLine({ ...result, verdicts: result.verdicts.map((v) => ({ ...v, detail: 'its pull request could not be read (timeout); could not tell' })) });
  assert.doesNotMatch(other, /sign-in/);
});

// --- review round one ---

test('a fake runner with the real home is refused even without the test runner marker', () => {
  // A child with no NODE_TEST_CONTEXT, no --test flag and no test file name,
  // like `node file.test.js` reaching the code by another route. Every write
  // under the real home is intercepted, so a failing run writes nothing.
  const { spawnSync } = require('node:child_process');
  const lib = path.join(__dirname, '..', 'lib', 'autoland.js');
  const script = `
    const fs = require('fs'); const os = require('os'); const path = require('path');
    const real = path.join(os.userInfo().homedir, 'Library');
    const hits = [];
    for (const name of ['mkdirSync', 'writeFileSync', 'unlinkSync']) {
      const orig = fs[name];
      fs[name] = function (p, ...rest) {
        if (String(p).startsWith(real)) { hits.push(name); throw new Error('intercepted ' + name); }
        return orig.call(this, p, ...rest);
      };
    }
    const autoland = require(${JSON.stringify(lib)});
    const calls = [];
    const spawn = (cmd, args) => { calls.push(cmd); return { status: 0, stdout: '', stderr: '' }; };
    const deps = { platform: 'darwin', homeDir: os.userInfo().homedir, spawn, uid: 501 };
    let on, off;
    try { on = autoland.installSchedule('/tmp/no-such-project-x', deps); } catch (e) { on = { ok: 'threw', error: e.message }; }
    try { off = autoland.uninstallSchedule('/tmp/no-such-project-x', deps); } catch (e) { off = { ok: 'threw', error: e.message }; }
    process.stdout.write(JSON.stringify({ on, off, hits, calls }));
  `;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', timeout: 20000 });
  assert.equal(run.status, 0, run.stderr);
  const got = JSON.parse(run.stdout);
  assert.deepEqual(got.hits, [], 'nothing under the real home is written');
  assert.deepEqual(got.calls, [], 'the fake runner is never asked');
  assert.equal(got.on.ok, false);
  assert.match(got.on.error, /refused/);
  assert.equal(got.off.ok, false);
});

test('the Linux path uses an injected runner for the crontab', (t) => {
  const { home, root } = fixture(t);
  const fake = fakeScheduler({ home, platform: 'linux' });
  process.env.PATH = '/nonexistent-bin';
  const out = autoland.installSchedule(root, fake.deps);
  assert.equal(out.ok, true);
  assert.equal(out.kind, 'cron');
  assert.match(fake.state.table, new RegExp(`# ${MARKER}\\n$`));
  assert.equal(autoland.uninstallSchedule(root, fake.deps).ok, true);
  assert.equal(fake.state.table, '');
  assert.ok(fake.calls.every((c) => c[0] === 'crontab'));
});

test('off then on leaves no inferred default behind, so status says who flipped it', (t) => {
  const { home, root } = fixture(t);
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({ tasks: [] }));
  const fake = fakeScheduler({ home });
  const lines = quiet(t);
  turnOff(root, { scheduler: fake.deps });
  turnOn(root, ['--as', 'owner'], { scheduler: fake.deps });
  const saved = JSON.parse(fs.readFileSync(autoland.policyPath(root), 'utf8'));
  assert.equal('default' in saved, false);
  assert.equal('disabled_at' in saved, false);
  lines.length = 0;
  const { showStatus } = require('../commands/autoland');
  showStatus(root, [], { scheduler: fake.deps, home });
  const policy = lines.find((l) => l.startsWith('  policy: '));
  assert.match(policy, /policy: on \(flipped by owner on /);
});

test('two projects with the same folder name each get their own login job', (t) => {
  const { base, home } = fixture(t);
  const first = path.join(base, 'work', 'api');
  const second = path.join(base, 'personal', 'api');
  fs.mkdirSync(first, { recursive: true });
  fs.mkdirSync(second, { recursive: true });
  const fake = fakeScheduler({ home });
  const one = autoland.installSchedule(first, fake.deps);
  assert.equal(one.ok, true, one.error);
  const firstText = fs.readFileSync(one.plist_path, 'utf8');
  const lines = quiet(t);
  turnOn(second, [], { scheduler: fake.deps });
  const two = autoland.schedulerState(second, fake.deps);
  assert.equal(two.installed, true);
  assert.notEqual(two.label, one.label);
  assert.equal(fs.readFileSync(one.plist_path, 'utf8'), firstText, 'the first project keeps its job');
  const secondFile = path.join(home, 'Library', 'LaunchAgents', `${two.label}.plist`);
  assert.ok(fs.readFileSync(secondFile, 'utf8').includes(second));
  assert.ok(lines.some((l) => /another project already uses the job name/.test(l)));
  assert.equal(lines.some((l) => /kept the hourly job already set up/.test(l)), false);
  turnOff(second, { scheduler: fake.deps });
  assert.equal(fs.existsSync(one.plist_path), true, 'off in the second never deletes the first');
  assert.equal(fs.existsSync(secondFile), false);
  assert.equal(fake.state.loaded.has(one.label), true);
});

test('on repairs a job whose program is gone and keeps its timing', (t) => {
  const { home, root } = fixture(t);
  const fake = fakeScheduler({ home });
  assert.equal(autoland.installSchedule(root, fake.deps).ok, true);
  const file = plistFile(home);
  const gone = '/nonexistent/Cellar/node/24.2.0/bin/node';
  const stale = fs.readFileSync(file, 'utf8')
    .split(process.execPath).join(gone)
    .replace('<integer>14</integer>', '<integer>44</integer>');
  fs.writeFileSync(file, stale);
  const before = autoland.schedulerState(root, fake.deps);
  assert.equal(before.stale_program, gone);
  assert.match(autoland.heartbeatStatusText(root, before), /program that is gone - run atris autoland on to repair it/);
  fake.calls.length = 0;
  const out = autoland.installSchedule(root, fake.deps);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.repaired, gone);
  const fixed = fs.readFileSync(file, 'utf8');
  assert.ok(fixed.includes(process.execPath));
  assert.equal(fixed.includes(gone), false);
  assert.match(fixed, /<integer>44<\/integer>/, 'the hand-set minute stays');
  assert.ok(fake.calls.some((c) => c[1] === 'bootout'));
  assert.ok(fake.calls.some((c) => c[1] === 'bootstrap'));
  assert.equal(autoland.schedulerState(root, fake.deps).stale_program, undefined);
});

test('the sign-in note only reads pull request rows, not a branch whose own test says 401', () => {
  const result = {
    candidates: ['feat/a'],
    landed: [],
    red: ['feat/a'],
    verdicts: [
      { branch: 'feat/a', action: 'red', reason: 'local_check_failed', detail: 'the local check could not run on this branch (exit 1): AssertionError: login returned HTTP 401. it does run on master, so the branch broke it' },
      { branch: 'feat/b', action: 'red', reason: 'local_check_failed', detail: 'Error: user is not logged in' },
    ],
  };
  assert.doesNotMatch(summaryLine(result), /sign-in/);
});

test('on falls back to the cron line when the job file cannot be written, and nothing throws', (t) => {
  const { home, root } = fixture(t);
  const dir = path.join(home, 'Library', 'LaunchAgents');
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o500);
  const fake = fakeScheduler({ home });
  const lines = quiet(t);
  try {
    assert.doesNotThrow(() => turnOn(root, [], { scheduler: fake.deps }));
  } finally {
    fs.chmodSync(dir, 0o700);
  }
  assert.match(fake.state.table, new RegExp(`# ${MARKER}\\n$`), 'there is still one schedule');
  assert.ok(lines.some((l) => /could not set up the job inside your Mac login/.test(l)));
  assert.equal(autoland.schedulerState(root, fake.deps).kind, 'cron');
});

test('off says the job file is still there when it cannot be deleted, and nothing throws', (t) => {
  const { home, root } = fixture(t);
  const fake = fakeScheduler({ home, table: `14 * * * * tick # ${MARKER}\n` });
  assert.equal(autoland.installSchedule(root, fake.deps).ok, true);
  const dir = path.dirname(plistFile(home));
  fs.chmodSync(dir, 0o500);
  let out;
  try {
    assert.doesNotThrow(() => { out = autoland.uninstallSchedule(root, fake.deps); });
  } finally {
    fs.chmodSync(dir, 0o700);
  }
  assert.equal(out.ok, false);
  assert.match(out.error, /could not delete/);
  assert.match(out.error, /loads again at next login/);
});

test('a job that fails to load is removed and the cron line is set up, so there is one schedule', (t) => {
  const { home, root } = fixture(t);
  const fake = fakeScheduler({ home, bootstrapFails: true });
  const out = autoland.installSchedule(root, fake.deps);
  assert.equal(out.ok, true);
  assert.equal(out.kind, 'cron');
  assert.match(out.launchd_error, /Bootstrap failed/);
  assert.equal(fs.existsSync(plistFile(home)), false, 'no leftover job file to load at next login');
  assert.match(fake.state.table, new RegExp(`^14 \\* \\* \\* \\* .*# ${MARKER}\\n$`));
});

test('off reports a failure when launchctl still has the job loaded after bootout', (t) => {
  const { home, root } = fixture(t);
  const fake = fakeScheduler({ home });
  assert.equal(autoland.installSchedule(root, fake.deps).ok, true);
  const spawn = fake.deps.spawn;
  const stuck = { ...fake.deps, spawn: (cmd, args, opts) => (cmd === 'launchctl' && args[0] === 'bootout' ? { status: 5, stdout: '', stderr: 'Boot-out failed: 5: Input/output error' } : spawn(cmd, args, opts)) };
  const out = autoland.uninstallSchedule(root, stuck);
  assert.equal(out.ok, false);
  assert.match(out.error, /still loaded/);
});
