const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { assignShards, listTestFiles, parseShard, readWeights } = require('../scripts/ci-shard.js');

const root = path.join(__dirname, '..');

test('every test file runs on exactly one shard', () => {
  const files = listTestFiles();
  assert.ok(files.includes('test/ci-shard.test.js'));
  assert.ok(files.includes('test/commands.part-4.test.js'));
  assert.ok(!files.some((file) => file.includes('node_modules')));
  const shards = assignShards(files, readWeights(), 8);
  const placed = shards.flatMap((shard) => shard.files);
  assert.equal(placed.length, files.length);
  assert.deepEqual([...placed].sort(), files);
  assert.ok(shards.every((shard) => shard.files.length > 0));
});

// Round-robin on this list puts both slow files on shard 1: 120s against 2s.
test('slow files spread out instead of following file order', () => {
  const files = ['a.test.js', 'b.test.js', 'c.test.js', 'd.test.js'];
  const weights = { 'a.test.js': 60000, 'b.test.js': 1000, 'c.test.js': 60000, 'd.test.js': 1000 };
  const shards = assignShards(files, weights, 2);
  assert.deepEqual(shards.map((shard) => shard.ms), [61000, 61000]);
  assert.deepEqual(shards.map((shard) => shard.files), [['a.test.js', 'b.test.js'], ['c.test.js', 'd.test.js']]);
});

test('a file with no recorded time counts as a typical file', () => {
  const files = ['new-1.test.js', 'new-2.test.js', 'old.test.js', 'slow.test.js'];
  const shards = assignShards(files, { 'old.test.js': 500, 'slow.test.js': 9000 }, 2);
  const slow = shards.find((shard) => shard.files.includes('slow.test.js'));
  assert.deepEqual(slow.files, ['slow.test.js']);
  assert.equal(shards.find((shard) => shard !== slow).files.length, 3);
});

test('the shard number must be inside the count', () => {
  assert.deepEqual(parseShard('3/8'), { index: 3, total: 8 });
  for (const bad of ['0/8', '9/8', '3', '3/0', 'x/8', '']) assert.equal(parseShard(bad), null, bad);
});

test('GitHub runs each unit shard through the timed split', () => {
  const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  const shards = ci.match(/shard: \[([\d, ]+)\]/)[1].split(',').length;
  assert.match(ci, new RegExp(`run: node scripts/ci-shard\\.js \\$\\{\\{ matrix\\.shard \\}\\}/${shards}\\n`));
  assert.doesNotMatch(ci, /--test-shard/);
});
