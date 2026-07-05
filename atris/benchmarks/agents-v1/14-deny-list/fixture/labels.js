'use strict';

const LABELS = {
  active: 'Active',
  idle: 'Idle',
};

function label(code) {
  return LABELS[code];
}

module.exports = { label };
