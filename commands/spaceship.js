'use strict';

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

function printUsage() {
  const lines = [
    'Usage: atris spaceship [--hours N] [--interval SEC] [--repo PATH]',
    '                       [--tick-cmd CMD] [--tick-timeout SEC]',
    '                       [--idle-alert N] [--halt-alert N] [--label NAME]',
    '                       [--no-email]',
    '',
    'Bounded overnight runner. Survives bad ticks and emails on state changes.',
    'Defaults: --hours 4, --interval 780, tick = atris autopilot --auto --iterations=1',
  ];
  console.log(lines.join('\n'));
}

function spaceship(args = []) {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return Promise.resolve({ success: true, help: true });
  }

  return new Promise((resolve, reject) => {
    if (!fs.existsSync(SCRIPT)) {
      reject(new Error(`spaceship.sh not found at ${SCRIPT}`));
      return;
    }
    const env = { ...process.env };
    if (!process.stdout.isTTY) {
      env.NO_COLOR = '1';
      env.CLICOLOR = '0';
      env.FORCE_COLOR = '0';
    }
    const child = spawn('bash', [SCRIPT, ...args], {
      stdio: 'inherit',
      env,
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ success: true });
      else reject(new Error(`spaceship exited with code ${code}`));
    });
  });
}

module.exports = { spaceship, SCRIPT, printUsage };
