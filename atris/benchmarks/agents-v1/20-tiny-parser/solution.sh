set -eu
cat > pairs.js <<'JS'
'use strict';

function parsePairs(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const splitAt = line.indexOf('=');
    if (splitAt === -1) continue;
    const key = line.slice(0, splitAt).trim();
    const value = line.slice(splitAt + 1).trim();
    out[key] = value;
  }
  return out;
}

module.exports = { parsePairs };
JS
