const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { latestSuggestedTarget } = require('../lib/next-moves');

// Each test gets its own throwaway workspace under the OS temp dir, so nothing
// reads or writes the real machine.
function makeWorkspace(reports = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'next-moves-target-'));
  const dir = path.join(root, 'atris', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(reports)) {
    fs.writeFileSync(path.join(dir, name), text, 'utf8');
  }
  return root;
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test('latestSuggestedTarget: reads the Suggested target line from a report', () => {
  const root = makeWorkspace({
    '2026-10-22.md': '# Proof timeline\n\nWhat happened: the sync ran.\n\nSuggested target: Add the dry-run flag to atris sync.\n',
  });
  try {
    assert.strictEqual(latestSuggestedTarget(root), 'Add the dry-run flag to atris sync');
  } finally {
    cleanup(root);
  }
});

test('latestSuggestedTarget: newest report wins, and the last target line in a file wins', () => {
  const root = makeWorkspace({
    '2026-10-20.md': 'Suggested target: Old target from two days ago.\n',
    '2026-10-21.md': 'Suggested target: Middle target.\n',
    '2026-10-22.md': 'Suggested target: First try in this file.\nSuggested target: Second try in this file.\n',
  });
  try {
    assert.strictEqual(latestSuggestedTarget(root), 'Second try in this file');
  } finally {
    cleanup(root);
  }
});

test('latestSuggestedTarget: strips markdown decoration and trailing punctuation', () => {
  const root = makeWorkspace({
    '2026-10-22.md': 'Suggested target: **`Fix` the _loop_ #1**!\n',
  });
  try {
    assert.strictEqual(latestSuggestedTarget(root), 'Fix the loop 1');
  } finally {
    cleanup(root);
  }
});

test('latestSuggestedTarget: skips a newer report with no target, and a blank target, and non-md files', () => {
  const root = makeWorkspace({
    '2026-10-23.txt': 'Suggested target: Not a markdown report, so ignored.\n',
    '2026-10-22.md': '# Report with no target line\n\nSuggested target:   \n',
    '2026-10-21.md': 'Suggested target: older real target.\n',
  });
  try {
    assert.strictEqual(latestSuggestedTarget(root), 'Older real target');
  } finally {
    cleanup(root);
  }
});

test('latestSuggestedTarget: empty string when there is no reports directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'next-moves-target-empty-'));
  try {
    assert.strictEqual(latestSuggestedTarget(root), '');
  } finally {
    cleanup(root);
  }
});

test('latestSuggestedTarget: empty string when no report has a target line', () => {
  const root = makeWorkspace({
    '2026-10-22.md': '# Nothing to suggest here\n\nAll checks passed.\n',
  });
  try {
    assert.strictEqual(latestSuggestedTarget(root), '');
  } finally {
    cleanup(root);
  }
});
