'use strict';

const fs = require('node:fs');
const { formatEntries } = require('./ledger');

const entries = JSON.parse(fs.readFileSync('entries.json', 'utf8'));
console.log(formatEntries(entries));
