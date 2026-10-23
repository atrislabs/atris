const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureWorkspaceStateFiles } = require('../commands/sync');

const names = ['_sync.json', 'events.jsonl', 'episodes.jsonl', 'scorecards.jsonl'];
const relativePaths = names.map(name => path.join('.atris', 'state', name));

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sync-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function metadata(root) {
  const result = JSON.parse(fs.readFileSync(path.join(root, '.atris', 'state', '_sync.json'), 'utf8'));
  // The generated timestamp is deliberately excluded from date-independent checks.
  delete result.updated_at;
  return result;
}

test('creates state files with supplied workspace metadata and empty logs', t => {
  const root = workspace(t);
  const params = {
    slug: 'sample-lab', business_id: 'business-123',
    workspace_id: 'workspace-456', workspace_template: 'research',
  };

  assert.deepStrictEqual(ensureWorkspaceStateFiles(root, params), relativePaths);
  assert.deepStrictEqual(metadata(root), {
    workspace_slug: 'sample-lab', business_id: 'business-123',
    workspace_id: 'workspace-456', workspace_template: 'research',
    status: 'initialized-local', source: 'workspace template bootstrap',
  });
  const stateDir = path.join(root, '.atris', 'state');
  assert.deepStrictEqual(fs.readdirSync(stateDir).sort(), [...names].sort());
  for (const name of names.slice(1)) {
    assert.strictEqual(fs.readFileSync(path.join(stateDir, name), 'utf8'), '');
  }
});

test('empty metadata uses local business defaults', t => {
  const root = workspace(t);
  assert.deepStrictEqual(ensureWorkspaceStateFiles(root, {}), relativePaths);
  assert.deepStrictEqual(metadata(root), {
    workspace_slug: 'business', business_id: '', workspace_id: '',
    workspace_template: 'business', status: 'initialized-local',
    source: 'workspace template bootstrap',
  });
});

test('preserves existing files and returns only missing files, then nothing on repeat', t => {
  const root = workspace(t);
  const stateDir = path.join(root, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const existing = { '_sync.json': '{"custom":true}\n', 'events.jsonl': '' };
  for (const [name, content] of Object.entries(existing)) {
    fs.writeFileSync(path.join(stateDir, name), content);
  }

  assert.deepStrictEqual(ensureWorkspaceStateFiles(root, { slug: 'replacement' }), relativePaths.slice(2));
  const before = names.map(name => fs.readFileSync(path.join(stateDir, name), 'utf8'));
  assert.deepStrictEqual(ensureWorkspaceStateFiles(root, {}), []);
  assert.deepStrictEqual(names.map(name => fs.readFileSync(path.join(stateDir, name), 'utf8')), before);
  for (const [name, content] of Object.entries(existing)) {
    assert.strictEqual(fs.readFileSync(path.join(stateDir, name), 'utf8'), content);
  }
});

test('dry run reports missing files without creating directories or changing existing files', t => {
  const root = workspace(t);
  assert.deepStrictEqual(ensureWorkspaceStateFiles(root, {}, { dryRun: true }), relativePaths);
  assert.deepStrictEqual(fs.readdirSync(root), []);

  const stateDir = path.join(root, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'events.jsonl'), 'saved event\n');
  assert.deepStrictEqual(
    ensureWorkspaceStateFiles(root, {}, { dryRun: true }),
    relativePaths.filter(p => p !== path.join('.atris', 'state', 'events.jsonl')),
  );
  assert.deepStrictEqual(fs.readdirSync(stateDir), ['events.jsonl']);
  assert.strictEqual(fs.readFileSync(path.join(stateDir, 'events.jsonl'), 'utf8'), 'saved event\n');
});
