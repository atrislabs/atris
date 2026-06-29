'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function safePrefix(prefix) {
  const cleaned = String(prefix || 'prompt').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'prompt';
}

function writePromptTempFile(prefix, prompt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `atris-${safePrefix(prefix)}-`));
  const filePath = path.join(dir, 'prompt.md');
  fs.writeFileSync(filePath, String(prompt || ''), 'utf8');
  return {
    filePath,
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

module.exports = {
  safePrefix,
  writePromptTempFile,
};
