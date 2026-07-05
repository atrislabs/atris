'use strict';

const REGIONS = {
  west: { ratePerOz: 12, freeAtOz: 16 },
  east: { ratePerOz: 10, freeAtOz: 20 },
};

function lookup(code) {
  return REGIONS[code];
}

module.exports = { lookup };
