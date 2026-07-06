'use strict';

/**
 * atris rainmaker — passthrough to atrisos-backend/scripts/rainmaker.py
 *
 *   atris rainmaker              # ASCII status dashboard
 *   atris rainmaker instinct     # one morning opinion
 *   atris rainmaker batting      # accuracy scorecard
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function resolveBackendRoot() {
  const candidates = [
    process.env.ATRIS_BACKEND_DIR,
    path.resolve(__dirname, '..', '..', 'atrisos-backend'),
    path.resolve(process.cwd(), '..', 'atrisos-backend'),
    path.join(os.homedir(), 'arena', 'atrisos-backend'),
  ].filter(Boolean);
  for (const root of candidates) {
    if (fs.existsSync(path.join(root, 'scripts', 'rainmaker.py'))) return root;
  }
  return null;
}

function rainmakerCommand(args = []) {
  if (args[0] === '--help' || args[0] === '-h') {
    console.log('Usage: atris rainmaker [args...]\n\nPassthrough to python3 scripts/rainmaker.py in atrisos-backend.');
    return 0;
  }
  const root = resolveBackendRoot();
  if (!root) {
    console.error('Cannot find scripts/rainmaker.py. Set ATRIS_BACKEND_DIR to atrisos-backend.');
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
