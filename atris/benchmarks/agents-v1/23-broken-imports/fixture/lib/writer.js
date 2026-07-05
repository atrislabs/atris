'use strict';

const { readRows } = require('./reader');

function normalizeRow(cells) {
  return cells.map((c) => c.trim());
}

function writeChunk(rows) {
  return rows.map((r) => r.join(',')).join('\n');
}

module.exports = { normalizeRow, writeChunk, readRows };
