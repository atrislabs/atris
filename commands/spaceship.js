/**
 * atris spaceship — bounded, self-reporting overnight runner.
 *
 * Thin wrapper over scripts/spaceship.sh. The script is the implementation
 * (a supervised loop that survives bad ticks and emails Keshav on every
 * meaningful state change); this module just makes it reachable as
 * `atris spaceship ...` and integrates with the CLI's command dispatch.
 *
 * Examples:
 *   atris spaceship --hours 4
 *   atris spaceship --hours 4 --repo /path/to/repo --interval 780
 *   atris spaceship --hours 0.01 --tick-cmd /tmp/stub.sh --no-email   # test
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'spaceship.sh');

function spaceship(args = []) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(SCRIPT)) {
      reject(new Error(`spaceship.sh not found at ${SCRIPT}`));
      return;
    }
    const child = spawn('bash', [SCRIPT, ...args], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ success: true });
      else reject(new Error(`spaceship exited with code ${code}`));
    });
  });
}

module.exports = { spaceship, SCRIPT };
