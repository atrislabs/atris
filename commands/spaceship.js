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
 *   atris spaceship --hours 4 --yes
 *   atris spaceship --hours 4 --repo /path/to/repo --interval 780 --yes
 *   atris spaceship --hours 0.01 --tick-cmd /tmp/stub.sh --no-email --yes
 *
 * Without --yes, spaceship only prints the plan (no email, no overnight run).
 * `--json` without --yes prints a JSON refuse and still does not start.
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { hasYesFlag, argsWantHelp, wantsJson } = require('../lib/noninteractive');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'spaceship.sh');

function printUsage() {
  const lines = [
    'Usage: atris spaceship [--hours N] [--interval SEC] [--repo PATH]',
    '                       [--tick-cmd CMD] [--tick-timeout SEC]',
    '                       [--idle-alert N] [--halt-alert N] [--label NAME]',
    '                       [--no-email] [--yes]',
    '',
    'Bounded overnight runner. Survives bad ticks and emails on state changes.',
    'Without --yes, prints the plan only (no email, no overnight run).',
    'Defaults: --hours 4, --interval 780, tick = atris autopilot --auto --iterations=1',
  ];
  console.log(lines.join('\n'));
}

function planLines(args = []) {
  const hoursIdx = args.indexOf('--hours');
  const hours = hoursIdx !== -1 && args[hoursIdx + 1] ? args[hoursIdx + 1] : '4';
  return [
    'spaceship plan (no run):',
    `  budget: ${hours}h`,
    '  email: on meaningful state changes (unless --no-email)',
    '  tick: atris autopilot --auto --iterations=1',
    'Pass --yes to start the overnight run.',
  ];
}

function spaceship(args = []) {
  const list = Array.isArray(args) ? args : [];
  if (argsWantHelp(list) || list.includes('--help') || list.includes('-h')) {
    printUsage();
    return Promise.resolve({ success: true, help: true });
  }

  // Same proceed-flag gate as autopilot: --json is not consent, --once is
  // not consent. Only --yes / -y start the overnight run.
  if (wantsJson(list) && !hasYesFlag(list)) {
    console.log(JSON.stringify({
      ok: false,
      command: 'spaceship',
      running: false,
      error: 'pass --yes to start',
      usage: 'atris spaceship [--yes|--auto] [--once]',
    }, null, 2));
    process.exit(2);
  }

  if (!hasYesFlag(list)) {
    for (const line of planLines(list)) console.log(line);
    process.exit(2);
  }

  const runArgs = list.filter((a) => a !== '--yes' && a !== '-y' && a !== '--json');
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
    const child = spawn('bash', [SCRIPT, ...runArgs], {
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

module.exports = { spaceship, SCRIPT, printUsage, planLines };
