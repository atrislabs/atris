#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

function main(args = process.argv.slice(2)) {
  if (args[0] !== 'count' || !args[1]) {
    console.error('usage: node cli.js count <file>');
    process.exit(2);
  }

  const text = fs.readFileSync(args[1], 'utf8').trim();
  const words = text ? text.split(/\s+/).length : 0;
  console.log(`words: ${words}`);
}

if (require.main === module) main();

module.exports = { main };
