const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { gatherAtrisContext, resolveAtrisRoot } = require('../commands/console');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-console-shape-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Writes skills/, team/, TODO.md into whatever root it is handed. The same
// content, laid out flat or nested, must read the same.
function seedAtrisContent(root) {
  fs.mkdirSync(path.join(root, 'skills', 'aeo'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'skills', 'aeo', 'SKILL.md'),
    '---\nname: aeo\ndescription: write for AI answers\n---\n\nbody\n'
  );
  fs.mkdirSync(path.join(root, 'skills', 'writer'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', 'writer', 'SKILL.md'), '# writer\n');
  fs.mkdirSync(path.join(root, 'team', 'architect'), { recursive: true });
  fs.writeFileSync(path.join(root, 'team', 'architect', 'MEMBER.md'), '# architect\n');
  fs.writeFileSync(path.join(root, 'TODO.md'), '# TODO\n\n## Backlog\n- one\n- two\n- three\n');
}

// The flat shape: `pack.json` and content at the packet root, which is what
// `pack publish` writes in root mode and what `pack install` preserves.
function seedFlatPacket(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'pack.json'),
    `${JSON.stringify({ slug: 'atris-method', title: 'Atris Method', version: '0.1.0', origin: { type: 'file' } }, null, 2)}\n`
  );
  seedAtrisContent(dir);
}

test('a flat installed packet loads its own skills, team and tasks', () => {
  const dir = makeTempDir();
  try {
    const packDir = path.join(dir, 'atris-method');
    seedFlatPacket(packDir);

    assert.equal(resolveAtrisRoot(packDir), packDir, 'the packet folder is its own atris root');

    const ctx = gatherAtrisContext(packDir);
    assert.equal(ctx.hasAtris, true);
    assert.equal(ctx.skills.length, 2);
    assert.equal(ctx.teamMembers.length, 1);
    assert.equal(ctx.backlogCount, 3);
  } finally {
    cleanupTempDir(dir);
  }
});

test('a normal nested workspace still loads exactly as before', () => {
  const dir = makeTempDir();
  try {
    const atrisDir = path.join(dir, 'atris');
    fs.mkdirSync(atrisDir, { recursive: true });
    seedAtrisContent(atrisDir);

    assert.equal(resolveAtrisRoot(dir), atrisDir);

    const ctx = gatherAtrisContext(dir);
    assert.equal(ctx.hasAtris, true);
    assert.equal(ctx.skills.length, 2);
    assert.equal(ctx.teamMembers.length, 1);
    assert.equal(ctx.backlogCount, 3);
  } finally {
    cleanupTempDir(dir);
  }
});

test('nested wins over a pack.json at the repo root', () => {
  const dir = makeTempDir();
  try {
    // A pack source repo: pack.json at the root AND a real atris/ workspace.
    fs.writeFileSync(path.join(dir, 'pack.json'), '{"slug":"src"}\n');
    const atrisDir = path.join(dir, 'atris');
    fs.mkdirSync(atrisDir, { recursive: true });
    seedAtrisContent(atrisDir);

    assert.equal(resolveAtrisRoot(dir), atrisDir, 'existing workspaces never change shape');
  } finally {
    cleanupTempDir(dir);
  }
});

test('a folder that is neither shape loads nothing', () => {
  const dir = makeTempDir();
  try {
    assert.equal(resolveAtrisRoot(dir), null);
    // pack.json that is not readable JSON is not a packet
    fs.writeFileSync(path.join(dir, 'pack.json'), '{ broken');
    assert.equal(resolveAtrisRoot(dir), null);
    assert.equal(gatherAtrisContext(dir).hasAtris, false);
  } finally {
    cleanupTempDir(dir);
  }
});
