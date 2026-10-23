const test = require('node:test');
const assert = require('node:assert');
const { buildConsolidatePrompt } = require('../lib/wiki');

test('public consolidation prompt names the wiki inputs and preserves consolidation rules', () => {
  const prompt = buildConsolidatePrompt('public');

  assert.ok(prompt.startsWith('Atris wiki consolidation pass\n'));
  assert.ok(prompt.includes('Read atris/wiki/index.md, atris/wiki/log.md, and every page under the wiki subfolders.'));
  assert.ok(prompt.includes('- UPDATE facts that changed.'));
  assert.ok(prompt.includes('- DELETE stale facts, duplicates, and mechanics.'));
  assert.ok(prompt.includes('- ADD nothing new.'));
  assert.ok(prompt.includes('- Entries marked as user-stated conventions or explicit remember-this survive.'));
  assert.ok(prompt.includes('- Every kept entry keeps its provenance as a source link or date.'));
  assert.ok(prompt.endsWith('Consolidate overlapping entries, preserve the strongest source-backed version, and leave index.md and page links consistent.'));
  assert.ok(!prompt.includes('.atris/presidio'));
});

test('private consolidation prompt changes the wiki root and retains all instructions', () => {
  const prompt = buildConsolidatePrompt('private');

  assert.ok(prompt.includes('Read .atris/presidio/index.md, .atris/presidio/log.md, and every page under the wiki subfolders.'));
  assert.ok(!prompt.includes('atris/wiki/'));
  assert.strictEqual(prompt, buildConsolidatePrompt('public').replaceAll('atris/wiki/', '.atris/presidio/'));
});

test('omitted, empty, and unrecognized modes use the public consolidation prompt', () => {
  const publicPrompt = buildConsolidatePrompt('public');

  assert.strictEqual(buildConsolidatePrompt(), publicPrompt);
  for (const mode of [undefined, '', null, 'unknown', 'PRIVATE']) {
    assert.strictEqual(buildConsolidatePrompt(mode), publicPrompt);
  }
});
