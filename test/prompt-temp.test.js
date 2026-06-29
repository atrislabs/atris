'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const { safePrefix, writePromptTempFile } = require('../lib/prompt-temp');

test('writePromptTempFile creates unique prompt files with the prompt content', () => {
  const first = writePromptTempFile('run prompt', 'first prompt');
  const second = writePromptTempFile('run prompt', 'second prompt');
  try {
    assert.notEqual(first.filePath, second.filePath);
    assert.equal(fs.readFileSync(first.filePath, 'utf8'), 'first prompt');
    assert.equal(fs.readFileSync(second.filePath, 'utf8'), 'second prompt');
  } finally {
    first.cleanup();
    second.cleanup();
  }
});

test('writePromptTempFile cleanup removes the temp file directory', () => {
  const promptTemp = writePromptTempFile('staleness-prompt', 'check freshness');
  const filePath = promptTemp.filePath;
  assert.equal(fs.existsSync(filePath), true);
  promptTemp.cleanup();
  assert.equal(fs.existsSync(filePath), false);
});

test('safePrefix keeps temp prefixes shell-neutral', () => {
  assert.equal(safePrefix('../bad prompt!!'), 'bad-prompt');
  assert.equal(safePrefix(''), 'prompt');
});
