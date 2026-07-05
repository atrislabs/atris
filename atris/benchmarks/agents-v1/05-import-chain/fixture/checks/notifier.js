'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bus } = require('../services/bus');
const { notify } = require('../services/notifier');

test('notify emits on the shared bus', () => {
  let received = null;
  bus.on('notify', (msg) => {
    received = msg;
  });
  notify('hello');
  assert.equal(received, 'hello');
});
