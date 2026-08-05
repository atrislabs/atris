'use strict';

function backoffMs(attempt) {
  return 100 * attempt;
}

module.exports = { backoffMs };
