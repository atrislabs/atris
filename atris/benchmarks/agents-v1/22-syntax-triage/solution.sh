set -eu
cat > stack.js <<'JS'
'use strict';

class Stack {
  constructor() {
    this.items = [];
  }

  push(value) {
    this.items.push(value);
  }

  pop() {
    return this.items.pop();
  }

  peek() {
    return this.items[this.items.length - 1];
  }

  get size() {
    return this.items.length;
  }
}

module.exports = { Stack };
JS
cat > ops.js <<'JS'
'use strict';

const ops = {
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  div: (a, b) => a / b,
};

module.exports = { ops };
JS
cat > vm.js <<'JS'
'use strict';

const { Stack } = require('./stack');
const { ops } = require('./ops');

function run(program) {
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
JS
