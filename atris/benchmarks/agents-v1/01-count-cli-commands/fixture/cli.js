'use strict';

require('./commands/core');
require('./commands/extra');
const { commands } = require('./registry');

const name = process.argv[2];
if (!name || !commands.has(name)) {
  console.error('unknown command');
  process.exit(2);
}
console.log(commands.get(name)());
