'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeGrant } = require('../lib/secret-gateway');

test('grant rejects a relative path prefix without a query string', () => {
  assert.throws(() => normalizeGrant({
    id: 'items-read',
    host: 'api.example.com',
    secretEnv: 'ITEMS_SECRET',
    pathPrefixes: ['v1/items'],
    methods: ['GET', 'HEAD'],
    credentialHeader: 'authorization',
    placeholderEnv: 'ITEMS_API_KEY',
    baseUrlEnv: 'ITEMS_BASE_URL',
  }), /path/i);
});
