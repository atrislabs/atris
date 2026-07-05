'use strict';

const { EventEmitter } = require('../emitter-legacy');

const tracker = new EventEmitter();

function track(message) {
  tracker.emit('track', message);
}

module.exports = { track };
