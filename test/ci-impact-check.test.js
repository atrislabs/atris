'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { plan } = require('../scripts/ci-impact-check');

const selector = require.resolve('../scripts/ci-impact-check');
const phone = ['gm-phone-health', 'gm-phone-layout', 'gm-phone-hands', 'gm-phone-motion', 'gm-phone']
  .map(name => 'test/' + name + '.test.js');
const smoke = 'test/smoke.test.js';
const alpha = 'test/alpha.test.js';
const beta = 'test/beta.test.js';

function write(root, file, contents) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-impact-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'test/fast-tests.txt', smoke + '\n');
  for (const file of [...phone, smoke, 'test/orb-walk.test.js', 'test/other.test.js',
    'test/repo-hygiene.test.js', 'test/model-name-ratchet.test.js']) {
    write(root, file, `console.log(${JSON.stringify('executed ' + file)});\n`);
  }
  for (const name of ['alpha', 'beta']) {
    write(root, `lib/${name}.js`, 'module.exports = 1;\n');
    write(root, `test/${name}.test.js`, `require('../lib/${name}');\nconsole.log('executed test/${name}.test.js');\n`);
  }
  write(root, 'lib/gm-phone-page.js', 'module.exports = () => "<html></html>";\n');
  return root;
}

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function runQueue(root, base) {
  const run = spawnSync(process.execPath, ['-e',
    "process.exitCode = require(process.argv[1]).main(['run', process.argv[2], '1/1'], process.cwd());",
    selector, base], { cwd: root, encoding: 'utf8' });
  return { status: run.status, text: run.stdout + run.stderr };
}

test('a covered source selects its own tests while the inline phone page selects browser checks', t => {
  const root = fixture(t);
  const routine = plan(root, ['lib/alpha.js']);
  assert.equal(routine.full, false, routine.reason);
  assert.ok(routine.files.includes(alpha));
  assert.ok(!routine.files.some(file => phone.includes(file)), routine.files.join(', '));

  const view = plan(root, ['lib/gm-phone-page.js']);
  assert.equal(view.full, false, view.reason);
  for (const file of phone) assert.ok(view.files.includes(file), file + ' missing from phone coverage');
});

test('a command exporting a shared helper keeps the tests of the library that uses it', t => {
  const root = fixture(t);
  write(root, 'commands/caretaker.js', 'exports.checked = () => true;\n');
  write(root, 'lib/pr-sweep.js', "module.exports = require('../commands/caretaker').checked;\n");
  write(root, 'test/pr-sweep.test.js', "require('../lib/pr-sweep');\n");
  write(root, 'test/caretaker.test.js', "require('../commands/caretaker');\n");
  const changed = plan(root, ['commands/caretaker.js']);
  assert.equal(changed.full, false, changed.reason);
  assert.ok(changed.files.includes('test/pr-sweep.test.js'), changed.files.join(', '));
});

test('docs skip the phone browser while unmapped inputs and changes to CI keep the full suite', t => {
  const root = fixture(t);
  const docs = plan(root, ['docs/guide.md']);
  assert.equal(docs.full, false, docs.reason);
  assert.ok(!docs.files.some(file => phone.includes(file)));
  for (const file of ['lib/new-unmapped.js', '.github/workflows/ci.yml', 'scripts/ci-impact-check.js', 'package.json']) {
    assert.equal(plan(root, [file]).full, true, file);
  }
});

test('the real group compares its combined head to the base across two pull requests', t => {
  const root = fixture(t);
  git(root, 'init', '-q', '-b', 'queue');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  for (const name of ['alpha', 'beta']) {
    git(root, 'switch', '-qc', name, base);
    write(root, `lib/${name}.js`, 'module.exports = 2;\n');
    git(root, 'commit', '-qam', name);
    git(root, 'switch', '-q', 'queue');
    git(root, 'merge', '-q', '--no-ff', name, '-m', 'queue ' + name);
  }
  const combined = runQueue(root, base);
  assert.equal(combined.status, 0, combined.text);
  for (const file of [alpha, beta]) assert.ok(combined.text.includes('executed ' + file), combined.text);
  assert.ok(!combined.text.includes('executed test/gm-phone'), combined.text);

  // Rename a covered module without repairing the existing consumer. A
  // selector that reads only the new name can lose the red test.
  git(root, 'mv', 'lib/alpha.js', 'lib/renamed.js');
  write(root, 'test/renamed.test.js', "require('../lib/renamed');\n");
  git(root, 'add', 'test/renamed.test.js');
  git(root, 'commit', '-qm', 'move alpha');
  const broken = runQueue(root, base);
  assert.notEqual(broken.status, 0, broken.text);
  assert.match(broken.text, /Cannot find module.*lib\/alpha/i);
  assert.notEqual(runQueue(root, 'missing-base-ref').status, 0);
});
