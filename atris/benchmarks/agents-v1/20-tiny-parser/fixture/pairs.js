'use strict';

function parsePairs(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [key, value] = line.split('=');
    out[key] = value;
  }
  return out;
}

module.exports = { parsePairs };
