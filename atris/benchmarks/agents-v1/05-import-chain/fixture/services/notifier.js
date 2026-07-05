'use strict';

const { bus } = require('./bus');

function notify(message) {
  bus.emit('notify', message);
}

module.exports = { notify };
