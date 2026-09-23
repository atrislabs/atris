'use strict';

const fs = require('fs');
const path = require('path');
const { resolveWorkspaceRoot } = require('../lib/mission-root');
const { loadConfig } = require('./config');

const BACKEND_ROOT_HINT = 'set ATRIS_BACKEND_ROOT to the backend workspace.';

function resolveBackendRoot(cwd = process.cwd()) {
  const workspace = resolveWorkspaceRoot(cwd);
  // ATRIS_BACKEND_DIR is the former spelling, accepted only here.
  const environment = process.env.ATRIS_BACKEND_ROOT || process.env.ATRIS_BACKEND_DIR;
  if (environment) {
    const candidate = path.resolve(environment);
    return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory() ? candidate : null;
  }

  const config = loadConfig(workspace);
  if (typeof config?.backend_root === 'string' && config.backend_root.trim()) {
    const candidate = path.resolve(workspace, config.backend_root);
    return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory() ? candidate : null;
  }

  const sibling = path.resolve(workspace, '..', 'atrisos-backend');
  if (fs.existsSync(sibling) && fs.statSync(sibling).isDirectory()) return sibling;
  const installedSibling = path.resolve(__dirname, '..', '..', 'atrisos-backend');
  return fs.existsSync(installedSibling) && fs.statSync(installedSibling).isDirectory() ? installedSibling : null;
}

module.exports = { BACKEND_ROOT_HINT, resolveBackendRoot };
