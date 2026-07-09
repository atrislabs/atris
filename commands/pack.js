'use strict';

const {
  bundlePack,
  installPack,
  listInstalledPacks,
  parsePackArgs,
  showPackHelp,
} = require('../lib/pack-cli');

async function packCommand(args = [], cwd = process.cwd()) {
  const parsed = parsePackArgs(args);
  if (parsed.help || !parsed.subcommand) {
    showPackHelp();
    return 0;
  }

  if (parsed.subcommand === 'install') {
    if (!parsed.target) {
      console.error('usage: atris pack install <slug|zip|url> [--dir <path>]');
      return 2;
    }
    await installPack(parsed.target, { cwd, dir: parsed.dir || null });
    return 0;
  }

  if (parsed.subcommand === 'bundle') {
    bundlePack(parsed.target, { cwd });
    return 0;
  }

  if (parsed.subcommand === 'list') {
    listInstalledPacks(cwd);
    return 0;
  }

  console.error(`unknown pack subcommand: ${parsed.subcommand}`);
  showPackHelp();
  return 2;
}

function packAtris() {
  const args = process.argv.slice(3);
  packCommand(args, process.cwd())
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err.message || String(err));
      process.exit(1);
    });
}

module.exports = {
  packAtris,
  packCommand,
};
