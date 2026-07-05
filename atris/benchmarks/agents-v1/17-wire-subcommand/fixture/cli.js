#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const stockPath = path.join(__dirname, 'stock.json');

function loadStock() {
  return JSON.parse(fs.readFileSync(stockPath, 'utf8'));
}

function listStock() {
  for (const row of loadStock()) {
    console.log(`${row.sku}: ${row.qty}`);
  }
}

function main(args = process.argv.slice(2)) {
  if (args[0] !== 'list') {
    console.error('usage: node cli.js list');
    process.exit(2);
  }
  listStock();
}

if (require.main === module) main();

module.exports = { main, loadStock, listStock };
