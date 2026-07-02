#!/usr/bin/env node
const { printOperatorNext } = require('./operator-next');

console.log('');
console.log('Atris installed.');
if (process.env.npm_config_global === 'true') {
  printOperatorNext('cd your-project && atris init');
} else {
  printOperatorNext('npx atris init');
}
console.log('');
