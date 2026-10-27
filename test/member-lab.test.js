'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('member lab records build timings and project changes by round', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'member-lab-test-'));
  const bench = path.join(root, 'bench');
  for (const [id, seconds] of [['06', 10], ['09', 30]]) {
    const task = path.join(bench, `${id}-test`);
    fs.mkdirSync(path.join(task, 'fixture'), { recursive: true });
    fs.writeFileSync(path.join(task, 'fixture', 'code.txt'), 'old\n');
    fs.writeFileSync(path.join(task, 'prompt.md'), String(seconds));
    fs.writeFileSync(path.join(task, 'check.js'), 'exports.check = () => {};');
  }
  const fake = path.join(root, 'fake.js');
  fs.writeFileSync(fake, `const fs = require('fs');
if (process.argv[2] === 'init') { fs.mkdirSync('atris', {recursive:true}); fs.writeFileSync('atris/notes', 'desk\\n'); }
else {
 if (!process.argv.includes('--example')) process.exit(2);
 fs.mkdirSync('.atris/state', {recursive:true});
 fs.writeFileSync('.atris/state/roster_runs.jsonl', JSON.stringify({job:'build',seconds:Number(process.argv[4])})+'\\n'+JSON.stringify({job:'review',seconds:999})+'\\n');
 fs.writeFileSync('code.txt','new\\nmore\\n'); fs.writeFileSync('added.txt','one\\ntwo\\n'); fs.writeFileSync('atris/notes','changed\\n');
 process.stdout.write('first'); setTimeout(() => process.stdout.write(' line\\nsecond\\n'), 10);
}`);
  const run = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/member-lab.js'), '--bench', bench, '--lab', root, '--cli', fake, '--label', 'test', '--tasks', '06,09', '--extra', '--example', '--jobs', '1'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /build median 20s, average 20s; code lines changed: .* 5/);
  const rows = fs.readFileSync(path.join(root, 'results/test.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(r => r.build_seconds), [[10], [30]]);
  assert.deepEqual(rows.map(r => r.code_lines_changed), [5, 5]);
  const summary = JSON.parse(fs.readFileSync(path.join(root, 'results/test.summary.json'), 'utf8'));
  assert.equal(summary[0].build_median_seconds, 20);
  assert.equal(summary[0].build_average_seconds, 20);
  assert.deepEqual(summary[0].tasks.map(t => t.code_lines_changed), [5, 5]);
  const log = fs.readFileSync(path.join(root, 'runs/test/06-test.log'), 'utf8');
  assert.match(log, /^\[\d+\.\d+s\] first line\n\[\d+\.\d+s\] second\n$/);
});
