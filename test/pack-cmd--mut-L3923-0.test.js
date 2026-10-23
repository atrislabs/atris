const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { run } = require('../commands/pack');

test('pack show reports an available verifier as not run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-show-check-'));
  const lines = [];
  const originalLog = console.log;
  try {
    const content = {
      'RUN.md': '# Declared check\nReview this pack.\n',
      'VERIFY.md': '# Check\n',
    };
    const hashes = Object.fromEntries(Object.entries(content).map(([name, text]) => [
      name, createHash('sha256').update(text).digest('hex'),
    ]));
    fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
      slug: 'check-pack',
      title: 'Check Pack',
      description: 'A pack with a declared check.',
      version: '1.0.0',
      type: 'workflow',
      entrypoint: 'RUN.md',
      verifier: 'VERIFY.md',
      permissions: ['pack.read'],
      author: 'Test Author',
      provenance: { 'created-in': 'test fixture' },
      'content-hashes': hashes,
    }));
    for (const [name, text] of Object.entries(content)) {
      fs.writeFileSync(path.join(dir, name), text);
    }
    console.log = (...args) => lines.push(args.join(' '));
    assert.equal(await run(['show', dir]), 0);
    assert.deepEqual(lines.filter((line) => line.startsWith('check: ')), [
      'check: VERIFY.md is available; not run',
    ], lines.join('\n'));
  } finally {
    console.log = originalLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
