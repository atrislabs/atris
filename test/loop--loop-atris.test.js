const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loopAtris } = require('../commands/loop');

async function inProject(run) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-loop-test-')));
  const cwd = process.cwd();
  const log = console.log;
  const output = [];
  try {
    // Preseed metadata so dry runs leave these fixed fixtures unchanged.
    fs.mkdirSync(path.join(root, 'atris/wiki/concepts'), { recursive: true });
    for (const name of ['wiki.md', 'index.md', 'log.md', 'STATUS.md']) {
      fs.writeFileSync(path.join(root, 'atris/wiki', name), `# ${name}\n`);
    }
    process.chdir(root);
    console.log = (...args) => output.push(args.join(' '));
    // Neither commands/loop nor lib/wiki reads HOME or ATRIS_* variables.
    await run(root, output);
  } finally {
    console.log = log;
    process.chdir(cwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('loopAtris reports a stale orphan and leaves status and log alone in dry run', async () => {
  await inProject(async (root, output) => {
    fs.writeFileSync(path.join(root, 'atris/wiki/concepts/example.md'),
      '---\nsources: [missing.md]\nlast_compiled: 2000-01-01\n---\n# Example\n');
    fs.writeFileSync(path.join(root, 'README.md'), '# Source\n');
    const result = await loopAtris(['--dry-run', '--json']);
    assert.strictEqual(result, undefined);
    assert.strictEqual(output.length, 1);
    const report = JSON.parse(output[0]);
    assert.deepStrictEqual(report, {
      wikiDir: path.join(root, 'atris/wiki'),
      pageCount: 1,
      stalePages: [{ page: 'atris/wiki/concepts/example.md', staleSource: 'missing.md', reason: 'missing source' }],
      orphanPages: ['atris/wiki/concepts/example.md'],
      nextSources: ['README.md'],
      health: '1 stale page need recompiling',
      nextMove: 'recompile atris/wiki/concepts/example.md from missing.md',
      details: ['pages=1', 'stale=1', 'orphans=1', 'suggested=1'],
    });
    for (const name of ['STATUS.md', 'log.md']) {
      assert.strictEqual(fs.readFileSync(path.join(root, 'atris/wiki', name), 'utf8'), `# ${name}\n`);
    }
  });
});

test('loopAtris clamps negative limits and defaults invalid limits to three sources', async () => {
  await inProject(async (root, output) => {
    for (const name of ['README.md', 'atris/CLAUDE.md', 'atris/atris.md', 'atris.md']) {
      fs.writeFileSync(path.join(root, name), '# Source\n');
    }
    await loopAtris(['--dry-run', '--json', '--limit=-2']);
    const limited = JSON.parse(output.pop());
    assert.deepStrictEqual(limited.nextSources, ['README.md']);
    assert.strictEqual(limited.health, 'wiki is stable, 1 high-value source ready for ingest');
    assert.strictEqual(limited.nextMove, 'ingest README.md');
    await loopAtris(['--dry-run', '--json', '--limit=invalid']);
    assert.deepStrictEqual(JSON.parse(output.pop()).nextSources,
      ['README.md', 'atris/CLAUDE.md', 'atris/atris.md']);
  });
});

test('loopAtris prints the healthy empty wiki report without optional sections', async () => {
  await inProject(async (_root, output) => {
    await loopAtris(['--dry-run']);
    const text = output.join('\n');
    assert.match(text, /Pages: 0 \| Stale: 0 \| Orphans: 0 \| Next: 0/);
    assert.match(text, /Health: wiki is in good shape/);
    assert.ok(text.includes('Next move: run `atris query "..."` or ingest a new source'));
    assert.doesNotMatch(text, /^(Stale pages:|Orphans:|Next ingest candidates:)$/m);
  });
});
