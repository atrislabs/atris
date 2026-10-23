'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildLintPrompt } = require('../lib/wiki');

const PUBLIC_ROOT = 'atris/wiki';
const PRIVATE_ROOT = '.atris/presidio';

function expectedPrompt(wikiRoot) {
  return `Atris wiki lint pass

Read ${wikiRoot}/index.md, crawl the referenced pages, and inspect the local wiki.

Checks:
1. Every page referenced by index.md exists
2. Cross-references resolve
3. Orphan pages are listed
4. Contradictions are called out plainly
5. Gaps worth ingesting next are listed concretely
6. ${wikiRoot}/STATUS.md is rewritten in plain English
7. ${wikiRoot}/log.md gets a LINT entry under today's date

Output:
- Clear summary for a non-technical reader
- Specific next ingest suggestions
- No hedging if the wiki is stale or messy`;
}

test('buildLintPrompt writes the public lint pass', () => {
  const prompt = buildLintPrompt();
  const named = buildLintPrompt('public');

  assert.strictEqual(prompt, expectedPrompt(PUBLIC_ROOT));
  assert.strictEqual(named, prompt);
  assert.strictEqual(prompt.includes(`${PUBLIC_ROOT}/index.md`), true);
  assert.strictEqual(prompt.includes(`${PUBLIC_ROOT}/STATUS.md`), true);
  assert.strictEqual(prompt.includes(`${PUBLIC_ROOT}/log.md`), true);
  assert.strictEqual(prompt.includes(PRIVATE_ROOT), false);
  assert.strictEqual(/\d{4}-\d{2}-\d{2}/.test(prompt), false);
});

test('buildLintPrompt points a private pass at the private wiki', () => {
  const prompt = buildLintPrompt('private');

  assert.strictEqual(prompt, expectedPrompt(PRIVATE_ROOT));
  assert.strictEqual(prompt.includes(`${PRIVATE_ROOT}/index.md`), true);
  assert.strictEqual(prompt.includes(`${PRIVATE_ROOT}/STATUS.md`), true);
  assert.strictEqual(prompt.includes(`${PRIVATE_ROOT}/log.md`), true);
  assert.strictEqual(prompt.includes(PUBLIC_ROOT), false);
  assert.strictEqual(/\d{4}-\d{2}-\d{2}/.test(prompt), false);
});

test('buildLintPrompt treats empty and unknown modes as a public pass', () => {
  const publicPrompt = expectedPrompt(PUBLIC_ROOT);
  const cases = [
    undefined,
    null,
    '',
    ' ',
    'PUBLIC',
    'Private',
    'cloud',
    'private ',
    0,
    false,
  ];

  for (const mode of cases) {
    let prompt;
    assert.doesNotThrow(() => {
      prompt = buildLintPrompt(mode);
    }, `mode ${JSON.stringify(mode)} should not throw`);
    assert.strictEqual(prompt, publicPrompt, `mode ${JSON.stringify(mode)}`);
    assert.strictEqual(prompt.includes(PRIVATE_ROOT), false, `mode ${JSON.stringify(mode)}`);
  }
});
