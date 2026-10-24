'use strict';

// Every headless Chrome this CLI starts must skip the macOS keychain
// (--use-mock-keychain, --password-store=basic, so no "Chrome Safe Storage"
// prompt) and run on its own throwaway --user-data-dir under the temp folder,
// removed afterward. A fake chrome binary records the real argv each launch
// spot passes: commands/card.js, commands/reel.js, scripts/gm-phone-trace.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { KEYCHAIN_FLAGS, headlessArgs } = require('../lib/headless-chrome');
const card = require('../commands/card');
const reel = require('../commands/reel');
const gmTrace = require('../scripts/gm-phone-trace');

// Writes each launch's argv to args.<pid>, notes whether the profile folder
// existed at launch, drops a file where --screenshot points, and exits 0.
function writeFakeChrome(dir) {
  const bin = path.join(dir, 'fake-chrome');
  fs.writeFileSync(bin, [
    '#!/bin/sh',
    `out="${dir}/args.$$"`,
    'printf \'%s\\n\' "$@" > "$out"',
    'for a in "$@"; do',
    '  case "$a" in',
    '    --user-data-dir=*) if [ -d "${a#--user-data-dir=}" ]; then echo yes > "$out.profile-existed"; fi ;;',
    '    --screenshot=*) : > "${a#--screenshot=}" ;;',
    '  esac',
    'done',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
  return bin;
}

function readLaunches(dir) {
  return fs.readdirSync(dir)
    .filter((name) => /^args\.\d+$/.test(name))
    .map((name) => ({
      args: fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean),
      profileExistedAtLaunch: fs.existsSync(path.join(dir, `${name}.profile-existed`)),
    }));
}

function clearLaunches(dir) {
  for (const name of fs.readdirSync(dir).filter((n) => n.startsWith('args.'))) fs.rmSync(path.join(dir, name));
}

function assertSafeLaunch(launch, label) {
  const { args } = launch;
  for (const flag of KEYCHAIN_FLAGS) assert.ok(args.includes(flag), `${label} is missing ${flag}: ${args.join(' ')}`);
  assert.deepEqual([...KEYCHAIN_FLAGS], ['--use-mock-keychain', '--password-store=basic']);
  const dirs = args.filter((a) => a.startsWith('--user-data-dir='));
  assert.equal(dirs.length, 1, `${label} needs exactly one --user-data-dir: ${args.join(' ')}`);
  const profile = dirs[0].slice('--user-data-dir='.length);
  assert.ok(path.resolve(profile).startsWith(path.resolve(os.tmpdir()) + path.sep), `${label} profile is not under the temp folder: ${profile}`);
  assert.equal(launch.profileExistedAtLaunch, true, `${label} profile folder did not exist when chrome started`);
  assert.equal(fs.existsSync(profile), false, `${label} left its profile behind: ${profile}`);
}

test('card, reel, and the gm phone trace launch chrome with the keychain flags and a throwaway profile', async (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-flags-test-'));
  const prevChrome = process.env.CHROME_PATH;
  t.after(() => {
    if (prevChrome === undefined) delete process.env.CHROME_PATH; else process.env.CHROME_PATH = prevChrome;
    fs.rmSync(work, { recursive: true, force: true });
  });
  const fake = writeFakeChrome(work);
  process.env.CHROME_PATH = fake;

  // the helper refuses a profile outside the temp folder, so a real one can't slip in
  assert.throws(() => headlessArgs(path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome')), /throwaway profile/);
  assert.throws(() => headlessArgs(''), /throwaway profile/);

  // atris card
  t.mock.method(console, 'log', () => {});
  assert.equal(card.run(['Ship faster', '--out', path.join(work, 'out')]), 0);
  const cardLaunches = readLaunches(work);
  assert.equal(cardLaunches.length, 1);
  assertSafeLaunch(cardLaunches[0], 'atris card');
  clearLaunches(work);

  // atris reel (every frame gets its own profile)
  const reelDir = path.join(work, 'reel');
  fs.mkdirSync(reelDir);
  const spec = { kind: 'statement', text: 'Ship faster', headline: 'Ship faster', size: 'square' };
  await reel.renderFrames(fake, [0, 0.5, 1], spec, reelDir, 200, 200);
  const reelLaunches = readLaunches(work);
  assert.equal(reelLaunches.length, 3);
  reelLaunches.forEach((l, i) => assertSafeLaunch(l, `atris reel frame ${i}`));
  const reelProfiles = reelLaunches.map((l) => l.args.find((a) => a.startsWith('--user-data-dir=')));
  assert.equal(new Set(reelProfiles).size, 3, 'each reel frame should use its own profile');
  clearLaunches(work);

  // scripts/gm-phone-trace.js (the fake exits at once, so the launch rejects after chrome starts)
  await assert.rejects(() => gmTrace.launch(fake), /chrome exited/);
  const traceLaunches = readLaunches(work);
  assert.equal(traceLaunches.length, 1);
  assertSafeLaunch(traceLaunches[0], 'gm phone trace');
});

// ---- quitting the gm phone trace's chrome ----------------------------------------------

const { execFileSync } = require('node:child_process');
const wait = ms => new Promise(r => setTimeout(r, ms));
const pipesOpen = () => process.getActiveResourcesInfo().filter(r => r === 'PipeWrap').length;
// the processes still alive in a process group, by pid; a finished one waiting to be reaped is not alive
const alive = () => execFileSync('ps', ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8' }).split('\n')
  .map(l => l.trim().split(/\s+/)).filter(([, , stat]) => stat && !stat.startsWith('Z')).map(([pid, pgid]) => ({ pid: Number(pid), pgid: Number(pgid) }));
function aliveInGroup(group) {
  return alive().filter(p => p.pgid === group).map(p => p.pid);
}
async function untilGone(group, ms = 5000) {
  const end = Date.now() + ms;
  while (aliveInGroup(group).length && Date.now() < end) await wait(50);
  return aliveInGroup(group);
}
// a pipe let go closes on a later turn of the loop
async function pipesAfter(most, ms = 2000) {
  const end = Date.now() + ms;
  while (pipesOpen() > most && Date.now() < end) await wait(20);
  return pipesOpen();
}
const posix = { skip: process.platform === 'win32' && 'process groups are posix' };

test('the gm phone trace quits its chrome with every process it started, so one left behind cannot hold its pipe and keep the run open', posix, async (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-quit-test-'));
  // a chrome whose helper outlives it: the helper keeps the same stderr, then the chrome exits
  const bin = path.join(work, 'fake-chrome');
  fs.writeFileSync(bin, ['#!/bin/sh', 'sleep 30 &', `echo $! > "${work}/helper"`, `echo $$ > "${work}/chrome"`, 'exit 1', ''].join('\n'), { mode: 0o755 });
  const helper = () => Number(fs.readFileSync(path.join(work, 'helper'), 'utf8'));
  t.after(() => { try { process.kill(helper(), 'SIGKILL'); } catch { /* gone */ } fs.rmSync(work, { recursive: true, force: true }); });
  const pipes = pipesOpen();
  await assert.rejects(() => gmTrace.launch(bin), /chrome exited 1/);
  const chrome = Number(fs.readFileSync(path.join(work, 'chrome'), 'utf8'));
  assert.deepEqual(await untilGone(chrome), [], 'the chrome ran as its own group, and nothing in it is left');
  assert.equal(alive().some(p => p.pid === helper()), false, 'the helper is gone too');
  const open = await pipesAfter(pipes);
  assert.ok(open <= pipes, `its stderr is let go: ${open} pipes open, ${pipes} before`);
});

const REAL_CHROME = gmTrace.findChrome();
test('the gm phone trace\'s real chrome quits whole: nothing left in its process group and its stderr closed', { skip: (!REAL_CHROME && 'no chrome on this machine') || posix.skip, timeout: 120000 }, async () => {
  const pipes = pipesOpen();
  const chrome = await gmTrace.launch(REAL_CHROME);
  try {
    await chrome.send('Page.navigate', { url: 'about:blank' });
    assert.ok(aliveInGroup(chrome.pid).length > 1, 'chrome and its helpers run in their own group');
  } finally {
    chrome.close();
  }
  assert.deepEqual(await untilGone(chrome.pid), [], 'nothing in the group is left');
  assert.equal(chrome.stderr.destroyed, true);
  const open = await pipesAfter(pipes);
  assert.ok(open <= pipes, `its stderr is let go: ${open} pipes open, ${pipes} before`);
});
