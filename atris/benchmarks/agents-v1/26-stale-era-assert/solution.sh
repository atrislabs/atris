set -eu
cat > checks/report.js <<'JS'
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { statusLine } = require('../report');

test('formats a job status line', () => {
  assert.equal(statusLine({ name: 'build', state: 'green' }), 'build: green');
});
JS
