const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-experiments-command-'));
const previousHome = process.env.HOME;
process.env.HOME = root;
after(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
});

const { experimentsCommand, ensureExperimentsFramework } = require('../commands/experiments');

test('help describes experiment commands without preparing a workspace', (t) => {
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));

  assert.strictEqual(experimentsCommand('--help'), undefined);

  const output = lines.join('\n');
  assert.match(output, /Usage: atris experiments <subcommand> \[name\]/);
  assert.match(output, /keep <slug>.*measure\.py moves 0 to 1/);
  assert.match(output, /queue add\|list/);
  assert.strictEqual(fs.existsSync(path.join(root, 'atris')), false);
});

test('framework setup copies packaged files and preserves existing content on repeat', () => {
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, 'atris'), { recursive: true });

  const first = ensureExperimentsFramework(workspace, { silent: true });
  assert.strictEqual(first.atrisDir, path.join(workspace, 'atris'));
  assert.strictEqual(first.experimentsDir, path.join(workspace, 'atris', 'experiments'));
  assert.ok(first.created.includes('atris/experiments/'));
  assert.ok(first.created.includes('atris/experiments/README.md'));

  const readme = path.join(first.experimentsDir, 'README.md');
  const template = path.join(first.experimentsDir, '_template', 'pack', 'program.md');
  const packaged = path.join(__dirname, '..', 'atris', 'experiments');
  assert.strictEqual(fs.readFileSync(readme, 'utf8'), fs.readFileSync(path.join(packaged, 'README.md'), 'utf8'));
  assert.strictEqual(fs.readFileSync(template, 'utf8'), fs.readFileSync(path.join(packaged, '_template', 'pack', 'program.md'), 'utf8'));

  fs.writeFileSync(readme, 'custom documentation\n');
  fs.writeFileSync(template, 'custom program\n');
  const second = ensureExperimentsFramework(workspace, { silent: true });

  assert.deepStrictEqual(second.created, []);
  assert.strictEqual(fs.readFileSync(readme, 'utf8'), 'custom documentation\n');
  assert.strictEqual(fs.readFileSync(template, 'utf8'), 'custom program\n');
});
