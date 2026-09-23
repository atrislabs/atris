'use strict';

/**
 * atris rainmaker, passthrough to atrisos-backend/scripts/rainmaker.py
 *
 *   atris rainmaker              # ASCII status dashboard
 *   atris rainmaker instinct     # one morning opinion
 *   atris rainmaker batting      # accuracy scorecard
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { BACKEND_ROOT_HINT, resolveBackendRoot } = require('../utils/backend-root');

function rainmakerCommand(args = []) {
  if (args[0] === '--help' || args[0] === '-h') {
    console.log('Usage: atris rainmaker [args...]\n\nPassthrough to python3 scripts/rainmaker.py in atrisos-backend.');
    return 0;
  }
  const root = resolveBackendRoot();
  if (!root || !fs.existsSync(path.join(root, 'scripts', 'rainmaker.py'))) {
    console.error(BACKEND_ROOT_HINT);
    return 1;
  }
  const script = path.join(root, 'scripts', 'rainmaker.py');
  const py = process.env.ATRIS_PYTHON || 'python3';
  const result = spawnSync(py, [script, ...args], { cwd: root, stdio: 'inherit', env: process.env });
  if (result.error) {
    console.error(`Failed to spawn ${py}: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

module.exports = { rainmakerCommand, resolveBackendRoot };
