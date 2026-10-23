const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// These tests deliberately avoid generation and the date-based inbox helper.
// Explicit output paths also avoid the date-based default filename.
async function inWorkspace(run) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-visualize-test-')));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const overrides = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith('ATRIS_'))
  );
  const log = console.log;
  const lines = [];
  try {
    process.env.HOME = root;
    for (const key of Object.keys(overrides)) delete process.env[key];
    process.chdir(root);
    console.log = (...args) => lines.push(args.join(' '));
    const { visualizeAtris } = require('../commands/visualize');
    await run({ root, lines, visualizeAtris });
  } finally {
    console.log = log;
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    Object.assign(process.env, overrides);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('visualizeAtris dry run shapes a workflow using real workspace context', async () => {
  await inWorkspace(async ({ root, lines, visualizeAtris }) => {
    fs.mkdirSync('.atris');
    fs.mkdirSync('atris/context', { recursive: true });
    fs.writeFileSync('.atris/business.json', JSON.stringify({ name: 'Example Studio', slug: 'example' }));
    fs.writeFileSync('atris/MAP.md', 'The onboarding guide lives in context.');
    fs.writeFileSync('atris/context/onboarding.md', 'Connect an account, then invite a teammate.');

    const result = await visualizeAtris(['onboarding', 'workflow', '--dry-run', '--out', 'preview.png']);
    assert.strictEqual(result, undefined);
    const output = lines.join('\n');
    assert.match(output, /Atris Visualize dry run/);
    assert.ok(lines.includes('Model:  gpt-image-2'));
    assert.ok(lines.includes('Size:   1536x1024'));
    assert.ok(lines.includes(`Output: ${path.join(root, 'preview.png')}`));
    assert.match(output, /Artifact type: workflow/);
    assert.match(output, /Primary request: onboarding workflow/);
    assert.match(output, /Workspace: Example Studio \(example\)/);
    assert.match(output, /Connect an account, then invite a teammate\./);
    assert.strictEqual(fs.existsSync('preview.png'), false);
  });
});

test('visualizeAtris raw dry run preserves literal flag-like prompt after separator', async () => {
  await inWorkspace(async ({ root, lines, visualizeAtris }) => {
    await visualizeAtris(['--dry-run', '--raw', '--model=example-model', '--size=1024x1024',
      '--out', path.join(root, 'raw.png'), '--', '--help', 'literal request']);
    assert.ok(lines.includes('Model:  example-model'));
    assert.ok(lines.includes('Size:   1024x1024'));
    assert.strictEqual(lines[lines.length - 1], '--help literal request');
    assert.doesNotMatch(lines.join('\n'), /Design requirements:|Usage:/);
    assert.deepStrictEqual(fs.readdirSync(root), []);
  });
});

test('visualizeAtris handles empty workspace and invalid business metadata in a dry run', async () => {
  await inWorkspace(async ({ lines, visualizeAtris }) => {
    fs.mkdirSync('.atris');
    fs.writeFileSync('.atris/business.json', '{invalid json');
    await visualizeAtris(['a simple illustration', '--dry-run', '--out=empty.png']);
    const output = lines.join('\n');
    assert.match(output, /Artifact type: business explainer/);
    assert.match(output, /Primary request: a simple illustration/);
    assert.doesNotMatch(output, /Workspace context to respect:|Workspace:/);
    assert.strictEqual(fs.existsSync('empty.png'), false);
  });
});

test('visualizeAtris bare help and help flag print usage without generation', async () => {
  await inWorkspace(async ({ root, lines, visualizeAtris }) => {
    for (const args of [['help'], ['--help'], ['-h']]) {
      lines.length = 0;
      assert.strictEqual(await visualizeAtris(args), undefined);
      assert.ok(lines.includes('Usage: atris visualize <prompt> [options]'));
      assert.ok(lines.includes('No prompt keeps the legacy inbox visualization helper.'));
      assert.doesNotMatch(lines.join('\n'), /Generating visual|dry run|Saved:/);
    }
    assert.deepStrictEqual(fs.readdirSync(root), []);
  });
});
