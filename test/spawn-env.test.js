const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { envWithNodeDir } = require('../lib/spawn-env');

test('envWithNodeDir prepends the node directory when PATH lacks it', () => {
  const env = envWithNodeDir({ PATH: '/usr/bin:/bin', HOME: '/tmp' });
  const nodeDir = path.dirname(process.execPath);
  assert.ok(env.PATH.startsWith(`${nodeDir}${path.delimiter}`));
  assert.equal(env.HOME, '/tmp');
});

test('envWithNodeDir leaves env untouched when PATH already carries node', () => {
  const nodeDir = path.dirname(process.execPath);
  const base = { PATH: `${nodeDir}:/usr/bin` };
  assert.equal(envWithNodeDir(base), base);
});
