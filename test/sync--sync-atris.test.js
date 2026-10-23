const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { syncAtris } = require('../commands/sync');

// Preview mode skips workspace timestamps, wiki creation, and member export.
// Each test restores the process globals even if sync or an assertion throws.
function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-atris-test-'));
  const cwd = process.cwd();
  const env = { ...process.env };
  const log = console.log;
  const lines = [];
  t.after(() => {
    console.log = log;
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  process.env.HOME = root;
  process.chdir(root);
  console.log = (...args) => lines.push(args.join(' '));
  fs.mkdirSync(path.join(root, 'atris'));
  return { root, lines };
}

function snapshot(root) {
  const entries = {};
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full);
      entries[relative] = entry.isDirectory() ? null : fs.readFileSync(full, 'utf8');
      if (entry.isDirectory()) walk(full);
    }
  }
  walk(root);
  return entries;
}

test('syncAtris previews updates for an empty workspace without writing', (t) => {
  const { root, lines } = workspace(t);
  const before = snapshot(root);

  const result = syncAtris({ dryRun: true, yes: false, force: false });

  assert.strictEqual(result, undefined);
  assert.ok(lines.includes('Would update atris.md'));
  assert.ok(lines.includes('Would update AGENTS.md voice card'));
  assert.ok(lines.includes('Plan only. Re-run with --yes to write these files.'));
  assert.match(lines.join('\n'), /Dry run: \d+ file\(s\) would update, \d+ unchanged; no changes made\./);
  assert.deepStrictEqual(snapshot(root), before);
});

test('syncAtris previews legacy migration while preserving existing destinations', (t) => {
  const { root, lines } = workspace(t);
  const legacy = path.join(root, 'atris', 'agent_team');
  const team = path.join(root, 'atris', 'team');
  fs.mkdirSync(legacy);
  fs.mkdirSync(team);
  fs.writeFileSync(path.join(legacy, 'custom.md'), 'legacy member\n');
  fs.writeFileSync(path.join(legacy, 'kept.md'), 'old member\n');
  fs.writeFileSync(path.join(team, 'kept.md'), 'customized member\n');
  fs.writeFileSync(path.join(root, 'atris', 'TASK_CONTEXTS.md'), 'legacy tasks\n');
  const before = snapshot(root);

  // An explicit preview wins even when writes have been authorized.
  syncAtris({ dryRun: true, yes: true, force: false });

  assert.ok(lines.includes('  Would migrate custom.md'));
  assert.ok(!lines.includes('  Would migrate kept.md'));
  assert.ok(lines.includes('  Would remove old agent_team/ folder'));
  assert.ok(lines.includes('Would migrate TASK_CONTEXTS.md to TODO.md'));
  assert.deepStrictEqual(snapshot(root), before);
});

test('syncAtris rejects a legacy team path that is a file without changing it', (t) => {
  const { root } = workspace(t);
  fs.writeFileSync(path.join(root, 'atris', 'agent_team'), 'not a directory\n');
  const before = snapshot(root);

  assert.throws(
    () => syncAtris({ dryRun: true, yes: true, force: false }),
    (error) => error.code === 'ENOTDIR',
  );
  assert.deepStrictEqual(snapshot(root), before);
});
