'use strict';

// Pre-build control through the actual receipt writer, not a production repair.
// Keeps disposable evidence under atris/runs and removes nothing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { writeTaskReceipt } = require('../../lib/task-receipt');

const root = path.resolve(__dirname, '../..');
const runs = path.join(root, 'atris/runs');
fs.mkdirSync(runs, { recursive: true });
const fixture = fs.mkdtempSync(path.join(runs, "completion shell's "));
const executable = path.join(fixture, "parent node's binary");
fs.symlinkSync(process.execPath, executable);
for (const name of ['alpha.js', 'beta.js']) fs.writeFileSync(path.join(fixture, name), '');
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
const node = quote(executable);
const cases = [
  ['unusual executable path', `${node} --version`, 0, process.version],
  ['quoted arguments', `${node} -e ${quote('console.log(JSON.stringify(process.argv.slice(1)))')} -- ${quote('two words')} ${quote("apostrophe's value")} ${quote('$HOME; `literal`')}`, 0, JSON.stringify(['two words', "apostrophe's value", '$HOME; `literal`'])],
  ['glob expansion', `${node} -e ${quote('console.log(process.argv.slice(1).map(p => require("node:path").basename(p)).sort().join(","))')} -- ${quote(fixture)}/*.js`, 0, 'alpha.js,beta.js'],
  ['shell suffix', `${node} -e ${quote('process.exit(0)')} && printf '%s' 'shell suffix retained'`, 0, 'shell suffix retained'],
  ['non-node command', "printf '%s' 'ordinary shell retained'", 0, 'ordinary shell retained'],
  ['child failure', `${node} -e ${quote('console.log("child failure retained"); process.exit(7)')}`, 7, 'child failure retained'],
];
for (const [name, command, exit, output] of cases) {
  const result = writeTaskReceipt({ taskId: `completion-shell-${name}`, command, root });
  assert.equal(result.exit, exit, `${name}: ${result.error || result.output}`);
  assert.equal(result.output, output, name);
  assert.equal(result.passed, exit === 0, name);
  const saved = JSON.parse(fs.readFileSync(result.receiptFile, 'utf8'));
  assert.equal(saved.command, command, name);
  assert.equal(saved.result.exit, exit, name);
  assert.equal(saved.result.passed, exit === 0, name);
  assert.equal(saved.result.output, output, name);
  console.log(`${name}: ${result.output}, exit ${result.exit}, receipt retained`);
}
console.log('control only: production node selection remains unchanged');
