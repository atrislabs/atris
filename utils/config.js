const fs = require('fs');
const path = require('path');

/**
 * Get the path to atris/.config in the current project.
 * @returns {string} Config file path
 */
function getConfigPath() {
  const targetDir = path.join(process.cwd(), 'atris');
  return path.join(targetDir, '.config');
}

/**
 * Load config from atris/.config, returning empty object if missing/invalid.
 * @returns {Object} Config object
 */
function loadConfig() {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    const data = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return {};
  }
}

/**
 * Save config to atris/.config. Exits if atris/ folder doesn't exist.
 * @param {Object} config - Config object to save
 */
function saveConfig(config) {
  const configPath = getConfigPath();
  const targetDir = path.dirname(configPath);

  if (!fs.existsSync(targetDir)) {
    console.error('✗ Error: atris/ folder not found. Run "atris init" first.');
    process.exit(1);
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

/**
 * Get the path to atris/.log_sync_state.json for tracking sync timestamps.
 * @returns {string} Log sync state file path
 */
function getLogSyncStatePath() {
  const targetDir = path.join(process.cwd(), 'atris');
  return path.join(targetDir, '.log_sync_state.json');
}

/**
 * Load log sync state, returning empty object if missing/invalid.
 * @returns {Object} Sync state object with last sync timestamps
 */
function loadLogSyncState() {
  const statePath = getLogSyncStatePath();
  if (!fs.existsSync(statePath)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Save log sync state to atris/.log_sync_state.json.
 * @param {Object} state - Sync state object to save
 */
function saveLogSyncState(state) {
  const statePath = getLogSyncStatePath();
  const targetDir = path.dirname(statePath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

module.exports = {
  getConfigPath,
  loadConfig,
  saveConfig,
  getLogSyncStatePath,
  loadLogSyncState,
  saveLogSyncState,
};
