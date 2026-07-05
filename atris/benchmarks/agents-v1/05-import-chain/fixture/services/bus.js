'use strict';

const { EventEmitter } = require('../emitter-core');

const bus = new EventEmitter();

module.exports = { bus };
