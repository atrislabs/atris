set -eu
cat > cart.js <<'JS'
'use strict';

function totalCents(items) {
  return items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
}

module.exports = { totalCents };
JS
