set -eu
cat > order.js <<'JS'
'use strict';

function lineTotal(quantity, unitCents) {
  return quantity * unitCents;
}

module.exports = { lineTotal };
JS
