const { ensureWorkspaceBrain, workspaceBrainPresent } = require('../lib/workspace-scaffold');

function printInstallUsage(stream = console.log) {
  stream('Usage: atris install');
  stream('alias: atris workspace install');
  stream('');
  stream('installs the atris/ brain into the current directory if missing.');
}

function installCommand(args = [], { verb } = {}) {
  const sub = args[0];
  if (verb === 'workspace' && sub && sub !== 'install' && sub !== '-h' && sub !== '--help' && sub !== 'help') {
    console.error('Usage: atris workspace install');
    process.exit(1);
  }

  const flags = verb === 'workspace' && sub === 'install' ? args.slice(1) : args;
  if (flags[0] === '-h' || flags[0] === '--help' || flags[0] === 'help') {
    printInstallUsage();
    return 0;
  }

  const root = process.cwd();
  if (workspaceBrainPresent(root)) {
    console.log('Atris already installed.');
    return 0;
  }

  const { created } = ensureWorkspaceBrain(root);
  if (created.length === 0) {
    console.log('Atris already installed.');
    return 0;
  }
  for (const rel of created) {
    console.log(rel);
  }
  return 0;
}

module.exports = { installCommand };
