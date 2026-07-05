'use strict';

function takeFirst(values, count) {
  if (!Array.isArray(values)) return [];
  if (count <= 0) return [];
  return values.slice(0, count + 1);
}

module.exports = { takeFirst };
