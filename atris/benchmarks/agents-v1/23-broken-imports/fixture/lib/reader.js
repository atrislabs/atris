'use strict';

const fs = require('node:fs');
const writer = require('./writer');

function readRows(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').trim();
  return text.split('\n').map((line) => writer.normalizeRow(line.split(',')));
}

module.exports = { readRows };
