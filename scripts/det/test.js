#!/usr/bin/env node
// det/test.js — self-test for the deterministic task scripts.
// Zero deps, exits non-zero on any failure so CI and agents can trust the lib.
'use strict';

const assert = require('assert');
const { extract } = require('./extract');
const { run } = require('./json');

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

// --- json.js ---
check('json.pretty', run('pretty', '{"a":1}'), { text: '{\n  "a": 1\n}' });
check('json.min', run('min', '{ "a" : 1 }'), { text: '{"a":1}' });
check('json.validate.ok', run('validate', '[1,2,3]'), { text: 'valid' });
check('json.validate.bad', run('validate', '{bad}').error !== undefined, true);
check('json.keys', run('keys', '{"a":1,"b":2}'), { text: 'a\nb' });
// csv: header from first-seen key order, proper RFC-4180 quoting of commas/quotes
check(
  'json.csv',
  run('csv', '[{"name":"a, b","n":1},{"name":"c\\"d","n":2}]'),
  { text: 'name,n\n"a, b",1\n"c""d",2' }
);
check('json.csv.notArray', run('csv', '{"a":1}').error !== undefined, true);
check('json.badMode', run('nope', '{}').error !== undefined, true);

console.log(`ok — ${passed} checks passed`);
