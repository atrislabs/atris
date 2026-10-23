const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanAtris } = require('../commands/clean');

// These synchronous tests change cwd and capture console output only for the
// duration of each call. No journals or dated claims exercise clock-based paths.
function workspace(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-atris-test-'));
  const cwd = process.cwd();
  const log = console.log;
  const savedEnv = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => key === 'HOME' || key.startsWith('ATRIS_')));
  const output = [];
  try {
    for (const key of Object.keys(savedEnv)) delete process.env[key];
    process.env.HOME = root;
    process.chdir(root);
    fs.mkdirSync('atris');
    console.log = (...args) => output.push(args.join(' '));
    run(root, output);
  } finally {
    console.log = log;
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) {
      if (key === 'HOME' || key.startsWith('ATRIS_')) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function seedRepairs() {
  fs.writeFileSync('entry.js', 'function helloWorld() {\n  return 1;\n}\n');
  fs.writeFileSync('atris/MAP.md', '`entry.js:99` (helloWorld function)\n');
  fs.writeFileSync('atris/TODO.md', '# Tasks\n\n### Empty\n\n(empty)\n\n### Keep\n\n- [ ] Useful work\n');
}

test('cleanAtris repairs map references and removes only empty task sections', () => {
  workspace((root, output) => {
    seedRepairs();
    const result = cleanAtris({ json: true });
    assert.strictEqual(result.healedRefs, 1);
    assert.deepStrictEqual(result.healedRefDetails, [
      { old: '`entry.js:99`', new: '`entry.js:1`', symbol: 'helloWorld' },
    ]);
    assert.strictEqual(fs.readFileSync('atris/MAP.md', 'utf8'), '`entry.js:1` (helloWorld function)\n');
    assert.strictEqual(result.cleanedSections, 1);
    assert.strictEqual(fs.readFileSync('atris/TODO.md', 'utf8'), '# Tasks\n\n### Keep\n\n- [ ] Useful work\n');
    const payload = JSON.parse(output.join('\n'));
    assert.strictEqual(payload.action, 'clean');
    assert.strictEqual(payload.dry_run, false);
    assert.strictEqual(payload.results.map_refs.healed_count, 1);
    assert.strictEqual(payload.results.sections.cleaned_count, 1);
  });
});

test('cleanAtris dry run reports repairs and missing references without writing', () => {
  workspace((root, output) => {
    seedRepairs();
    fs.appendFileSync('atris/MAP.md', '`missing.js:7`\n');
    const map = fs.readFileSync('atris/MAP.md', 'utf8');
    const todo = fs.readFileSync('atris/TODO.md', 'utf8');
    const result = cleanAtris({ json: true, dryRun: true });
    assert.strictEqual(result.healedRefs, 1);
    assert.strictEqual(result.cleanedSections, 1);
    assert.deepStrictEqual(result.unhealableRefs, [
      { file: 'missing.js', line: 7, reason: 'File not found' },
    ]);
    assert.strictEqual(fs.readFileSync('atris/MAP.md', 'utf8'), map);
    assert.strictEqual(fs.readFileSync('atris/TODO.md', 'utf8'), todo);
    const payload = JSON.parse(output.join('\n'));
    assert.strictEqual(payload.ok, false);
    assert.strictEqual(payload.dry_run, true);
    assert.strictEqual(payload.results.map_refs.verb, 'would_heal');
    assert.strictEqual(payload.results.sections.verb, 'would_clean');
    assert.ok(payload.manual_action.includes('Manually fix unhealable MAP.md refs'));
  });
});

test('cleanAtris accepts an empty atris folder without creating housekeeping files', () => {
  workspace((root, output) => {
    const result = cleanAtris({ json: true });
    assert.deepStrictEqual(result.staleTasks, []);
    assert.deepStrictEqual(result.unhealableRefs, []);
    assert.deepStrictEqual(result.stalePages, []);
    assert.deepStrictEqual(result.mapScripts, []);
    assert.strictEqual(result.healedRefs, 0);
    assert.strictEqual(result.cleanedSections, 0);
    assert.strictEqual(result.archivedJournals, 0);
    assert.deepStrictEqual(fs.readdirSync('atris'), []);
    const payload = JSON.parse(output.join('\n'));
    assert.strictEqual(payload.ok, true);
    assert.deepStrictEqual(payload.manual_action, []);
    assert.strictEqual(payload.results.dead_code.count, 0);
  });
});
