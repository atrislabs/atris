set -eu
cat > cli.js <<'JS'
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

function statsStock() {
  const rows = loadStock();
  const quantity = rows.reduce((sum, row) => sum + row.qty, 0);
  console.log(JSON.stringify({ items: rows.length, quantity }));
}

function main(args = process.argv.slice(2)) {
  if (args[0] === 'list') return listStock();
  if (args[0] === 'stats') return statsStock();
  console.error('usage: node cli.js <list|stats>');
  process.exit(2);
}

if (require.main === module) main();

module.exports = { main, loadStock, statsStock };
JS
