'use strict';

function isFresh(epochMs, maxAgeMs = 60000) {
  return Date.now() - epochMs > maxAgeMs;
}

module.exports = { isFresh };
