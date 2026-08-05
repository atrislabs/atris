'use strict';

const [, , command, ...args] = process.argv;

if (command === 'add') {
  console.log(`added ${args[0] || 'item'}`);
} else if (command === 'list') {
  console.log('one');
  console.log('two');
} else {
  console.error(`unknown command: ${command}`);
}
