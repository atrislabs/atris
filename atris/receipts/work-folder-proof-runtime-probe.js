'use strict';

// Advisory comparison through the real proof runner. Production is unchanged.
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildVerifiedProof } = require('../../lib/task-proof');
const root = path.resolve(__dirname, '../..');
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
const prefix = `export PATH=${quote(path.dirname(process.execPath))}:"$PATH"\n`;
function run(label, command, exit, expected) {
  const result = buildVerifiedProof(command, '', undefined, { cwd: root });
  assert.equal(result.exit, exit, JSON.stringify(result));
  assert.equal(result.ok, exit === 0);
  assert.equal(result.cmd, command);
  if (expected) assert.equal(result.output, expected);
  console.log(`${label}: ${result.output}, exit ${result.exit}`);
}
console.log(`parent runtime: ${process.version}`);
run('current login selection', 'node --version', 0);
run('caller directory after login', prefix + 'node --version', 0, process.version);
const script = 'console.log(JSON.stringify({version:process.version,args:process.argv.slice(1)}))';
run('shell variable and glob', prefix + `PROBE_VALUE='two words'; node -e ${quote(script)} "$PROBE_VALUE" lib/task-proo?.js`, 0,
  JSON.stringify({ version: process.version, args: ['two words', 'lib/task-proof.js'] }));
run('failed child', prefix + `node -e 'console.log("expected failure"); process.exit(7)'`, 7, 'expected failure');
