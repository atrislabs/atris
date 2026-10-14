'use strict';

// Diagnostic candidates only. Production receipt execution remains unchanged.
// Uses the real receipt writer and retains evidence; removes no folders.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { writeTaskReceipt } = require('../../lib/task-receipt');
const root = path.resolve(__dirname, '../..');
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
const candidate = command => command.replace(/^node(?=\s|$)/, quote(process.execPath));
const functionCommand = "node () { printf '%s' 'function retained'; }; node";
const continuedFunction = "node \\\n() { printf '%s' 'continued function retained'; }; node";
const excludeFunction = command => /^node\s*\(/.test(command) ? command : candidate(command);
// Diagnostic plan: remove only shell line continuations for classification.
// Return original text for definitions, including their original continuations.
const excludeContinuedFunction = command => /^node\s*\(/.test(command.replace(/\\\n/g, '')) ? command : candidate(command);
const cases = [
  ['original function', functionCommand, 0, 'function retained'],
  ['naive leading-word candidate', candidate(functionCommand), 0, null],
  ['function exclusion control', /^node\s*\(/.test(functionCommand) ? functionCommand : candidate(functionCommand), 0, 'function retained'],
  ['ordinary node candidate', candidate('node --version'), 0, process.version],
  ['original continued function', continuedFunction, 0, 'continued function retained'],
  ['prior exclusion misses continuation', excludeFunction(continuedFunction), 0, null],
  ['continued function exclusion control', excludeContinuedFunction(continuedFunction), 0, 'continued function retained'],
];
for (const [name, command, exit, output] of cases) {
  const result = writeTaskReceipt({ taskId: `completion-function-${name}`, command, root });
  assert.equal(result.exit, exit, `${name}: ${result.output || result.error}`);
  if (output !== null) assert.equal(result.output, output, name);
  else {
    assert.match(result.output, /not a valid identifier/, name);
    assert.ok(!result.output.includes('function retained'), name);
  }
  const saved = JSON.parse(fs.readFileSync(result.receiptFile, 'utf8'));
  assert.equal(saved.command, command, name);
  assert.equal(saved.result.exit, exit, name);
  assert.equal(saved.result.passed, exit === 0, name);
  assert.equal(saved.result.output, result.output, name);
  console.log(`${name}: ${output === null ? 'invalid function name, intended output lost' : result.output}, exit ${result.exit}, receipt retained`);
  console.log(`receipt: ${result.receiptPath}`);
}
console.log('diagnostic only: classify continued function definitions before replacing the leading node word');
