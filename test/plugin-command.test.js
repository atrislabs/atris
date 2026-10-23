const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pluginCommand } = require('../commands/plugin');

function withWorkspace(t, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-command-test-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  t.after(() => {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.env.HOME = root;
  process.chdir(root);
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  run(root, lines);
}

test('info previews an empty workspace with the default version', (t) => {
  withWorkspace(t, (root, lines) => {
    fs.mkdirSync(path.join(root, 'atris', 'skills'), { recursive: true });

    pluginCommand('info');

    const output = lines.join('\n');
    assert.match(output, /Name:    atris-workspace/);
    assert.match(output, /Version: 1\.0\.0/);
    assert.match(output, /Skills:  0/);
    assert.doesNotMatch(output, /Included skills:/);
    assert.match(output, /Commands: 1 \(\/atris-setup\)/);
    assert.deepStrictEqual(fs.readdirSync(root), ['atris']);
  });
});

test('preview discovers real skills and reads the package version', (t) => {
  withWorkspace(t, (root, lines) => {
    const skillDir = path.join(root, 'atris', 'skills', 'mail');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'),
      '---\nname: inbox-helper\ndescription: Read and organize mail\n---\n\n# Mail\n');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '2.3.4' }));

    pluginCommand('preview');

    const output = lines.join('\n');
    assert.match(output, /Version: 2\.3\.4/);
    assert.match(output, /Skills:  1/);
    assert.match(output, /Included skills:/);
    assert.match(output, /inbox-helper\s+Read and organize mail/);
    assert.match(output, /Run "atris plugin build" to package\./);
  });
});

test('publish help exits successfully before checking or changing the workspace', (t) => {
  withWorkspace(t, (root, lines) => {
    const exitSignal = new Error('intercepted exit');
    const exitCodes = [];
    t.mock.method(process, 'exit', (code) => {
      exitCodes.push(code);
      throw exitSignal;
    });

    assert.throws(() => pluginCommand('publish', '--help'), (error) => error === exitSignal);

    assert.deepStrictEqual(exitCodes, [0]);
    const output = lines.join('\n');
    assert.match(output, /Usage: atris plugin <subcommand>/);
    assert.match(output, /build \[--output=path\]/);
    assert.match(output, /publish \[--repo=path\]/);
    assert.match(output, /info\s+- Preview what will be included/);
    assert.deepStrictEqual(fs.readdirSync(root), []);
  });
});
