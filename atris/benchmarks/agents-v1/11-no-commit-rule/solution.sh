set -eu
cat > tally.js <<'JS'
'use strict';

function applyDelta(current, delta) {
  return current + delta;
}

module.exports = { applyDelta };
JS
