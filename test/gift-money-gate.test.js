const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable, Writable } = require('node:stream');

const { confirmPurchase } = require('../commands/gift');

// A readable that reports as a TTY, so we exercise the interactive branch.
function ttyInput(chunks) {
  const input = new Readable({ read() {} });
  input.isTTY = true;
  for (const chunk of chunks) input.push(chunk);
  input.push(null);
  return input;
}

function collectOutput() {
  const chunks = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  output.getData = () => chunks.join('');
  return output;
}

test('confirmPurchase settles only when a human answers y', async () => {
  const output = collectOutput();
  const result = await confirmPurchase('Charge $100? (y/N) ', {
    input: ttyInput(['y\n']),
    output,
  });
  assert.equal(result, true);
  assert.match(output.getData(), /Charge \$100\? \(y\/N\) /);
});

test('confirmPurchase refuses on N', async () => {
  const result = await confirmPurchase('Charge $100? (y/N) ', {
    input: ttyInput(['n\n']),
    output: collectOutput(),
  });
  assert.equal(result, false);
});

test('confirmPurchase refuses on a bare enter (default is no)', async () => {
  const result = await confirmPurchase('Charge $100? (y/N) ', {
    input: ttyInput(['\n']),
    output: collectOutput(),
  });
  assert.equal(result, false);
});

test('confirmPurchase refuses in a non-TTY context without --yes (no silent charge in scripts)', async () => {
  const nonTty = new Readable({ read() {} });
  nonTty.push('y\n');
  nonTty.push(null);
  // isTTY is undefined here, mimicking a pipe or an agent loop.
  const result = await confirmPurchase('Charge $100? (y/N) ', {
    input: nonTty,
    output: collectOutput(),
  });
  assert.equal(result, false);
});

test('confirmPurchase honors an explicit --yes override without prompting', async () => {
  const output = collectOutput();
  const result = await confirmPurchase('Charge $100? (y/N) ', {
    yes: true,
    input: ttyInput([]),
    output,
  });
  assert.equal(result, true);
  // The override must not print the prompt; nothing was asked.
  assert.equal(output.getData(), '');
});
