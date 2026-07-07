#!/usr/bin/env node
// det/test.js — self-test for the deterministic task scripts.
// Zero deps, exits non-zero on any failure so CI and agents can trust the lib.
'use strict';

const assert = require('assert');
const { extract } = require('./extract');

let passed = 0;
function check(name, actual, expected) {
  assert.deepStrictEqual(actual, expected, name);
  passed += 1;
}

// urls: strip trailing punctuation, dedupe, keep order
check(
  'urls',
  extract('urls', 'see https://a.com/x. and http://b.io, then https://a.com/x again'),
  ['https://a.com/x', 'http://b.io']
);

check('emails', extract('emails', 'a@b.com and c@d.co and a@b.com'), ['a@b.com', 'c@d.co']);

check(
  'code',
  extract('code', 'text\n```js\nconst x = 1;\n```\nmore\n```\nplain\n```'),
  ['const x = 1;', 'plain']
);

check('numbers', extract('numbers', 'got 1,234 items at 9.5 each, -3 lost'), ['1,234', '9.5', '-3']);

check('ipv4', extract('ipv4', 'from 192.168.0.1 not 999.1.1.1'), ['192.168.0.1']);

check('hashtags', extract('hashtags', 'ship #atris and #det #atris'), ['#atris', '#det']);

// unknown kind -> null
check('unknown', extract('nope', 'x'), null);

// empty input -> empty list
check('empty', extract('urls', ''), []);

console.log(`ok — ${passed} checks passed`);
