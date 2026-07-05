'use strict';

const { Stack } = require('./stack');
const { ops } = require('./ops');

function run(program {
  const stack = new Stack();
  for (const instr of program) {
    if (instr.op === 'push') {
      stack.push(instr.value);
      continue;
    }
    const b = stack.pop();
    const a = stack.pop();
    const fn = ops[instr.op];
    if (!fn) throw new Error(`unknown op: ${instr.op}`);
    stack.push(fn(a, b));
  }
  return stack.peek();
}

module.exports = { run };
