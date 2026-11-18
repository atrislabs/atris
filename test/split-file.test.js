'use strict';

// The feature-folder split tool (lib/split-file.js) on a tiny made-up file: it moves only what
// is safe, the code still runs the same, the original rebuilds exactly, and verify catches a
// missing borrowed name. Needs the TypeScript parser, which this package does not depend on.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const split = require('../lib/split-file');

let ts = null;
try { ts = split.loadTypescript(path.join(__dirname, '..')); } catch {}
const skip = ts ? false : 'typescript is not installed (npm i --prefix ~/.cache/atris-split typescript)';

const BIG = `'use strict';
// A tiny made-up file for the split tool.
const path = require('path');
const { twice } = require('../lib/helper');

const LIMIT = 3;
const BOOT = startupValue(); // runs while loading, so it must stay

function startupValue() {
  return bootHelper() + 1;
}

function bootHelper() { return 1; }

/** Doubles and clips. */
function clip(n) {
  return Math.min(twice(n), LIMIT * 10);
}

function here() {
  return path.basename(__dirname);
}

function lazyHelper() {
  return require('../lib/helper').twice(5);
}

function shared(x) { return '<' + x + '>'; }

function alpha(x) { return shared(clip(x)); } // a note on the same line

function beta(x) {
  return shared(x) + here() + require('../lib/helper').twice(1);
}

const ROUTES = [{ name: 'alpha', run: alpha }];

function main() {
  return [alpha(2), beta('b'), lazyHelper(), BOOT, ROUTES[0].run(4)].join(' ');
}

module.exports = { main, alpha, beta, clip, here };
`;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'split-file-test-'));
  fs.mkdirSync(path.join(root, 'lib'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'team', 'ann'), { recursive: true });
  fs.writeFileSync(path.join(root, 'lib', 'helper.js'), 'module.exports = { twice: (n) => n * 2 };\n');
  fs.writeFileSync(path.join(root, 'src', 'big.js'), BIG);
  fs.writeFileSync(path.join(root, 'team', 'ann', 'MEMBER.md'), '# Ann\n\nOwns alpha.\n');
  fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify({
    root: '.', source: 'src/big.js', outDir: 'src/big', teamDir: 'team', date: '2026-11-16', keep: ['main'],
    features: [
      { name: 'alpha', owner: 'ann', summary: 'Alpha things.', names: ['alpha'] },
      { name: 'beta', summary: 'Beta things.', patterns: ['^beta$'] },
    ],
  }));
  return root;
}

function runMain(root) {
  const res = spawnSync(process.execPath, ['-e', `console.log(require(${JSON.stringify(path.join(root, 'src', 'big.js'))}).main())`], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout;
}

test('split-file moves only safe functions, keeps behaviour, and rebuilds the original exactly', { skip }, (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = runMain(root);
  const plan = split.loadPlan(path.join(root, 'plan.json'));
  const analysis = split.analyzeSource(ts, BIG);
  const decision = split.decide(plan, analysis);
  assert.equal(decision.assigned.get('alpha'), 'alpha');
  assert.equal(decision.assigned.get('clip'), 'alpha', 'only alpha reaches clip');
  assert.equal(decision.assigned.get('beta'), 'beta');
  assert.equal(decision.assigned.get('here'), 'beta');
  assert.equal(decision.assigned.get('shared'), 'core', 'alpha and beta both reach shared');
  assert.match(decision.pinned.get('startupValue'), /runs while the file loads/);
  assert.match(decision.pinned.get('bootHelper'), /runs while the file loads, through startupValue/);
  assert.equal(decision.assigned.has('lazyHelper'), false, 'no feature reaches it, so it stays');
  assert.equal(decision.pinned.get('main'), 'kept by the plan');

  const built = split.buildSplit(plan, analysis, decision);
  assert.deepEqual(built.features.map((f) => f.name).sort(), ['alpha', 'beta', 'core']);

  // Do the real split through the command line, then check every proof.
  const res = withTypescriptEnv(() => spawnSync(process.execPath, [path.join(__dirname, '..', 'lib', 'split-file.js'), 'split', '--plan', path.join(root, 'plan.json')], { encoding: 'utf8' }));
  assert.equal(res.status, 0, res.stderr);
  const betaFile = fs.readFileSync(path.join(root, 'src', 'big', 'beta', 'beta.js'), 'utf8');
  assert.match(betaFile, /path\.basename\(MAIN_DIR\)/);
  assert.match(betaFile, /require\('\.\.\/\.\.\/\.\.\/lib\/helper'\)/);
  const mainFile = fs.readFileSync(path.join(root, 'src', 'big.js'), 'utf8');
  assert.match(mainFile, /function startupValue\(\)/);
  assert.match(mainFile, /function lazyHelper\(\)/);
  assert.doesNotMatch(mainFile, /function clip\(/);
  assert.equal(runMain(root), before, 'the code still does the same thing');
  assert.match(fs.readFileSync(path.join(root, 'src', 'big', 'alpha', 'README.md'), 'utf8'), /^Owner: `ann` \(team\/ann\/MEMBER\.md\)$/m);
  assert.match(fs.readFileSync(path.join(root, 'src', 'big', 'beta', 'README.md'), 'utf8'), /^Owner: unassigned$/m);
  assert.match(fs.readFileSync(path.join(root, 'src', 'big', 'core', 'README.md'), 'utf8'), /^Owner: shared\./m);
  assert.match(fs.readFileSync(path.join(root, 'team', 'ann', 'MEMBER.md'), 'utf8'), /## Code I own\n\n- `src\/big\/alpha\/`/);

  const rebuilt = split.rebuild(split.loadPlan(path.join(root, 'plan.json')), ts);
  assert.equal(rebuilt.text, BIG, 'the original comes back byte for byte');
  const proof = split.verify(split.loadPlan(path.join(root, 'plan.json')), ts);
  assert.deepEqual(proof.results.filter((r) => !r.ok), []);

  // A borrowed name dropped from a folder is caught as a new unresolved name.
  const alphaPath = path.join(root, 'src', 'big', 'alpha', 'alpha.js');
  const drop = (list) => list.split(',').map((n) => n.trim()).filter((n) => n && n !== 'shared').join(', ');
  const alphaText = fs.readFileSync(alphaPath, 'utf8');
  assert.match(alphaText, /let [^;]*\bshared\b/);
  fs.writeFileSync(alphaPath, alphaText
    .replace(/let ([^;]*);/, (m, list) => `let ${drop(list)};`)
    .replace(/\(\{\n([^}]*)\n {2}\} = deps\)/, (m, list) => `({\n    ${drop(list)},\n  } = deps)`));
  const broken = split.verify(split.loadPlan(path.join(root, 'plan.json')), ts);
  const unresolved = broken.results.find((r) => r.check === 'unresolved');
  assert.equal(unresolved.ok, false);
  assert.match(unresolved.detail, /shared 0->1/);
});

test('split-file keeps a relative require spelling exactly through the move and back', () => {
  for (const spec of ['./autoland', '../lib/x', '../commands/brain', '.', '../lib/dir/']) {
    const moved = split.moveSpec(spec, '/r/commands', '/r/commands/task/review');
    assert.equal(split.moveSpec(moved, '/r/commands/task/review', '/r/commands'), spec);
    assert.equal(path.resolve('/r/commands/task/review', moved), path.resolve('/r/commands', spec));
  }
});

function withTypescriptEnv(fn) {
  const old = process.env.ATRIS_SPLIT_TYPESCRIPT;
  const dir = typescriptDir();
  if (dir) process.env.ATRIS_SPLIT_TYPESCRIPT = dir;
  try { return fn(); } finally { if (old === undefined) delete process.env.ATRIS_SPLIT_TYPESCRIPT; else process.env.ATRIS_SPLIT_TYPESCRIPT = old; }
}

function typescriptDir() {
  for (const candidate of [process.env.ATRIS_SPLIT_TYPESCRIPT, path.join(__dirname, '..', 'node_modules', 'typescript'), path.join(os.homedir(), '.cache', 'atris-split', 'node_modules', 'typescript')]) {
    if (candidate && fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  return null;
}
