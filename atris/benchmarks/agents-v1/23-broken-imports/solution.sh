set -eu
cat > index.js <<'JS'
'use strict';

const { splitFile } = require('./lib/splitter');

const filePath = process.argv[2];
const chunks = splitFile(filePath);
console.log(JSON.stringify(chunks));
JS
cat > lib/splitter.js <<'JS'
'use strict';

const writer = require('./writer');
const reader = require('./reader');

function splitFile(filePath, chunkSize = 2) {
  const rows = reader.readRows(filePath);
  const chunks = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    chunks.push(writer.writeChunk(rows.slice(i, i + chunkSize)));
  }
  return chunks;
}

module.exports = { splitFile };
JS
cat > lib/writer.js <<'JS'
'use strict';

function normalizeRow(cells) {
  return cells.map((c) => c.trim());
}

function writeChunk(rows) {
  return rows.map((r) => r.join(',')).join('\n');
}

module.exports = { normalizeRow, writeChunk };
JS
