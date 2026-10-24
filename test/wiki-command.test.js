const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function withWiki(callback) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-command-test-')));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousLog = console.log;
  const lines = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    console.log = (...args) => lines.push(args.join(' '));
    const { wikiCommand } = require('../commands/wiki');
    await callback({ root, lines, wikiCommand });
  } finally {
    console.log = previousLog;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('query help takes precedence over cloud and private mode arguments', async () => {
  await withWiki(async ({ lines, wikiCommand }) => {
    await wikiCommand('query', '--cloud', '--private', '--help');
    const output = lines.join('\n');
    assert.match(output, /Usage: atris query "question"/);
    assert.match(output, /Build a local or cloud wiki query prompt \(PROMPT ONLY\)/);
    assert.match(output, /--help, -h/);
    assert.doesNotMatch(output, /Usage: atris ingest/);
  });
});

test('entities returns an empty JSON graph when no graph file exists', async () => {
  await withWiki(async ({ root, lines, wikiCommand }) => {
    await wikiCommand('entities', '--json');
    assert.deepStrictEqual(JSON.parse(lines.join('\n')), {
      ok: true,
      action: 'entities',
      graph_path: path.join(root, 'atris', 'wiki', '.graph.json'),
      type: null,
      entities: [],
    });
    assert.strictEqual(fs.existsSync(path.join(root, 'atris')), false);
  });
});

test('entities filters real graph records by the requested type', async () => {
  await withWiki(async ({ root, lines, wikiCommand }) => {
    const wikiDir = path.join(root, 'atris', 'wiki');
    fs.mkdirSync(wikiDir, { recursive: true });
    const person = { name: 'Ada', type: 'person' };
    fs.writeFileSync(path.join(wikiDir, '.graph.json'), JSON.stringify({
      entities: [person, { name: 'Compiler', type: 'concept' }],
      relationships: [],
    }));
    await wikiCommand('entities', '--type', 'person', '--json');
    const output = JSON.parse(lines.join('\n'));
    assert.strictEqual(output.type, 'person');
    assert.deepStrictEqual(output.entities, [person]);
    lines.length = 0;
    await wikiCommand('entities', '--type', 'concept');
    assert.deepStrictEqual(lines, ['concept\tCompiler']);
  });
});
