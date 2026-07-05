'use strict';

const fs = require('node:fs');
const { extractHeadings, lastHeadingLevel } = require('./scan');

const file = process.argv[2];
const text = fs.readFileSync(file, 'utf8');
console.log(JSON.stringify({ headings: extractHeadings(text), lastLevel: lastHeadingLevel(text) }));
