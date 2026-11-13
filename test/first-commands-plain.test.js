const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cli = path.resolve(__dirname, '../bin/atris.js');

test('first commands speak plainly in new folders', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-plain-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ATRIS_')));
  Object.assign(env, { HOME: home, ATRIS_OPERATOR: 'tester', NODE_TEST_CONTEXT: '1' });
  const run = (cwd, ...args) => {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const check = (output) => {
    assert.doesNotMatch(output, /^[A-Z][A-Z ]{2,}:/m);
    assert.doesNotMatch(output, /\u2014|already won|without a room|ready to claim|already yours|adapters|initialized/i);
    for (const line of output.split('\n').filter((line) => line.startsWith('next:'))) {
      assert.match(line, /  \([^()]+\)$/);
    }
  };
  const empty = path.join(base, 'empty');
  const readme = path.join(base, 'readme');
  const setup = path.join(base, 'setup');
  for (const dir of [empty, readme, setup]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(readme, 'README.md'), '# hello\n');
  check(run(empty, 'help'));
  check(run(empty, 'help', '--all').split('\n').slice(0, 12).join('\n'));
  check(run(empty));
  const readmeOutput = run(readme);
  check(readmeOutput);
  assert.match(readmeOutput, /this folder already has README\.md/);
  check(run(setup, 'init', '--yes'));
  check(run(setup));
});

test('workspace titles stay readable and command fields stay exact', () => {
  const { renderWorkspace } = require('../lib/first-minute');
  const title = 'recorded pull requests stop piling when reviewers can find the next useful change';
  const command = 'atris task claim T-1 --as tester';
  const output = renderWorkspace({ task: { title, status: 'open' }, nextCommand: command });
  assert.match(output, /"recorded pull requests stop piling when reviewers can\.\.\." is ready to start\./);
  assert.match(output, /next: atris task claim T-1 --as tester  \(start it\)$/);
  const short = renderWorkspace({ task: { title: 'a title with more than five words', status: 'claimed' }, nextCommand: command });
  assert.match(short, /you are working on "a title with more than five words"\./);
});
