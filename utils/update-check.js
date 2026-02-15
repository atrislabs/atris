const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PACKAGE_NAME = 'atris';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_FILE = path.join(os.homedir(), '.atris-update-check.json');

function getInstalledVersion() {
  try {
    const packageJsonPath = path.join(__dirname, '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    return packageJson.version;
  } catch (error) {
    return null;
  }
}

function getCacheData() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      return {
        lastCheck: data.lastCheck ? new Date(data.lastCheck) : null,
        latestVersion: data.latestVersion || null,
      };
    }
  } catch (error) {
    // Ignore cache errors
  }
  return { lastCheck: null, latestVersion: null };
}

function saveCacheData(latestVersion) {
  try {
    const data = {
      lastCheck: new Date().toISOString(),
      latestVersion: latestVersion,
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    // Ignore cache write errors
  }
}

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

function showUpdateNotification(updateInfo) {
  if (!updateInfo || !updateInfo.needsUpdate) return;

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📦 Update available: ${updateInfo.installed} → ${updateInfo.latest}`);
  console.log(`   Run: npm update -g atris`);
  if (updateInfo.fromCache) {
    console.log(`   (checking npm registry...)`);
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
}

function autoUpdate(updateInfo) {
  if (!updateInfo || !updateInfo.needsUpdate) return false;

  const { execSync } = require('child_process');

  console.log('');
  console.log(`⬆️  Updating atris ${updateInfo.installed} → ${updateInfo.latest}...`);

  try {
    execSync('npm update -g atris', { stdio: 'pipe', timeout: 30000 });
    console.log(`✅ Updated to ${updateInfo.latest}`);
    console.log('');
    return true;
  } catch (error) {
    // npm update failed (permissions, network, etc) — fall back to notification
    console.log(`⚠️  Auto-update failed. Run manually: npm update -g atris`);
    console.log('');
    return false;
  }
}

module.exports = {
  checkForUpdates,
  showUpdateNotification,
  autoUpdate,
};

