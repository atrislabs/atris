'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mod = require('../commands/scout');
const entrypoint = mod[Object.keys(mod)[0]];

test('runner failure prints stderr details', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-test-'));
  const prevCwd = process.cwd();
  const prevHome = process.env.HOME;
  const prevPath = process.env.PATH;

  process.chdir(scratch);
  process.env.HOME = scratch;
  const fallbackPath = '/usr/bin:/bin:/usr/sbin:/sbin';
  process.env.PATH = scratch + path.delimiter + (prevPath || fallbackPath);

  const scriptContent = '#!/bin/sh\necho "target_error_detail" >&2\nexit 1\n';
  fs.writeFileSync(path.join(scratch, 'claude'), scriptContent, { mode: 0o755 });
  fs.writeFileSync(path.join(scratch, 'claude.cmd'), '@echo off\r\necho target_error_detail 1>&2\r\nexit /b 1\r\n');

  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));

  try {
    await entrypoint(['--yes', 'target_question']);
    const output = logs.join('\n');
    assert.ok(output.includes('target_error_detail'));
  } finally {
    console.log = origLog;
    try { process.chdir(prevCwd); } catch {}
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
