const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { appCommand } = require('../commands/app');

// commands/app.js finds the workspace by walking up from process.cwd()
// looking for atris/atris.md or .atris/business.json. A temp dir with an
// atris/atris.md marker is a self-contained workspace.
function makeWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-app-command-'));
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'atris.md'), '# test workspace\n');

  const origCwd = process.cwd();
  const origLog = console.log;
  const origError = console.error;
  const origWrite = process.stdout.write;
  const origExit = process.exit;

  const lines = [];
  const errors = [];
  const written = [];

  process.chdir(root);
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  process.stdout.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  process.exit = (code) => {
    throw new Error(`exit:${code}`);
  };

  t.after(() => {
    console.log = origLog;
    console.error = origError;
    process.stdout.write = origWrite;
    process.exit = origExit;
    process.chdir(origCwd);
    fs.rmSync(root, { recursive: true, force: true });
  });

  return { root, lines, errors, written };
}

test('app init scaffolds APP.md, README.md, data/, and logs/', async (t) => {
  const { root, lines } = makeWorkspace(t);

  await appCommand('init', 'demo-app');

  const dir = path.join(root, 'apps', 'demo-app');
  assert.ok(fs.statSync(path.join(dir, 'data')).isDirectory());
  assert.ok(fs.statSync(path.join(dir, 'logs')).isDirectory());

  const appMd = fs.readFileSync(path.join(dir, 'APP.md'), 'utf8');
  assert.ok(appMd.includes('schema_version: 1'));
  assert.ok(appMd.includes('slug: demo-app'));
  assert.ok(appMd.includes('runtime: local'));
  assert.ok(appMd.includes('# demo-app'));

  const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  assert.ok(readme.includes('# demo-app'));

  assert.ok(lines.join('\n').includes('scaffolded'));
  assert.ok(lines.join('\n').includes('runtime: local'));
});

test('app init --runtime webhook writes webhook frontmatter', async (t) => {
  const { root } = makeWorkspace(t);

  await appCommand('init', 'hook-app', '--runtime', 'webhook');

  const appMd = fs.readFileSync(
    path.join(root, 'apps', 'hook-app', 'APP.md'),
    'utf8',
  );
  assert.ok(appMd.includes('runtime: webhook'));
  assert.ok(appMd.includes('webhook: https://example.com/hook'));
  assert.ok(appMd.includes('secrets: [HOOK_SECRET]'));
});

test('app list prints each app with runtime and access parsed from APP.md', async (t) => {
  const { root, lines } = makeWorkspace(t);

  await appCommand('init', 'demo-app');
  await appCommand('init', 'hook-app', '--runtime', 'webhook');

  lines.length = 0;
  await appCommand('list');

  const out = lines.join('\n');
  assert.ok(out.includes('demo-app'));
  assert.ok(out.includes('hook-app'));
  assert.ok(out.includes('runtime=local'));
  assert.ok(out.includes('runtime=webhook'));
  assert.ok(out.includes('access=business'));
  assert.ok(fs.existsSync(path.join(root, 'apps')));
});

test('app list on an empty workspace prints the create hint', async (t) => {
  const { lines } = makeWorkspace(t);

  await appCommand('list');

  const out = lines.join('\n');
  assert.ok(out.includes('no apps'));
  assert.ok(out.includes('atris app init <slug>'));
});

test('app show writes the APP.md contents to stdout', async (t) => {
  const { written } = makeWorkspace(t);

  await appCommand('init', 'demo-app');
  await appCommand('cat', 'demo-app');

  const out = written.join('');
  assert.ok(out.includes('slug: demo-app'));
  assert.ok(out.includes('## Guardrails'));
});

test('app with no subcommand prints help listing subcommands and runtimes', async (t) => {
  const { lines } = makeWorkspace(t);

  await appCommand();

  const out = lines.join('\n');
  assert.ok(out.includes('atris app'));
  assert.ok(out.includes('init <slug>'));
  assert.ok(out.includes('list'));
  assert.ok(out.includes('show <slug>'));
  assert.ok(out.includes('Runtimes: local'));
});

test('app init rejects a slug that is not lowercase alphanumerics and hyphens', async (t) => {
  const { root, errors } = makeWorkspace(t);

  await assert.rejects(() => appCommand('init', 'Demo_App'), /exit:1/);

  assert.ok(
    errors.join('\n').includes('lowercase alphanumerics'),
    'should explain the slug format',
  );
  assert.ok(!fs.existsSync(path.join(root, 'apps', 'Demo_App')));
});

test('app init --runtime with an unknown runtime exits and scaffolds nothing', async (t) => {
  const { root, errors } = makeWorkspace(t);

  await assert.rejects(
    () => appCommand('init', 'demo-app', '--runtime', 'bogus'),
    /exit:1/,
  );

  assert.ok(errors.join('\n').includes('--runtime must be one of:'));
  assert.ok(!fs.existsSync(path.join(root, 'apps', 'demo-app')));
});

test('an unknown subcommand exits 1 after printing help', async (t) => {
  const { lines, errors } = makeWorkspace(t);

  await assert.rejects(() => appCommand('bogus'), /exit:1/);

  assert.ok(errors.join('\n').includes('unknown subcommand: bogus'));
  assert.ok(lines.join('\n').includes('Subcommands:'));
});
