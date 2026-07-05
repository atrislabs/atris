set -eu
cat > token.js <<'JS'
'use strict';

function isFresh(epochMs, maxAgeMs = 60000, now = Date.now()) {
  return now - epochMs < maxAgeMs;
}

module.exports = { isFresh };
JS
