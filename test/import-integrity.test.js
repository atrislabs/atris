const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Guards the exact class of bug that shipped a crash once: a destructured import
// of a name the target module no longer exports. `const { foo } = require('./x')`
// silently yields `undefined`, then `foo(...)` throws "foo is not a function" at
// runtime — invisible to module-load and to any test that does not hit that path.
// This walks the local source surface and asserts every destructured local import
// actually resolves to a defined export. Pure introspection: no command is run.

const repoRoot = path.resolve(__dirname, '..');

function listFiles(relDir, ext = '.js') {
  const abs = path.join(repoRoot, relDir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs)
    .filter((f) => f.endsWith(ext))
    .map((f) => path.join(relDir, f));
}

function sourceFiles() {
  return [
    'bin/atris.js',
    'ax',
    ...listFiles('commands'),
    ...listFiles('lib'),
    ...listFiles('utils'),
    ...listFiles('scripts'),
  ].filter((rel) => fs.existsSync(path.join(repoRoot, rel)));
}

// const { a, b: c } = require('./x')  /  require('../x')  — local modules only.
const DESTRUCTURE_REQUIRE = /const\s*\{([^}]+)\}\s*=\s*require\(\s*['"](\.[^'"]+)['"]\s*\)/g;

// Drop block comments and full-line // comments so documentation examples
// (e.g. `const { a } = require('./x')` in a comment) are never scanned as
// real imports. Trailing same-line comments are left alone: stripping them
// safely would need a real parser, and a require() call never follows one.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');
}

function importedNames(group) {
  return group
    .split(',')
    .map((piece) => piece.trim().split(':')[0].trim()) // `a: b` -> exported key `a`
    .filter((name) => name && !name.startsWith('...'));
}

function scanFile(rel) {
  const abs = path.join(repoRoot, rel);
  const src = stripComments(fs.readFileSync(abs, 'utf8'));
  const dir = path.dirname(abs);
  const problems = [];
  let match;
  DESTRUCTURE_REQUIRE.lastIndex = 0;
  while ((match = DESTRUCTURE_REQUIRE.exec(src))) {
    const names = importedNames(match[1]);
    const relRequire = match[2];
    let mod;
    try {
      mod = require(path.resolve(dir, relRequire));
    } catch (error) {
      problems.push(`${rel}: require('${relRequire}') throws on load -> ${error.message}`);
      continue;
    }
    for (const name of names) {
      if (mod[name] === undefined) {
        problems.push(`${rel}: imports { ${name} } from '${relRequire}', but that module does not export it`);
      }
    }
  }
  return problems;
}

test('every destructured local import resolves to a real export', () => {
  const files = sourceFiles();
  assert.ok(files.length > 50, `expected to scan the source surface, only found ${files.length} files`);
  const problems = files.flatMap(scanFile);
  assert.deepEqual(
    problems,
    [],
    `Found ${problems.length} broken local import(s) (imported name not exported -> latent runtime crash):\n  ${problems.join('\n  ')}`
  );
});
