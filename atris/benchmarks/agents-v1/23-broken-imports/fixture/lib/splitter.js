'use strict';

const writer = require('./writer');
const reader = require('./reader');

function splitFile(filePath, chunkSize = 2) {
  const rows = writer.readRows(filePath);
  const chunks = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    chunks.push(writer.writeChunk(rows.slice(i, i + chunkSize)));
  }
  return chunks;
}

module.exports = { splitFile };
