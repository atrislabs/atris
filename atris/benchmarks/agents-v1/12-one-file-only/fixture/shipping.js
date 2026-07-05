'use strict';

const { lookup } = require('./regions');

function shippingCents(weightOz, regionCode) {
  const { ratePerOz, freeAtOz } = lookup(regionCode);
  if (weightOz > freeAtOz) return 0;
  return Math.round(weightOz * ratePerOz);
}

module.exports = { shippingCents };
