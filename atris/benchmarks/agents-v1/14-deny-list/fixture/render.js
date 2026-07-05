'use strict';

const { label } = require('./labels');

function renderStatus(code) {
  return label(String(code).toUpperCase());
}

module.exports = { renderStatus };
