const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildCraftManifest, slugify } = require('../commands/pack-craft');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-pack-craft-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env = {} }) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...env,
    },
  });
  if (result.error) throw result.error;
  return result;
}

test('pack craft creates research pack structure with valid manifest', () => {
  const dir = makeTempDir();
  try {
    const topic = 'quantum error correction';
    const craft = runCli(['pack', 'craft', topic], { cwd: dir });
    assert.equal(craft.status, 0, `stdout:\n${craft.stdout}\nstderr:\n${craft.stderr}`);

    const target = path.join(dir, 'quantum-error-correction');
    assert.ok(fs.existsSync(path.join(target, 'pack.json')));
    assert.ok(fs.existsSync(path.join(target, 'atris', 'atris.md')));
    assert.ok(fs.existsSync(path.join(target, 'atris', 'now.md')));
    assert.ok(fs.existsSync(path.join(target, 'README.md')));
    assert.ok(fs.statSync(path.join(target, 'wiki')).isDirectory());
    assert.ok(fs.existsSync(path.join(target, 'wiki', 'index.md')));

    const manifest = JSON.parse(fs.readFileSync(path.join(target, 'pack.json'), 'utf8'));
    assert.equal(manifest.slug, 'quantum-error-correction');
    assert.equal(manifest.name, 'quantum-error-correction');
    assert.equal(manifest.title, 'Quantum Error Correction');
    assert.equal(manifest.description, `research pack on ${topic}, in progress`);
    assert.equal(manifest.author, '');
    assert.deepEqual(manifest.tags, []);
    assert.equal(manifest.version, '0.0.1');
    assert.deepEqual(manifest.versions, []);

    const now = fs.readFileSync(path.join(target, 'atris', 'now.md'), 'utf8');
    assert.match(now, /nothing gathered yet/);
    assert.match(now, new RegExp(topic));

    const boot = fs.readFileSync(path.join(target, 'atris', 'atris.md'), 'utf8');
    assert.match(boot, new RegExp(topic));
    assert.match(boot, /wiki-style pages under wiki\//);
    assert.match(boot, /atris pack publish --push/);

    const wikiIndex = fs.readFileSync(path.join(target, 'wiki', 'index.md'), 'utf8');
    assert.match(wikiIndex, /none yet/);

    assert.match(craft.stdout, /created quantum-error-correction -> quantum-error-correction/);
    assert.match(craft.stdout, /cd quantum-error-correction && claude/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack craft derives slug from multi-word topic and honors --dir', () => {
  const dir = makeTempDir();
  try {
    const topic = 'Large Language Model Routing';
    const craft = runCli(['pack', 'craft', topic, '--dir', 'custom-pack-home'], { cwd: dir });
    assert.equal(craft.status, 0, `stdout:\n${craft.stdout}\nstderr:\n${craft.stderr}`);

    const customTarget = path.join(dir, 'custom-pack-home');
    const manifest = JSON.parse(fs.readFileSync(path.join(customTarget, 'pack.json'), 'utf8'));
    assert.equal(manifest.slug, 'large-language-model-routing');
    assert.equal(slugify(topic), 'large-language-model-routing');
    assert.deepEqual(buildCraftManifest(topic, manifest.slug).description, manifest.description);
    assert.match(craft.stdout, /cd custom-pack-home && claude/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack craft refuses non-empty target without --force', () => {
  const dir = makeTempDir();
  try {
    const target = path.join(dir, 'existing-pack');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'notes.txt'), 'keep me', 'utf8');

    const craft = runCli(['pack', 'craft', 'existing topic', '--dir', 'existing-pack'], { cwd: dir });
    assert.equal(craft.status, 1, `stdout:\n${craft.stdout}\nstderr:\n${craft.stderr}`);
    assert.match(`${craft.stdout}\n${craft.stderr}`, /target is not empty: existing-pack/);
    assert.match(`${craft.stdout}\n${craft.stderr}`, /rerun with --force to overwrite/);
    assert.equal(fs.readFileSync(path.join(target, 'notes.txt'), 'utf8'), 'keep me');
    assert.ok(!fs.existsSync(path.join(target, 'pack.json')));
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack craft --force writes into non-empty target', () => {
  const dir = makeTempDir();
  try {
    const target = path.join(dir, 'redo-pack');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'notes.txt'), 'keep me', 'utf8');

    const craft = runCli(['pack', 'craft', 'redo topic', '--dir', target, '--force'], { cwd: dir });
    assert.equal(craft.status, 0, `stdout:\n${craft.stdout}\nstderr:\n${craft.stderr}`);
    assert.equal(fs.readFileSync(path.join(target, 'notes.txt'), 'utf8'), 'keep me');
    assert.ok(fs.existsSync(path.join(target, 'pack.json')));
    const manifest = JSON.parse(fs.readFileSync(path.join(target, 'pack.json'), 'utf8'));
    assert.equal(manifest.slug, 'redo-topic');
  } finally {
    cleanupTempDir(dir);
  }
});
