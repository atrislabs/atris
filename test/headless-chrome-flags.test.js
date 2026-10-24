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
