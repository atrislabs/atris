set -eu
cat > cli.js <<'JS'
#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const args = process.argv.slice(2);
const json = args.includes('--json');
const cleanArgs = args.filter((arg) => arg !== '--json');

if (cleanArgs[0] !== 'count' || !cleanArgs[1]) {
  console.error('usage: node cli.js count <file> [--json]');
  process.exit(2);
}

const text = fs.readFileSync(cleanArgs[1], 'utf8').trim();
const words = text ? text.split(/\s+/).length : 0;

if (json) {
  console.log(JSON.stringify({ words }));
} else {
  console.log(`words: ${words}`);
}
JS
