'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildIngestPrompt } = require('../lib/wiki');

function wikiSchema(root) {
  return `The wiki lives in ${root}/.

Structure:
- ${root}/wiki.md - protocol for future agents
- ${root}/index.md - catalog grouped by type
- ${root}/log.md - append-only activity log
- ${root}/STATUS.md - plain-English health summary
- ${root}/people/ - one page per human
- ${root}/systems/ - one page per tool, table, dashboard, service, or product
- ${root}/concepts/ - pattern and framework pages
- ${root}/briefs/ - cross-cutting briefs referencing 3+ pages

Page format:
---
type: person | system | concept | brief
slug: short-id
title: Human Readable
sources: [path/to/source1.md]
last_compiled: YYYY-MM-DD
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags: [tag1, tag2]
---
# Title
Body in markdown.
## Cross-References
- [[${root}/people/related.md]] - why related

Rules:
- Read every listed source fully before writing
- Merge new info into existing pages instead of replacing them
- Keep index.md, log.md, and STATUS.md current
- Flag contradictions directly instead of smoothing them over
- Never modify the raw source documents you ingested`;
}

function expectedPrompt(sourceValue, listedSources, root) {
  return `Atris wiki ingest: ${listedSources}
${wikiSchema(root)}

Workflow:
1. Read every source in: ${sourceValue}
2. Ensure ${root}/ exists with wiki.md, index.md, log.md, STATUS.md, and the 3 page subfolders
3. Extract people, systems, and concepts worth preserving
4. Create or update pages under ${root}/, merging with existing facts instead of replacing them
5. Add cross-references using [[${root}/...]] links
6. Update ${root}/index.md with one-line descriptions of touched pages
7. Append an INGEST entry to ${root}/log.md under today's date
8. Refresh ${root}/STATUS.md in plain English for a non-technical reader

Quality bar:
- Ask clarifying questions if the source is ambiguous
- Capture the important facts, not filler
- Say what is uncertain
- Leave the wiki sharper than you found it`;
}

test('buildIngestPrompt names the sources and the public wiki layout', () => {
  const source = 'docs/notes.md atris/atris.md';
  const prompt = buildIngestPrompt(source);

  assert.strictEqual(prompt, expectedPrompt(source, 'docs/notes.md, atris/atris.md', 'atris/wiki'));
  assert.strictEqual(buildIngestPrompt(source, 'public'), prompt);
  assert.strictEqual(prompt.split('\n')[0], 'Atris wiki ingest: docs/notes.md, atris/atris.md');
  assert.equal(prompt.includes('.atris/presidio'), false);
  assert.equal(/\b20\d{2}-\d{2}-\d{2}\b/.test(prompt), false);
});

test('buildIngestPrompt switches roots only for private mode and keeps raw spacing in the read step', () => {
  const source = 'docs/a.md   docs/b.md';
  const publicPrompt = buildIngestPrompt(source, 'local');
  const privatePrompt = buildIngestPrompt(source, 'private');

  assert.strictEqual(publicPrompt, buildIngestPrompt(source));
  assert.strictEqual(publicPrompt, expectedPrompt(source, 'docs/a.md, docs/b.md', 'atris/wiki'));
  assert.strictEqual(privatePrompt, expectedPrompt(source, 'docs/a.md, docs/b.md', '.atris/presidio'));
  assert.match(publicPrompt, /1\. Read every source in: docs\/a\.md   docs\/b\.md/);
  assert.match(privatePrompt, /1\. Read every source in: docs\/a\.md   docs\/b\.md/);
  assert.equal(privatePrompt.includes('atris/wiki'), false);
  assert.equal(publicPrompt.includes('.atris/presidio'), false);
});

test('buildIngestPrompt leaves an empty source blank and rejects a non-string', () => {
  const blank = buildIngestPrompt('');
  const whitespace = buildIngestPrompt(' \t ');

  assert.strictEqual(blank, expectedPrompt('', '', 'atris/wiki'));
  assert.strictEqual(whitespace, expectedPrompt(' \t ', '', 'atris/wiki'));
  assert.strictEqual(blank.split('\n')[0], 'Atris wiki ingest: ');
  assert.match(blank, /1\. Read every source in: \n/);
  assert.match(whitespace, /1\. Read every source in:  \t \n/);

  for (const bad of [undefined, null, 0]) {
    assert.throws(() => buildIngestPrompt(bad), TypeError);
  }
});
