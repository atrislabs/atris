'use strict';

// One place for how this CLI launches headless Chrome. Every spot that starts
// Chrome builds its args here so a new launch can't forget the rules:
//
//   --use-mock-keychain   Chrome never touches the macOS keychain, so nobody
//   --password-store=basic gets a "Chrome Safe Storage" prompt
//   --user-data-dir       a throwaway profile under the system temp folder,
//                         never the person's real Chrome profile
//
// Make the profile with makeProfileDir, build args with headlessArgs, and
// remove the profile with removeProfileDir when the launch is done.

const fs = require('fs');
const os = require('os');
const path = require('path');

const KEYCHAIN_FLAGS = Object.freeze(['--use-mock-keychain', '--password-store=basic']);

function makeProfileDir(prefix = 'atris-chrome-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeProfileDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
}

// Args for one headless launch. `profileDir` must sit under the system temp
// folder; anything else throws, so a real profile can't be passed by mistake.
function headlessArgs(profileDir, extra = []) {
  const tmpRoot = path.resolve(os.tmpdir());
  const dir = profileDir ? path.resolve(String(profileDir)) : '';
  if (!dir || !dir.startsWith(tmpRoot + path.sep)) {
    throw new Error('headless chrome needs a throwaway profile under the temp folder (makeProfileDir)');
  }
  return ['--headless=new', ...KEYCHAIN_FLAGS, `--user-data-dir=${dir}`, ...extra];
}

module.exports = { KEYCHAIN_FLAGS, makeProfileDir, removeProfileDir, headlessArgs };
