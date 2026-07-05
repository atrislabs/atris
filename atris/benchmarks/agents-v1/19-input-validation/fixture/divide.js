#!/usr/bin/env node
'use strict';

function main(args = process.argv.slice(2)) {
  const dividend = Number(args[0]);
  const divisor = Number(args[1]);
  console.log(String(dividend / divisor));
}

if (require.main === module) main();

module.exports = { main };
