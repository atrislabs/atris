'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');

test('interactive run asks for a job and includes it in the proposed command', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-run-job-'));
  const cwd = process.cwd();
  const env = { ...process.env };
  const stdin = Object.getOwnPropertyDescriptor(process, 'stdin');
  const stdout = Object.getOwnPropertyDescriptor(process, 'stdout');
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const prompts = [];
  const proposed = [];
  const key = str => setImmediate(() => input.emit('keypress', str, { name: str }));
  const output = new Writable({
    write(chunk, encoding, done) {
      const text = chunk.toString();
      if (text === 'run which member? ') {
        prompts.push(text);
        setImmediate(() => input.write('maze\n'));
      } else if (text === 'job (optional, enter to skip): ') {
        prompts.push(text);
        setImmediate(() => input.write('repair tests\n'));
      } else if (text.startsWith('this will run: ')) {
        proposed.push(text);
      } else if (text.includes('press y to go, any other key to cancel')) {
        // Cancel before any child command or engine can run.
        key('n');
      } else if (text.includes('cancelled: atris member run')) {
        key('q');
      }
      done();
    },
  });
  output.isTTY = true;
  output.columns = 100;
  try {
    for (const name of Object.keys(process.env)) delete process.env[name];
    process.env.HOME = root;
    process.env.ATRIS_HOME = path.join(root, '.atris');
    process.chdir(root);
    Object.defineProperty(process, 'stdin', { configurable: true, value: input });
    Object.defineProperty(process, 'stdout', { configurable: true, value: output });
    const { gmCommand } = require('../commands/gm');
    key('r');
    await gmCommand('--workspace', root);
    assert.deepEqual(prompts, ['run which member? ', 'job (optional, enter to skip): ']);
    assert.deepEqual(proposed, ['this will run: atris member run maze "repair tests"\n']);
  } finally {
    Object.defineProperty(process, 'stdin', stdin);
    Object.defineProperty(process, 'stdout', stdout);
    input.destroy();
    output.destroy();
    process.chdir(cwd);
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, env);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
