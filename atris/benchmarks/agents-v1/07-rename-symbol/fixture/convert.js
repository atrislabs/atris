'use strict';

function toMeters(value, unit) {
  const factors = { m: 1, km: 1000, ft: 0.3048, mi: 1609.34 };
  const factor = factors[unit];
  if (!factor) throw new Error(`unknown unit: ${unit}`);
  return value * factor;
}

module.exports = { toMeters };
