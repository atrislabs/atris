'use strict';

const { computeTreeHash } = require('../lib/tree-hash');

function showTreeHelp() {
  console.log('usage: atris tree hash [--json]');
}

function treeCommand(subcommand, ...args) {
  if (['help', '--help', '-h'].includes(subcommand)) {
    showTreeHelp();
    return 0;
  }
  if (subcommand !== 'hash') {
    console.error(`unknown tree command: ${subcommand || ''}`.trim());
    showTreeHelp();
    return 2;
  }

  let result;
  try {
    result = computeTreeHash(process.cwd());
  } catch (error) {
    console.error(`tree hash failed: ${error.message || error}`);
    return 1;
  }
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`${result.short}  ${result.files} files`);
  return 0;
}

module.exports = {
  treeCommand,
};
