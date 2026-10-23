'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { roadmapItemsByState } = require('../lib/next-moves');

function setupIsolatedEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-roadmap-state-'));
  process.env.HOME = root;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      delete process.env[key];
    }
  }
  return root;
}

function cleanupIsolatedEnv(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

test('roadmapItemsByState: classifies open, claimed, and done items within Open loop items section', () => {
  const root = setupIsolatedEnv();
  try {
    const roadmapContent = [
      '# Roadmap',
      '',
      'Context before section.',
      '',
      '## Open loop items',
      '- [ ] Ship first feature',
      '- [~] Verify second feature in flight',
      '- [x] Research third feature completed',
      '- [ ] Queue fourth feature',
      '',
      '## Future Work',
      '- [ ] This item is in another section and must not be included',
      '- [x] Also in another section',
    ].join('\n');

    fs.writeFileSync(path.join(root, 'ROADMAP.md'), roadmapContent, 'utf8');

    const result = roadmapItemsByState(root);

    assert.deepStrictEqual(result, {
      open: ['Ship first feature', 'Queue fourth feature'],
      claimed: ['Verify second feature in flight'],
      done: ['Research third feature completed'],
    });
  } finally {
    cleanupIsolatedEnv(root);
  }
});

test('roadmapItemsByState: returns empty arrays when ROADMAP.md is missing or has no target section', () => {
  const root = setupIsolatedEnv();
  try {
    // 1. Missing ROADMAP.md
    assert.deepStrictEqual(roadmapItemsByState(root), {
      open: [],
      claimed: [],
      done: [],
    });

    // 2. Existing ROADMAP.md without "Open loop items" section
    fs.writeFileSync(
      path.join(root, 'ROADMAP.md'),
      '# Roadmap\n\n## Overview\nSome notes.\n\n## Other Section\n- [ ] Task\n',
      'utf8'
    );
    assert.deepStrictEqual(roadmapItemsByState(root), {
      open: [],
      claimed: [],
      done: [],
    });

    // 3. Empty file
    fs.writeFileSync(path.join(root, 'ROADMAP.md'), '', 'utf8');
    assert.deepStrictEqual(roadmapItemsByState(root), {
      open: [],
      claimed: [],
      done: [],
    });
  } finally {
    cleanupIsolatedEnv(root);
  }
});

test('roadmapItemsByState: handles edge cases (whitespace trimming, CRLF, section suffix, non-checkbox lines)', () => {
  const root = setupIsolatedEnv();
  try {
    const roadmapContent = [
      '# Roadmap',
      '',
      '## Open loop items (priority queue)',
      '   - [ ]    trimmed item with extra whitespace   ',
      '   - [~]    claimed item with indent   ',
      '   - [x]    done item with extra spaces   ',
      '- Not a checkbox bullet',
      'Some regular prose line',
      '### Subheading inside section',
      '- [?] Question mark checkbox ignored',
      '- [-] Minus checkbox ignored',
      '',
      '# Next Top-Level Heading',
      '- [ ] Outside section',
    ].join('\r\n');

    fs.writeFileSync(path.join(root, 'ROADMAP.md'), roadmapContent, 'utf8');

    const result = roadmapItemsByState(root);

    assert.deepStrictEqual(result, {
      open: ['trimmed item with extra whitespace'],
      claimed: ['claimed item with indent'],
      done: ['done item with extra spaces'],
    });
  } finally {
    cleanupIsolatedEnv(root);
  }
});
