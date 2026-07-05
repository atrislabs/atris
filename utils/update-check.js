const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const PACKAGE_NAME = 'atris';
const NPM_SELF_UPDATE_COMMAND = `npm install -g ${PACKAGE_NAME}@latest`;
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const ATRIS_DIR = path.join(os.homedir(), '.atris');
const CACHE_FILE = path.join(ATRIS_DIR, '.update-check');

/**
 * Get the currently installed CLI version from package.json.
 * @returns {string|null} Installed version string, or null on error
 */
function getInstalledVersion() {
  try {
    const packageJsonPath = path.join(__dirname, '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    return packageJson.version;
  } catch (error) {
    return null;
  }
}

/**
 * Load cached update check data from ~/.atris/.update-check.
 * @returns {{lastCheck: Date|null, latestVersion: string|null}} Cache data
 */
function getCacheData() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      return {
        lastCheck: data.lastCheck ? new Date(data.lastCheck) : null,
        latestVersion: data.latestVersion || null,
        lastAutoUpdate: data.lastAutoUpdate ? new Date(data.lastAutoUpdate) : null,
        lastAutoUpdateVersion: data.lastAutoUpdateVersion || null,
      };
    }
  } catch (error) {
    // Ignore cache errors
  }
  return { lastCheck: null, latestVersion: null };
}

/**
 * Save update check result to ~/.atris/.update-check cache file.
 * @param {string} latestVersion - The latest version from npm
 */
function saveCacheData(latestVersion) {
  try {
    // Ensure ~/.atris/ exists
    if (!fs.existsSync(ATRIS_DIR)) {
      fs.mkdirSync(ATRIS_DIR, { recursive: true });
    }
    const existing = fs.existsSync(CACHE_FILE)
      ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
      : {};
    const data = {
      ...existing,
      lastCheck: new Date().toISOString(),
      latestVersion: latestVersion,
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    // Ignore cache write errors
  }
}

function markAutoUpdateStarted(latestVersion) {
  try {
    if (!fs.existsSync(ATRIS_DIR)) {
      fs.mkdirSync(ATRIS_DIR, { recursive: true });
    }
    const existing = fs.existsSync(CACHE_FILE)
      ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
      : {};
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      ...existing,
      lastAutoUpdate: new Date().toISOString(),
      lastAutoUpdateVersion: latestVersion,
    }, null, 2));
  } catch (error) {
    // Ignore cache write errors
  }
}

function autoUpdateRecentlyStarted(latestVersion, now = new Date()) {
  const cache = getCacheData();
  return Boolean(
    latestVersion &&
    cache.lastAutoUpdate &&
    cache.lastAutoUpdateVersion === latestVersion &&
    now - cache.lastAutoUpdate < CHECK_INTERVAL_MS
  );
}

/**
 * Fetch the latest version of atris from npm registry.
 * @returns {Promise<string>} Latest version string
 */
function checkNpmVersion() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'registry.npmjs.org',
      path: `/${PACKAGE_NAME}/latest`,
      method: 'GET',
      headers: {
        'User-Agent': 'atris-cli',
      },
      timeout: 3000, // 3 second timeout
    };

    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const packageInfo = JSON.parse(data);
          resolve(packageInfo.version);
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
}

function compareVersions(installed, latest) {
  const installedParts = installed.split('.').map(Number);
  const latestParts = latest.split('.').map(Number);

  for (let i = 0; i < Math.max(installedParts.length, latestParts.length); i++) {
    const installedPart = installedParts[i] || 0;
    const latestPart = latestParts[i] || 0;

    if (latestPart > installedPart) return -1; // Needs update
    if (latestPart < installedPart) return 1; // Installed is newer (shouldn't happen)
  }
  return 0; // Same version
}

async function checkForUpdates(force = false) {
  const installedVersion = getInstalledVersion();
  if (!installedVersion) {
    return null; // Can't determine version
  }

  const cache = getCacheData();
  const now = new Date();

  // Check if we need to refresh (force or cache expired)
  const needsCheck =
    force ||
    !cache.lastCheck ||
    now - cache.lastCheck > CHECK_INTERVAL_MS;

  if (!needsCheck && cache.latestVersion) {
    // Use cached version
    if (compareVersions(installedVersion, cache.latestVersion) < 0) {
      return {
        installed: installedVersion,
        latest: cache.latestVersion,
        needsUpdate: true,
      };
    }
    return null; // Up to date
  }

  // Fetch from npm (non-blocking)
  try {
    const latestVersion = await checkNpmVersion();
    saveCacheData(latestVersion);

    if (compareVersions(installedVersion, latestVersion) < 0) {
      return {
        installed: installedVersion,
        latest: latestVersion,
        needsUpdate: true,
      };
    }
  } catch (error) {
    // If fetch fails, use cache if available
    if (cache.latestVersion && cache.latestVersion !== installedVersion) {
      if (compareVersions(installedVersion, cache.latestVersion) < 0) {
        return {
          installed: installedVersion,
          latest: cache.latestVersion,
          needsUpdate: true,
          fromCache: true,
        };
      }
    }
    // Silently fail - don't annoy users with network errors
  }

  return null;
}

function isGitCheckout(packageRoot = path.join(__dirname, '..')) {
  return fs.existsSync(path.join(path.resolve(packageRoot), '.git'));
}

function getNpmSelfUpdateCommand() {
  return NPM_SELF_UPDATE_COMMAND;
}

function getNpmSelfUpdateSpawnArgs() {
  return {
    command: 'npm',
    args: ['install', '-g', `${PACKAGE_NAME}@latest`],
  };
}

function showUpdateNotification(updateInfo, options = {}) {
  if (!updateInfo || !updateInfo.needsUpdate) return;

  const packageRoot = options.packageRoot || path.join(__dirname, '..');
  const yellow = '\x1b[33m';
  const reset = '\x1b[0m';
  const installHint = isGitCheckout(packageRoot)
    ? 'run: atris upgrade'
    : `run: ${NPM_SELF_UPDATE_COMMAND}`;
  console.log(`${yellow}update available: ${updateInfo.installed} -> ${updateInfo.latest}. ${installHint}${reset}`);
}

function inspectInstallGitState(packageRoot = path.join(__dirname, '..')) {
  const root = path.resolve(packageRoot);
  const inRepo = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (inRepo.status !== 0 || inRepo.stdout.trim() !== 'true') {
    return { isGitRepo: false, root };
  }

  const branchResult = spawnSync('git', ['branch', '--show-current'], {
    cwd: root,
    encoding: 'utf8',
  });
  const statusResult = spawnSync('git', ['status', '--porcelain'], {
    cwd: root,
    encoding: 'utf8',
  });
  const headResult = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  });
  const branch = branchResult.status === 0 ? branchResult.stdout.trim() : '';
  const dirtyEntries = statusResult.status === 0
    ? statusResult.stdout.split('\n').filter((line) => line.trim())
    : [];

  return {
    isGitRepo: true,
    root,
    branch,
    detached: branch === '',
    dirty: dirtyEntries.length > 0,
    dirtyCount: dirtyEntries.length,
    dirtySample: dirtyEntries.slice(0, 5),
    head: headResult.status === 0 ? headResult.stdout.trim() : '',
  };
}

function formatInstallGitWarning(state) {
  if (!state || !state.isGitRepo || (!state.detached && !state.dirty)) return null;
  const flags = [];
  if (state.detached) flags.push(`detached HEAD${state.head ? ` ${state.head}` : ''}`);
  if (state.dirty) flags.push(`dirty worktree (${state.dirtyCount} file${state.dirtyCount === 1 ? '' : 's'})`);
  return `WARNING: Atris is running from a ${flags.join(' + ')} at ${state.root}.\n` +
    'npm install -g atris@latest may not change the code currently on PATH; resolve that checkout before trusting upgrade status.';
}

function normalizeAutoUpdateMode(env = process.env) {
  const raw = String(env.ATRIS_AUTO_UPDATE || '').trim().toLowerCase();
  if (['0', 'false', 'no', 'off', 'notify'].includes(raw)) return 'off';
  if (['1', 'true', 'yes', 'on', 'force'].includes(raw)) return 'force';
  return 'auto';
}

function shouldAutoUpdate(updateInfo, state, env = process.env) {
  if (!updateInfo || !updateInfo.needsUpdate) return false;

  const mode = normalizeAutoUpdateMode(env);
  if (mode === 'off') return false;
  if (mode === 'force') return true;

  const packageRoot = state && state.root ? state.root : path.join(__dirname, '..');
  return !isGitCheckout(packageRoot);
}

function autoUpdate(updateInfo, options = {}) {
  if (!updateInfo || !updateInfo.needsUpdate) return false;

  const env = options.env || process.env;
  const packageRoot = options.packageRoot || path.join(__dirname, '..');
  const installState = options.installState || inspectInstallGitState(packageRoot);
  if (!shouldAutoUpdate(updateInfo, installState, env)) return false;

  const recentlyStarted = options.recentlyStarted || autoUpdateRecentlyStarted;
  if (recentlyStarted(updateInfo.latest)) return false;

  const spawnImpl = options.spawn || spawn;
  const markStarted = options.markStarted || markAutoUpdateStarted;
  const log = options.log || console.log;

  try {
    const child = spawnImpl('npm', ['install', '-g', `${PACKAGE_NAME}@latest`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    if (child && typeof child.on === 'function') child.on('error', () => {});
    if (child && typeof child.unref === 'function') child.unref();
    markStarted(updateInfo.latest);
    log(`Auto-update started: atris ${updateInfo.installed} -> ${updateInfo.latest} (background)`);
    return true;
  } catch (error) {
    return false;
  }
}

module.exports = {
  checkForUpdates,
  showUpdateNotification,
  autoUpdate,
  shouldAutoUpdate,
  inspectInstallGitState,
  formatInstallGitWarning,
  isGitCheckout,
  getNpmSelfUpdateCommand,
  getNpmSelfUpdateSpawnArgs,
};
