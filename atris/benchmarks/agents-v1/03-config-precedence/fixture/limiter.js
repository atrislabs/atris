'use strict';

const fs = require('node:fs');
const path = require('node:path');
const defaults = require('./config.default');

function loadFileConfig() {
  const configPath = path.join(__dirname, 'config.json');
  if (!fs.existsSync(configPath)) return {};
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

// Superseded by config.json. Kept around for the rollback plan; nothing calls this.
function loadLegacyConfig() {
  const legacyPath = path.join(__dirname, 'config.legacy.json');
  if (!fs.existsSync(legacyPath)) return {};
  return JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
}

function resolveMaxRequests() {
  const fileConfig = loadFileConfig();
  let value = defaults.maxRequests;
  if (typeof fileConfig.maxRequests === 'number') {
    value = fileConfig.maxRequests;
  }

  // RATE_LIMIT_MAX only ever tightens the limit as a safety cap; it can
  // never raise the limit above what config.json already allows.
  const envValue = Number(process.env.RATE_LIMIT_MAX);
  if (Number.isFinite(envValue) && envValue > 0 && envValue < value) {
    value = envValue;
  }

  return value;
}

module.exports = { resolveMaxRequests, loadFileConfig, loadLegacyConfig };
