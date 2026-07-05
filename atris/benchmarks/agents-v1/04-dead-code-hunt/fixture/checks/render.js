'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderTemplate, renderAttr } = require('../render');

test('renders a template with escaped values', () => {
  assert.equal(renderTemplate('<p>{{name}}</p>', { name: '<b>' }), '<p>&lt;b&gt;</p>');
});

test('renders an attribute with escaped values', () => {
  assert.equal(renderAttr('data-id', '1"2'), 'data-id="1&quot;2"');
});
