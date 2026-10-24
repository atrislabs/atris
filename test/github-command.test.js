'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { githubCommand } = require('../commands/github');

function withTempEnv(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-github-test-'));
  const origHome = process.env.HOME;
  const origPath = process.env.PATH;
  process.env.HOME = tmpDir;
  try {
    return fn(tmpDir);
  } finally {
    process.env.HOME = origHome;
    process.env.PATH = origPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function captureOutput(fn) {
  const origLog = console.log;
  const origError = console.error;
  const logs = [];
  const errors = [];
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const exitCode = fn();
    return { exitCode, stdout: logs.join('\n'), stderr: errors.join('\n') };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

test('githubCommand prints usage and supported commands on --help or no args', () => {
  withTempEnv(() => {
    const helpResult = captureOutput(() => githubCommand(['--help']));
    assert.strictEqual(helpResult.exitCode, 0);
    assert.match(helpResult.stdout, /usage: atris github <command> \[args\]/);
    assert.match(helpResult.stdout, /pr list\s+list pull requests/);
    assert.match(helpResult.stdout, /pr create\s+create a pull request/);
    assert.match(helpResult.stdout, /pr checks\s+show pull request checks/);
    assert.match(helpResult.stdout, /pr view\s+show pull request details/);
    assert.match(helpResult.stdout, /binary: gh/);
    assert.match(helpResult.stdout, /install: https:\/\/cli\.github\.com\//);

    const emptyResult = captureOutput(() => githubCommand([]));
    assert.strictEqual(emptyResult.exitCode, 0);
    assert.match(emptyResult.stdout, /usage: atris github <command> \[args\]/);
  });
});

test('githubCommand rejects unknown subcommands with exit code 1', () => {
  withTempEnv(() => {
    const res = captureOutput(() => githubCommand(['nonexistent-subcommand']));
    assert.strictEqual(res.exitCode, 1);
    assert.match(res.stderr, /unknown github command: nonexistent-subcommand/);
    assert.match(res.stderr, /run: atris github --help/);
  });
});

test('githubCommand detects missing gh binary and prints install instructions', () => {
  withTempEnv((tmpDir) => {
    const emptyBinDir = path.join(tmpDir, 'empty-bin');
    fs.mkdirSync(emptyBinDir, { recursive: true });
    process.env.PATH = emptyBinDir;

    const res = captureOutput(() => githubCommand(['auth']));
    assert.strictEqual(res.exitCode, 1);
    assert.match(res.stderr, /github cli not found\./);
    assert.match(res.stderr, /install: https:\/\/cli\.github\.com\//);
  });
});

test('githubCommand doctor detects fake gh binary and verifies auth state', () => {
  withTempEnv((tmpDir) => {
    const binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const fakeGh = path.join(binDir, 'gh');
    const script = [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then',
      '  echo "gh version 2.45.0 (2024-03-01)"',
      '  exit 0',
      'fi',
      'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then',
      '  echo "github auth ok"',
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n');
    fs.writeFileSync(fakeGh, script, { mode: 0o755 });
    process.env.PATH = `${binDir}:${process.env.PATH}`;

    const res = captureOutput(() => githubCommand(['doctor']));
    assert.strictEqual(res.exitCode, 0);
    assert.match(res.stdout, /github integration/);
    assert.match(res.stdout, /binary: found gh/);
    assert.match(res.stdout, /version: gh version 2\.45\.0 \(2024-03-01\)/);
    assert.match(res.stdout, /auth: ok/);
  });
});
