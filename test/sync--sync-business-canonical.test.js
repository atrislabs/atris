const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { syncBusinessCanonical } = require('../commands/sync');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-business-canonical-'));
  const saved = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => key === 'HOME' || key.startsWith('ATRIS_')));
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  process.env.HOME = root;
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (key === 'HOME' || key.startsWith('ATRIS_')) delete process.env[key];
    }
    Object.assign(process.env, saved);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('syncBusinessCanonical previews an empty workspace with default metadata without writing', (t) => {
  const root = workspace(t);
  // Preview only: generated dates are neither persisted nor compared.
  const result = syncBusinessCanonical(root, {}, { dryRun: true, force: false });

  assert.ok(result.added > 0);
  assert.strictEqual(result.added, result.addedList.length);
  assert.ok(result.addedList.includes('PERSONA.md'));
  assert.ok(!result.addedList.includes('persona.md'));
  assert.strictEqual(result.updated, 0);
  assert.strictEqual(result.preserved, 0);
  assert.deepStrictEqual(result.agentAdapterList, ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']);
  assert.deepStrictEqual(result.stateAddedList, [
    path.join('.atris', 'state', '_sync.json'),
    path.join('.atris', 'state', 'events.jsonl'),
    path.join('.atris', 'state', 'episodes.jsonl'),
    path.join('.atris', 'state', 'scorecards.jsonl'),
  ]);
  assert.deepStrictEqual(fs.readdirSync(root), []);
});

test('syncBusinessCanonical preserves custom content and previews forced canonical replacement', (t) => {
  const root = workspace(t);
  const persona = path.join(root, 'atris', 'PERSONA.md');
  fs.mkdirSync(path.dirname(persona));
  fs.writeFileSync(persona, 'Our custom voice.\n');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Our custom instructions.\n');
  const metadata = { name: 'Example Company', slug: 'example-company' };

  const preserved = syncBusinessCanonical(root, metadata, { dryRun: true, force: false });
  assert.deepStrictEqual(preserved.preservedList, ['PERSONA.md']);
  assert.strictEqual(preserved.preserved, 1);
  assert.strictEqual(preserved.updated, 0);
  assert.deepStrictEqual(preserved.agentAdapterList, ['CLAUDE.md', 'GEMINI.md']);

  const forced = syncBusinessCanonical(root, metadata, { dryRun: true, force: true });
  assert.deepStrictEqual(forced.updatedList, ['PERSONA.md']);
  assert.strictEqual(forced.updated, 1);
  assert.strictEqual(forced.preserved, 0);
  assert.deepStrictEqual(forced.preservedList, []);
  assert.strictEqual(fs.readFileSync(persona, 'utf8'), 'Our custom voice.\n');
  assert.strictEqual(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), 'Our custom instructions.\n');
  assert.deepStrictEqual(fs.readdirSync(root).sort(), ['AGENTS.md', 'atris']);
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'atris')), ['PERSONA.md']);
});

test('syncBusinessCanonical reports an unreadable canonical destination without writing in preview', (t) => {
  const root = workspace(t);
  const persona = path.join(root, 'atris', 'PERSONA.md');
  fs.mkdirSync(persona, { recursive: true });

  assert.throws(() => syncBusinessCanonical(root, {}, { dryRun: true, force: false }),
    { code: 'EISDIR' });
  assert.deepStrictEqual(fs.readdirSync(root), ['atris']);
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'atris')), ['PERSONA.md']);
  assert.deepStrictEqual(fs.readdirSync(persona), []);
});
