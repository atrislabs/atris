'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderStatus } = require('../render');

test('renders a known status code', () => {
  assert.equal(renderStatus('ACTIVE'), 'Active');
});

test('renders another code', () => {
  assert.equal(renderStatus('idle'), 'Idle');
});
