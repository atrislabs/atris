'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('interview finds the project above the current folder', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-parent-'));
  const project = path.join(home, 'project');
  const nested = path.join(project, 'notes');
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(path.join(project, 'atris'));
  const cwd = process.cwd();
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  const savedExit = process.exit;
  const savedLog = console.log;
  const savedError = console.error;
  const output = [];
  try {
    process.env.HOME = home;
    process.env.PATH = '';
    process.chdir(nested);
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    console.log = console.error = (...args) => output.push(args.join(' '));
    const { interviewCommand } = require('../commands/interview');
    await interviewCommand(['me', '--yes'], nested);
    assert.ok(output.some(line => line.includes(`workspace: ${project})`)));
  } finally {
    console.log = savedLog;
    console.error = savedError;
    process.exit = savedExit;
    process.chdir(cwd);
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  }
});
