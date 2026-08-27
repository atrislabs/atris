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
 * Without --yes, spaceship only talks the keep-working plan (no email, no run).
 * `--json` without --yes prints a JSON refuse and still does not start.
 * `--yes` from an unbound scratch folder refuses: that folder is not a room.
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { hasYesFlag, argsWantHelp, wantsJson } = require('../lib/noninteractive');
const { isUnboundScratchFolder, refuseUnboundScratch } = require('../lib/scratch-root');
const { resolveWorkspaceRoot } = require('../lib/mission-root');
const { personName } = require('../lib/first-minute');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'spaceship.sh');

function greet(person) {
  return person ? `hey ${person}, ` : '';
}

function readFlagValue(args, name) {
  const list = Array.isArray(args) ? args : [];
  const idx = list.indexOf(name);
  const raw = idx !== -1 && list[idx + 1] && !String(list[idx + 1]).startsWith('-')
    ? String(list[idx + 1]).trim()
    : '';
  return raw;
}

function spokenHours(raw) {
  const text = raw === undefined || raw === null ? '4' : String(raw).trim();
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) return '4 hours';
  if (n === 1) return `${text} hour`;
  return `${text} hours`;
}

function printUsage() {
  const lines = [
    'Usage: atris spaceship [--hours N] [--interval SEC] [--repo PATH]',
    '                       [--tick-cmd CMD] [--tick-timeout SEC]',
    '                       [--idle-alert N] [--halt-alert N] [--label NAME]',
    '                       [--no-email] [--yes]',
    '',
    "Keep working here for a few hours. I'll write you if something changes.",
    'Without --yes, I only say the plan. --no-email stays quiet.',
  ];
  console.log(lines.join('\n'));
}

function planLines(args = []) {
  const list = Array.isArray(args) ? args : [];
  const hours = spokenHours(readFlagValue(list, '--hours') || '4');
  const next = list.includes('--no-email')
    ? 'next: atris spaceship --yes'
    : "I'll write you if something changes. next: atris spaceship --yes";
  return [
    `${greet(personName())}I can keep working here for ${hours}.`,
    '',
    next,
  ];
}

function spaceshipTargetRoot(args = []) {
  const list = Array.isArray(args) ? args : [];
  const idx = list.indexOf('--repo');
  const raw = idx !== -1 && list[idx + 1] && !String(list[idx + 1]).startsWith('-')
    ? path.resolve(list[idx + 1])
    : process.cwd();
  return resolveWorkspaceRoot(raw);
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

  // --yes starts the run. It is not a workspace unlock. An unbound
  // scratch folder is not a room (same class as slack/gmail from scratch).
  if (isUnboundScratchFolder(spaceshipTargetRoot(list))) {
    process.exit(refuseUnboundScratch());
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

module.exports = { spaceship, SCRIPT, printUsage, planLines, spokenHours, spaceshipTargetRoot };
