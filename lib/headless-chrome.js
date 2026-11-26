'use strict';

// One place for how this CLI launches headless Chrome. Every spot that starts
// Chrome builds its args here so a new launch can't forget the rules:
//
//   --use-mock-keychain   Chrome never touches the macOS keychain, so nobody
//   --password-store=basic gets a "Chrome Safe Storage" prompt
//   --user-data-dir       a throwaway profile under the system temp folder,
//                         never the person's real Chrome profile
//
// Find the browser with findBrowser, make the profile with makeProfileDir,
// build args with headlessArgs and remove the profile with removeProfileDir
// when the launch is done.

const fs = require('fs');
const os = require('os');
const path = require('path');

const KEYCHAIN_FLAGS = Object.freeze(['--use-mock-keychain', '--password-store=basic']);

const exists = (p) => { try { return !!p && fs.statSync(p).isFile(); } catch { return false; } };

// An installed Chrome, Chromium, Edge or Brave. CHROME_PATH overrides it.
// Never downloads a browser.
function findBrowser(env = process.env, platform = process.platform) {
  if (exists(env.CHROME_PATH)) return env.CHROME_PATH;
  let places = [];
  if (platform === 'darwin') {
    places = ['Google Chrome', 'Chromium', 'Microsoft Edge', 'Brave Browser']
      .map((app) => `/Applications/${app}.app/Contents/MacOS/${app}`);
  } else if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    const exes = ['Google\\Chrome\\Application\\chrome.exe', 'Chromium\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'];
    places = roots.flatMap((r) => exes.map((e) => path.win32.join(r, e)));
  }
  for (const p of places) if (exists(p)) return p;
  if (platform === 'win32') return null;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser', 'chrome']) {
    for (const dir of String(env.PATH || '').split(path.delimiter)) {
      if (dir && exists(path.join(dir, name))) return path.join(dir, name);
    }
  }
  return null;
}

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

module.exports = { KEYCHAIN_FLAGS, findBrowser, makeProfileDir, removeProfileDir, headlessArgs };
