'use strict';

const fs = require('fs');
const guard = require('../lib/claude-spend-guard');

function showSpendHelp() {
  console.log('usage: atris spend guard [install|uninstall|status]');
  console.log('       atris spend log [--limit N]');
  console.log('');
  console.log('The guard stops unattended Claude runs on paid models (anything but Haiku)');
  console.log(`unless ${guard.APPROVAL_ENV}=<model> names the model for that run.`);
  console.log('It also stops unattended runs that carry a pay-per-use Anthropic key.');
  console.log('Interactive Claude sessions are never blocked.');
}

function printStatus(status) {
  if (!status.readable) {
    console.log(`guard: unknown, could not read ${status.settings}`);
    return;
  }
  console.log(status.installed ? 'guard: on' : 'guard: off');
  console.log(`settings: ${status.settings}`);
  console.log(`hook: ${status.script}`);
}

function guardCommand(action = 'status') {
  if (action === 'install') {
    const status = guard.installGuard();
    printStatus(status);
    if (status.installed) {
      console.log('Unattended Claude runs on paid models now need a yes on this computer.');
    }
    return status.installed ? 0 : 1;
  }
  if (action === 'uninstall') {
    printStatus(guard.uninstallGuard());
    return 0;
  }
  if (action === 'status') {
    const status = guard.guardStatus();
    printStatus(status);
    return status.installed ? 0 : 1;
  }
  showSpendHelp();
  return 1;
}

function logCommand(args) {
  const i = args.indexOf('--limit');
  const limit = i >= 0 ? Math.max(1, Number(args[i + 1]) || 20) : 20;
  const file = guard.ledgerPath();
  if (!fs.existsSync(file)) {
    console.log('no guard decisions recorded on this computer.');
    return 0;
  }
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-limit);
  for (const line of rows) {
    try {
      const r = JSON.parse(line);
      console.log(`${r.ts}  ${r.decision}  ${r.model}  ${r.job || ''}  ${r.cwd || ''}`.trimEnd());
    } catch {}
  }
  return 0;
}

function spendCommand(args = []) {
  const [sub, ...rest] = args;
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    showSpendHelp();
    return sub ? 0 : 1;
  }
  if (sub === 'guard') return guardCommand(rest[0] || 'status');
  if (sub === 'log') return logCommand(rest);
  showSpendHelp();
  return 1;
}

module.exports = { spendCommand };
