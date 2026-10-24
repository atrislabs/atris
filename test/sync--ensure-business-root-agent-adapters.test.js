const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureBusinessRootAgentAdapters } = require('../commands/sync');

const adapters = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-business-adapters-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('creates all three adapters with business metadata and is idempotent', (t) => {
  const root = temporaryRoot(t);
  assert.deepStrictEqual(
    ensureBusinessRootAgentAdapters(root, { name: 'Example Studio', slug: 'example-studio' }),
    adapters,
  );
  const contents = adapters.map((file) => fs.readFileSync(path.join(root, file), 'utf8'));
  assert.match(contents[0], /^# AGENTS\.md - Example Studio Atris Workspace\n/);
  assert.ok(contents[0].includes('for Example Studio (example-studio).'));
  assert.ok(contents[0].includes(`Workspace root at creation: ${root}\n`));
  assert.ok(contents[0].includes('atris business start'));
  assert.strictEqual(contents[1], contents[0]);
  assert.strictEqual(contents[2], contents[0]);
  assert.deepStrictEqual(ensureBusinessRootAgentAdapters(root, { name: 'Changed' }), []);
  adapters.forEach((file, index) => {
    assert.strictEqual(fs.readFileSync(path.join(root, file), 'utf8'), contents[index]);
  });
});

test('preserves custom and empty adapters while creating only missing files', (t) => {
  const root = temporaryRoot(t);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'custom instructions\n');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '');
  assert.deepStrictEqual(ensureBusinessRootAgentAdapters(root, { slug: 'slug-only' }), ['GEMINI.md']);
  assert.strictEqual(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), 'custom instructions\n');
  assert.strictEqual(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), '');
  assert.match(fs.readFileSync(path.join(root, 'GEMINI.md'), 'utf8'), /^# AGENTS\.md - slug-only Atris Workspace\n/);
});

test('dry run reports missing adapters without writing or replacing files', (t) => {
  const root = temporaryRoot(t);
  fs.writeFileSync(path.join(root, 'GEMINI.md'), 'keep me');
  assert.deepStrictEqual(ensureBusinessRootAgentAdapters(root, {}, { dryRun: true }), ['AGENTS.md', 'CLAUDE.md']);
  assert.deepStrictEqual(fs.readdirSync(root), ['GEMINI.md']);
  assert.strictEqual(fs.readFileSync(path.join(root, 'GEMINI.md'), 'utf8'), 'keep me');
});

test('empty metadata uses the default business name and slug', (t) => {
  const root = temporaryRoot(t);
  assert.deepStrictEqual(ensureBusinessRootAgentAdapters(root), adapters);
  for (const file of adapters) {
    const content = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(content, /^# AGENTS\.md - this business Atris Workspace\n/);
    assert.ok(content.includes('for this business (business).'));
  }
});

test('missing root is not created, and a real write reports ENOENT', (t) => {
  const root = path.join(temporaryRoot(t), 'missing');
  assert.deepStrictEqual(ensureBusinessRootAgentAdapters(root, {}, { dryRun: true }), adapters);
  assert.strictEqual(fs.existsSync(root), false);
  assert.throws(() => ensureBusinessRootAgentAdapters(root), { code: 'ENOENT' });
  assert.strictEqual(fs.existsSync(root), false);
});
