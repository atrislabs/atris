'use strict';

const fs = require('fs');
const path = require('path');
const { resolveWorkspaceRoot } = require('../lib/mission-root');
const { readText } = require('./brain');

const BOOT_FILES = [
  'CLAUDE.md', 'AGENTS.md', 'atris/atris.md', 'atris/MAP.md',
  'atris/TODO.md', 'atris/now.md', 'atris/PERSONA.md',
  'atris/brain/STATUS.md', 'atris/brain/self_improvement_ledger.md',
  'atris/wiki/index.md', 'atris/skills/atris/SKILL.md',
];

function stat(file) {
  try { return fs.statSync(file); } catch { return null; }
}

function collectDocHealth({ cwd = process.cwd() } = {}) {
  const root = resolveWorkspaceRoot(cwd);
  if (!stat(path.join(root, 'atris'))?.isDirectory()) {
    return { ok: false, action: 'doc-health', root, message: 'no atris/ folder in this workspace.' };
  }
  const files = BOOT_FILES.map(file => {
    const missing = !stat(path.join(root, file))?.isFile();
    const chars = missing ? 0 : readText(path.join(root, file)).length;
    return { path: file, missing, chars, approximate_tokens: chars / 4, oversized: chars > 20000 };
  });
  const total_chars = files.reduce((sum, file) => sum + file.chars, 0);
  return {
    ok: true, action: 'doc-health', root,
    boot_load: { files, total_chars, approximate_tokens: total_chars / 4, token_estimate: 'chars divided by 4' },
  };
}

function docHealthCommand(args = [], options = {}) {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    console.log('usage: atris doc-health [--json] [--questions <path>]');
    return 0;
  }
  const payload = collectDocHealth(options);
  console.log(args.includes('--json') ? JSON.stringify(payload, null, 2)
    : payload.message || `boot load: ${payload.boot_load.total_chars} chars`);
  return payload.ok ? 0 : 1;
}

module.exports = { collectDocHealth, docHealthCommand };
