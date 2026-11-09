'use strict';

/**
 * Heavy jobs take turns, so agents running full test suites or benchmarks at
 * the same time do not run the machine out of memory.
 *
 *   atris heavy                    # who is running a heavy job now
 *   atris heavy -- <command...>    # run a command once a turn is free
 */

const { gateSettings, listSlots, runHeavy } = require('../lib/heavy-gate');

const HELP = `atris heavy: big jobs take turns so the machine never runs out of memory

  atris heavy                    who is running a heavy job now
  atris heavy -- <command...>    run a command once a turn is free

At most ATRIS_HEAVY_SLOTS jobs (default 2) run at once. New jobs also wait
while free memory is under 20 percent. No job waits more than 30 minutes.`;

async function heavyCommand(args = []) {
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    console.log(HELP);
    return 0;
  }
  const sep = args.indexOf('--');
  const argv = sep >= 0 ? args.slice(sep + 1) : args;
  if (argv.length) return runHeavy(argv);

  const settings = gateSettings();
  const held = listSlots(settings);
  if (!held.length) {
    console.log(`No heavy jobs running. ${settings.slots} turns free.`);
    return 0;
  }
  console.log(`${held.length} of ${settings.slots} turns in use:`);
  for (const h of held) console.log(`  ${h.cmd}  (since ${h.at}, in ${h.cwd})`);
  return 0;
}

module.exports = { heavyCommand };
