'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('broken skill symlink is not counted as wired', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-test-'));
  const outputDir = path.join(tempDir, 'workspace');
  const skillsDir = path.join(outputDir, 'atris', 'skills');
  const claudeSkillsDir = path.join(outputDir, '.claude', 'skills');

  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(claudeSkillsDir, { recursive: true });
  fs.symlinkSync(path.join(tempDir, 'nonexistent-target'), path.join(claudeSkillsDir, 'broken-skill'));

  const savedEnv = { ...process.env };
  const savedArgv = process.argv;
  const savedLog = console.log;
  const savedStdoutWrite = process.stdout.write;
  const savedExit = process.exit;

  process.env.ATRIS_TOKEN = 'mock-token';
  process.env.HOME = tempDir;

  const api = require('../utils/api');
  const origApiRequestJson = api.apiRequestJson;
  api.apiRequestJson = async (pathname) => {
    if (pathname === '/business/') {
      return { ok: true, data: [{ id: 'biz-1', slug: 'test-biz', name: 'test-biz', workspace_id: 'ws-1' }] };
    }
    if (pathname.includes('/snapshot')) {
      return { ok: true, data: { files: [{ path: 'atris/skills/.keep', content: '' }] } };
    }
    return { ok: false };
  };

  process.argv = ['node', 'atris', 'pull', 'test-biz', '--into', outputDir, '--no-manifest'];

  const logs = [];
  console.log = (...args) => logs.push(args.join(' '));
  process.stdout.write = () => true;
  process.exit = (code) => {
    throw new Error(`process.exit called with ${code}`);
  };

  try {
    const { pullAtris } = require('../commands/pull');
    await pullAtris();

    const wiredSkillsReported = logs.some((line) => line.includes('skills → .claude/skills/'));
    assert.strictEqual(wiredSkillsReported, false);
  } finally {
    console.log = savedLog;
    process.stdout.write = savedStdoutWrite;
    process.exit = savedExit;
    process.argv = savedArgv;
    Object.assign(process.env, savedEnv);
    api.apiRequestJson = origApiRequestJson;
  }
});
