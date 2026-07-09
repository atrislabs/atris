const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable, Writable } = require('node:stream');

const {
  renderDriftBlock,
  needsForceBroadWorkspaceConfirm,
  promptConfirm,
} = require('../commands/push');

function createInput(chunks) {
  const input = new Readable({ read() {} });
  for (const chunk of chunks) input.push(chunk);
  input.push(null);
  return input;
}

function createOutput() {
  const chunks = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  output.getData = () => chunks.join('');
  return output;
}

test('renderDriftBlock leads with safe path and names the conflict count', () => {
  const block = renderDriftBlock(['/atris/now.md', '/README.md']);
  assert.match(block, /2 files conflict\. run atris sync --review to pick local\/cloud\/merge, or atris push --only <path> to ship just what changed\./);
  assert.match(block, /Files that differ on cloud:/);
  assert.match(block, /~ atris\/now\.md/);
  assert.match(block, /~ README\.md/);
  assert.match(block, /To override \(force-push, may clobber cloud edits\): atris push --force/);
});

test('renderDriftBlock uses singular form for one conflict', () => {
  const block = renderDriftBlock(['/atris/now.md']);
  assert.match(block, /1 file conflict\. run atris sync --review/);
});

test('renderDriftBlock truncates long file lists to eight examples', () => {
  const driftFiles = Array.from({ length: 12 }, (_, i) => `/wiki/page-${i}.md`);
  const block = renderDriftBlock(driftFiles);
  assert.match(block, /12 files conflict/);
  assert.match(block, /~ wiki\/page-0\.md/);
  assert.match(block, /~ wiki\/page-7\.md/);
  assert.match(block, /\.\.\. \+4 more/);
  assert.doesNotMatch(block, /~ wiki\/page-8\.md/);
});

test('needsForceBroadWorkspaceConfirm requires prompt only for force + broad workspace without yes', () => {
  assert.equal(needsForceBroadWorkspaceConfirm({ force: true, allowBroadWorkspace: true, yes: false, dryRun: false }), true);
  assert.equal(needsForceBroadWorkspaceConfirm({ force: true, allowBroadWorkspace: true, yes: true, dryRun: false }), false);
  assert.equal(needsForceBroadWorkspaceConfirm({ force: true, allowBroadWorkspace: false, yes: false, dryRun: false }), false);
  assert.equal(needsForceBroadWorkspaceConfirm({ force: false, allowBroadWorkspace: true, yes: false, dryRun: false }), false);
  assert.equal(needsForceBroadWorkspaceConfirm({ force: true, allowBroadWorkspace: true, yes: false, dryRun: true }), false);
});

test('promptConfirm resolves true on y', async () => {
  const input = createInput(['y\n']);
  const output = createOutput();
  const result = await promptConfirm('Continue? (y/N) ', { input, output });
  assert.equal(result, true);
  assert.equal(output.getData(), 'Continue? (y/N) ');
});

test('promptConfirm resolves true on yes', async () => {
  const input = createInput(['yes\n']);
  const output = createOutput();
  const result = await promptConfirm('Continue? (y/N) ', { input, output });
  assert.equal(result, true);
});

test('promptConfirm resolves false on n', async () => {
  const input = createInput(['n\n']);
  const output = createOutput();
  const result = await promptConfirm('Continue? (y/N) ', { input, output });
  assert.equal(result, false);
});

test('promptConfirm resolves false on empty input', async () => {
  const input = createInput(['\n']);
  const output = createOutput();
  const result = await promptConfirm('Continue? (y/N) ', { input, output });
  assert.equal(result, false);
});

test('promptConfirm resolves false on random input', async () => {
  const input = createInput(['maybe\n']);
  const output = createOutput();
  const result = await promptConfirm('Continue? (y/N) ', { input, output });
  assert.equal(result, false);
});
