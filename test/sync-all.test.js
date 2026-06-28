const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { buildSyncAllPlan, syncWorkspaceTemplate, SYNC_ALL_FILES } = require('../commands/sync');

// The atris-cli package root is the real source of truth. We pass it in
// as pkgRoot so tests use the live canonical files for content comparison.
const PKG_ROOT = path.resolve(__dirname, '..');

function cleanup(cwd) {
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
}

function mkProject(root, relPath, atrisMdContent, { businessJson = false } = {}) {
  const projectRoot = path.join(root, relPath);
  const atrisDir = path.join(projectRoot, 'atris');
  fs.mkdirSync(atrisDir, { recursive: true });
  fs.writeFileSync(path.join(atrisDir, 'atris.md'), atrisMdContent);
  if (businessJson) {
    fs.mkdirSync(path.join(projectRoot, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.atris', 'business.json'), '{}');
  }
  return projectRoot;
}

function findPlan(plan, projectRoot) {
  return plan.find((p) => path.resolve(p.projectRoot) === path.resolve(projectRoot));
}

// --- discovery ---

test('empty directory → no projects', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sync-empty-'));
  try {
    const { projects, plan } = buildSyncAllPlan({ root, pkgRoot: PKG_ROOT });
    assert.strictEqual(projects.length, 0);
    assert.strictEqual(plan.length, 0);
  } finally {
    cleanup(root);
  }
});

test('nested atris/atris.md gets discovered', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sync-discover-'));
  try {
    mkProject(root, 'my-repo', '# atris\n\nAtris exists because agents\n');
    const { projects } = buildSyncAllPlan({ root, pkgRoot: PKG_ROOT });
    assert.strictEqual(projects.length, 1);
    assert.match(projects[0], /my-repo$/);
  } finally {
    cleanup(root);
  }
});

// --- heuristic: atris-business/* always skipped regardless of content ---

test('atris-business/* with canonical atris.md → still skipped', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sync-bizdir-'));
  try {
    const customer = mkProject(
      root,
      'atris-business/acme',
      '# atris\n\nAtris exists because agents make work fast but unsafe\n'
    );
    const { plan } = buildSyncAllPlan({ root, pkgRoot: PKG_ROOT });
    const entry = findPlan(plan, customer);
    assert.ok(entry, 'project should be discovered');
    assert.strictEqual(entry.isBusiness, true, 'atris-business/* must skip regardless of atris.md content');
  } finally {
    cleanup(root);
  }
});

// --- heuristic: business.json alone does not gate when not under atris-business/ ---

test('business.json + canonical atris.md (dev repo like atris-cli) → syncs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sync-bizjson-'));
  try {
    const devRepo = mkProject(
      root,
      'some-dev-repo',
      '# atris\n\nAtris exists because agents make work fast but unsafe\n',
      { businessJson: true }
    );
    const { plan } = buildSyncAllPlan({ root, pkgRoot: PKG_ROOT });
    const entry = findPlan(plan, devRepo);
    assert.strictEqual(entry.isBusiness, false, 'dev repo with business.json but canonical atris.md should sync');
    assert.strictEqual(entry.isCustomized, false);
  } finally {
    cleanup(root);
  }
});

test('business.json + Boot Protocol atris.md → detected as business, skipped', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sync-bizboot-'));
  try {
    const biz = mkProject(
      root,
      'some-business',
      '# Atris Boot Protocol — Test\n\nYou are in the Test workspace.\n',
      { businessJson: true }
    );
    const { plan } = buildSyncAllPlan({ root, pkgRoot: PKG_ROOT });
    const entry = findPlan(plan, biz);
    assert.strictEqual(entry.isBusiness, true);
  } finally {
    cleanup(root);
  }
});

// --- heuristic: customized atris.md (not canonical, not old-generic) → skipped ---

test('customized atris.md title → flagged as customized, skipped', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sync-custom-'));
  try {
    const custom = mkProject(
      root,
      'weird-repo',
      '# atris.md — Custom Title for This Project\n\nSome project-specific prose\n'
    );
    const { plan } = buildSyncAllPlan({ root, pkgRoot: PKG_ROOT });
    const entry = findPlan(plan, custom);
    assert.strictEqual(entry.isBusiness, false);
    assert.strictEqual(entry.isCustomized, true, 'customized atris.md must skip');
  } finally {
    cleanup(root);
  }
});

test('old generic template → not customized, syncs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sync-oldgeneric-'));
  try {
    const oldRepo = mkProject(
      root,
      'legacy-repo',
      '# atris.md\n\n> Drop this file anywhere. AI agent team activates.\n'
    );
    const { plan } = buildSyncAllPlan({ root, pkgRoot: PKG_ROOT });
    const entry = findPlan(plan, oldRepo);
    assert.strictEqual(entry.isBusiness, false);
    assert.strictEqual(entry.isCustomized, false, 'old generic template must sync');
  } finally {
    cleanup(root);
  }
});

test('new canonical atris.md → not customized, syncs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sync-canonical-'));
  try {
    const newRepo = mkProject(
      root,
      'new-repo',
      '# atris\n\nAtris exists because agents make work fast but unsafe\n'
    );
    const { plan } = buildSyncAllPlan({ root, pkgRoot: PKG_ROOT });
    const entry = findPlan(plan, newRepo);
    assert.strictEqual(entry.isBusiness, false);
    assert.strictEqual(entry.isCustomized, false);
  } finally {
    cleanup(root);
  }
});

// --- self-reference: pkgRoot always syncs even with business.json ---

test('pkgRoot (atris-cli itself) bypasses business gate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sync-self-'));
  try {
    // Create a fake "pkgRoot" under the test directory that LOOKS like atris-cli:
    // it has atris/atris.md and .atris/business.json. The test proves the
    // self-reference override works when projectRoot === pkgRoot.
    const fakePkg = mkProject(
      root,
      'fake-atris-cli',
      '# atris.md\n\n> Drop this file anywhere.\n',
      { businessJson: true }
    );
    // fakePkg has business.json + non-canonical atris.md, so it WOULD normally
    // be detected as business OR customized. Passing it as pkgRoot makes the
    // self-reference override kick in.
    const { plan } = buildSyncAllPlan({ root, pkgRoot: fakePkg });
    const entry = findPlan(plan, fakePkg);
    assert.strictEqual(entry.isBusiness, false, 'self-reference must override business detection');
    assert.strictEqual(entry.isCustomized, false, 'self-reference must override customized detection');
  } finally {
    cleanup(root);
  }
});

// --- changes list: reflects real file diffs ---

test('changes list is empty when target matches source exactly', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sync-nochange-'));
  try {
    // Seed target with the live canonical atris.md content.
    const canonicalAtrisMd = fs.readFileSync(path.join(PKG_ROOT, 'atris.md'), 'utf8');
    const repo = mkProject(root, 'my-repo', canonicalAtrisMd);
    const { plan } = buildSyncAllPlan({ root, pkgRoot: PKG_ROOT });
    const entry = findPlan(plan, repo);
    assert.ok(!entry.isBusiness);
    assert.ok(!entry.isCustomized);
    // atris.md should NOT be in changes (identical); other files (PERSONA.md,
    // CLAUDE.md, etc.) ARE missing so they WILL be in changes.
    assert.ok(!entry.changes.includes('atris.md'), 'identical atris.md should not be in changes');
  } finally {
    cleanup(root);
  }
});

// --- discovery excludes noise directories ---

test('node_modules and .git subtrees are not scanned', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sync-noise-'));
  try {
    // Planted atris/atris.md under node_modules — must be ignored.
    mkProject(root, 'node_modules/some-pkg', '# atris\n\nAtris exists because agents\n');
    mkProject(root, '.git/worktrees/foo', '# atris\n\nAtris exists because agents\n');
    mkProject(root, 'real-project', '# atris\n\nAtris exists because agents\n');
    const { projects } = buildSyncAllPlan({ root, pkgRoot: PKG_ROOT });
    assert.strictEqual(projects.length, 1);
    assert.match(projects[0], /real-project$/);
  } finally {
    cleanup(root);
  }
});

test('workspace template sync repairs broken .claude skills link', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sync-broken-claude-'));
  try {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.symlinkSync(path.join(root, 'missing-skills-target'), path.join(root, '.claude', 'skills'));

    assert.doesNotThrow(() => syncWorkspaceTemplate(root, {
      name: 'Broken Skills Co',
      slug: 'broken-skills',
      business_id: 'biz-broken-skills',
      workspace_id: 'ws-broken-skills',
    }, { templateName: 'business' }));

    assert.ok(fs.lstatSync(path.join(root, '.claude', 'skills')).isDirectory());
    assert.ok(fs.existsSync(path.join(root, '.claude', 'skills', 'aeo', 'SKILL.md')));
  } finally {
    cleanup(root);
  }
});

// --- constants ---

test('SYNC_ALL_FILES covers the 4 canonical docs', () => {
  const targets = SYNC_ALL_FILES.map((f) => f.target).sort();
  assert.deepStrictEqual(targets, [
    'CLAUDE.md',
    'GETTING_STARTED.md',
    'PERSONA.md',
    'atris.md',
  ]);
});
