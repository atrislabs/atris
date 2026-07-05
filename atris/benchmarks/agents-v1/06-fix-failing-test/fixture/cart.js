'use strict';

function totalCents(items) {
  return items.reduce((sum, item) => sum + item.priceCents, 0);
}

module.exports = { totalCents };
