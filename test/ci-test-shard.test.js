'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { discover, assign, main } = require('../scripts/ci-test-shard');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-test-groups-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, file, content) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}

test('eight groups preserve native discovery, new tests, helpers, and split test parts', (t) => {
  const root = fixture(t);
  const files = ['test/example.test.js', 'test/helpers/helper.js', 'scripts/test.js',
    'nested/test/sample.cjs', 'test-new.js', 'example_test.js', 'other.test.mjs',
    'test/sample.ts', 'test/sample.mts', 'test/sample.cts'];
  for (const file of files) write(root, file, `console.log('ran ${file}');\n`);
  write(root, 'node_modules/ignored/test.js', "throw Error('must not run');");
  write(root, 'nested/node_modules/pkg/test.js', "throw Error('must not run');");
  write(root, 'unrelated.js', "throw Error('must not run');");
  // Use the real split helper, so the complete set must survive the same env
  // and file separation used by the workflow.
  write(root, 'helper.cjs', fs.readFileSync(path.join(__dirname, 'helpers/test-part.js')));
  write(root, 'test/commands.test.js', `
const test = require('../helper.cjs').splitTests('1/4');
for (let i = 0; i < 12; i++) test('case ' + i, () => console.log('case-ran ' + i));
`);
  for (let i = 2; i <= 4; i++) write(root, `test/commands.part-${i}.test.js`,
    `require('../helper.cjs').runPart('./test/commands.test.js', '${i}/4');\n`);
  const env = { ...process.env, ATRIS_TEST_SPLIT: '1' };
  delete env.NODE_TEST_CONTEXT;
  const native = spawnSync(process.execPath, ['--test'], {
    cwd: root, encoding: 'utf8', env,
  });
  assert.equal(native.status, 0, native.stdout + native.stderr);
  const discovered = discover(root);
  assert.deepEqual(discovered, [...files, 'test/commands.test.js',
    ...[2, 3, 4].map(i => `test/commands.part-${i}.test.js`)].sort());
  const shards = assign(discovered, 8, {});
  assert.deepEqual(shards.flatMap(s => s.files).sort(), discovered);
  const output = [];
  for (let i = 1; i <= 8; i++) {
    const run = spawnSync(process.execPath, ['-e',
      'process.exitCode = require(process.argv[1]).main([process.argv[2]], process.argv[3])',
      path.join(__dirname, '../scripts/ci-test-shard.js'), `${i}/8`, root],
    { encoding: 'utf8', timeout: 30000, env });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    output.push(run.stdout);
  }
  const markers = text => text.split('\n').flatMap(line => {
    const match = /^(?:# )?((?:ran|case-ran) .*)$/.exec(line);
    return match ? [match[1]] : [];
  }).sort();
  assert.deepEqual(markers(output.join('\n')), markers(native.stdout));
  assert.equal(markers(native.stdout).length, files.length + 12);
});

test('recorded GitHub costs are balanced without losing a discovered file', () => {
  const files = discover(path.join(__dirname, '..'));
  const shards = assign(files, 8);
  assert.deepEqual(shards.flatMap(s => s.files).sort(), files);
  const costs = shards.map(s => s.milliseconds);
  assert.ok(Math.max(...costs) / Math.min(...costs) < 1.05, costs.join(', '));
  const expensive = ['test/commands.test.js', 'test/commands.part-2.test.js',
    'test/mission-status.test.js', 'test/autoland.test.js'];
  assert.equal(new Set(expensive.map(f => shards.findIndex(s => s.files.includes(f)))).size, expensive.length);
});

test('a failing real test returns failure and an empty group runs nothing', (t) => {
  const root = fixture(t);
  write(root, 'test/fail.test.js', "require('node:test')('fails', () => { throw Error('expected failure'); });");
  assert.equal(main(['1/8'], root), 1);
  assert.equal(main(['8/8'], root), 0);
  assert.equal(main(['0/8'], root), 1);
  assert.equal(main(['1/0'], root), 1);
  assert.equal(main(['1/8', 'extra'], root), 1);
});
