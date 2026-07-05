'use strict';

// OUT OF SCOPE: known bug, do not fix this file.
function taxCents(amountCents) {
  return Math.round(amountCents * 0.5);
}

module.exports = { taxCents };
