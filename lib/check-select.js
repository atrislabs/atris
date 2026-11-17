'use strict';

// atris check: pick the few tests that cover a change, inside one check.
//
// A check in the map may be a selector instead of one fixed command:
//   {"select": "pytest", "roots": ["backend/tests"], "run": "python -m pytest -q {files}",
//    "max": 40, "fallback": "fast-gate"}
//   {"select": "node-test", "roots": ["scripts"], "run": "node {file}"}
//
// A test is picked, with its reason, when it
//   changed           is itself part of the change;
//   imports: x        imports the changed file x directly, or one hop away
//                     (it imports a file that imports x), unless that file is
//                     a hub more than 8 tests import ("hub_tests" in the check);
//   named-for: x      is named for x (test_x.py, x_test.py, x.test.ts,
//                     test-x.mjs, kebab-case too), or its text mentions x by
//                     path, by Python module path, or (JS) by a name x exports;
//   owner: <glob>     is listed for x's path in the map's "owners" table.
// A "broad" file (the map lists files like main.js that hundreds of tests
// name) is matched by the names the change touches instead: the functions
// its diff edits, "named-for: main.js (changes normalizeClaudeEvent)".
// No model, no learning: the same change always picks the same tests.
//
// Widening, never narrowing: a changed source file that no test covers is a
// finding ("no test covers x"), and the selector runs its fallback (the full
// gate) instead. More than "max" picked tests means a big blast radius, so the
// fallback runs too.

const path = require('path');
const { globToRegExp } = require('./check-glob');

const KINDS = ['pytest', 'node-test'];
const PY_TEST = /^(?:test_.*|.*_test)\.py$/;
const NODE_TEST = /^(?:test-.*\.(?:c?js|mjs)|.*\.(?:test|spec)\.[cm]?[jt]sx?)$/;
// Names too common to say which test reads them.
const GENERIC = new Set([
  '__init__', 'main', 'config', 'utils', 'util', 'models', 'model', 'router', 'helpers', 'helper',
  'base', 'types', 'schemas', 'constants', 'common', 'readme', 'map', 'index', 'todo', 'changelog',
  'agents', 'claude', 'package', 'package-lock', 'requirements', 'settings', 'app', 'test', 'tests',
  'data', 'lib', 'src', 'core', 'api', 'server', 'client', 'style', 'styles', 'globals', 'shared',
  'default', 'options', 'state', 'store', 'events', 'event', 'errors', 'error', 'logger', 'log',
]);
// A short plain name or an exported name that more than this many candidate
// tests mention says nothing about which test covers the file, so it is not
// used (the path still is). Long compound names are always used.
const BROAD_NAME_HITS = 12;
// A file between a changed file and the tests that import it, imported by
// more than this many tests, is a hub: the one-hop rule does not go through it.
const HUB_TESTS = 8;

function isKind(kind) {
  return KINDS.includes(kind);
}

function baseName(file) {
  return path.posix.basename(file);
}

function stemOf(file) {
  return baseName(file).replace(/\.(?:test|spec)(?=\.[^.]+$)/, '').replace(/\.[^.]+$/, '');
}

function kebab(stem) {
  return stem.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase();
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wordRegExp(word) {
  return new RegExp(`(?:^|[^A-Za-z0-9_$])${escapeRegExp(word)}(?![A-Za-z0-9_$])`);
}

function rootMatcher(roots) {
  const tests = roots.map((root) => {
    const text = String(root).replace(/^\.\//, '').replace(/\/+$/, '');
    if (/[*?{]/.test(text)) { const re = globToRegExp(text); return (file) => re.test(file); }
    if (!text || text === '.') return () => true;
    return (file) => file === text || file.startsWith(`${text}/`);
  });
  return (file) => tests.some((test) => test(file));
}

function isCandidate(check, file) {
  const base = baseName(file);
  if (check.select === 'pytest' ? !PY_TEST.test(base) : !NODE_TEST.test(base)) return false;
  return rootMatcher(check.roots)(file);
}

// Python module paths a file can be imported as: backend/services/x.py is
// services.x and backend.services.x.
function modulePaths(file) {
  if (!file.endsWith('.py')) return [];
  const parts = file.slice(0, -3).split('/');
  if (parts[parts.length - 1] === '__init__') parts.pop();
  if (!parts.length || !parts.every((part) => /^[A-Za-z_]\w*$/.test(part))) return [];
  const out = [];
  for (let i = 0; i < parts.length; i += 1) {
    const dotted = parts.slice(i).join('.');
    // A single bare word is too common to read as a module mention.
    if (dotted.includes('.')) out.push(dotted);
  }
  return out;
}

// Names a JS or TS file exports, long and specific enough to look for.
function exportedNames(file, text) {
  if (!/\.[cm]?[jt]sx?$/.test(file) || !text) return [];
  const names = new Set();
  for (const m of text.matchAll(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of text.matchAll(/\bexports\.([A-Za-z_$][\w$]*)\s*=/g)) names.add(m[1]);
  for (const m of text.matchAll(/\bexport\s*\{([^}]*)\}/g)) for (const part of m[1].split(',')) { const name = part.trim().split(/\s+as\s+/).pop(); if (name) names.add(name); }
  const block = text.match(/\bmodule\.exports\s*=\s*\{([\s\S]*?)\}/);
  if (block) for (const part of block[1].split(',')) { const name = part.trim().split(/[\s:]/)[0]; if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name); }
  return [...names].filter((name) => name.length >= 6 && !GENERIC.has(name.toLowerCase())).slice(0, 40);
}

function namedFor(check, test, file) {
  const stem = stemOf(file);
  if (!stem || GENERIC.has(stem.toLowerCase())) return false;
  const base = baseName(test);
  if (check.select === 'pytest') return base === `test_${stem}.py` || base === `${stem}_test.py`;
  const testStem = stemOf(test);
  const forms = new Set([stem, kebab(stem)]);
  if (/^test-/.test(base)) return forms.has(testStem.replace(/^test-/, ''));
  return forms.has(testStem) && /\.(?:test|spec)\./.test(base);
}

// The selection for one selector check.
//   ctx.changed      changed files (repo paths)
//   ctx.files        every file in the repo (tracked plus changed that exist)
//   ctx.inScope(f)   the selector covers this changed file
//   ctx.isLow(f)     a low risk file (docs, styles, comments only, tests)
//   ctx.isTest(f)    a test or test support file
//   ctx.readFile(f)  its text
//   ctx.importersOf(f)  files importing f directly
//   ctx.importersExcept(f)  an entry file that imports everything (not a hop)
//   ctx.owners       [{glob, tests}] from the map
//   ctx.grep(needles, roots)  optional fast search: the set of files whose
//                    text holds any needle (null when it could not search)
//   ctx.lowOnly      a low risk change: changed tests and tests of changed
//                    test support files only, never the fallback
function selectTests(check, ctx) {
  const files = ctx.files || [];
  const changed = ctx.changed.filter((file) => ctx.inScope(file));
  const candidates = [...new Set([...files, ...changed])].filter((file) => isCandidate(check, file)).sort();
  const candidateSet = new Set(candidates);
  const picks = new Map();
  const coveredBy = new Map();
  const broadNames = [];
  const add = (test, reason, file) => {
    if (!picks.has(test)) picks.set(test, []);
    const reasons = picks.get(test);
    if (!reasons.includes(reason)) reasons.push(reason);
    if (file) coveredBy.set(file, (coveredBy.get(file) || 0) + 1);
  };
  const texts = new Map();
  const textOf = (file) => {
    if (!texts.has(file)) texts.set(file, ctx.readFile(file) || '');
    return texts.get(file);
  };
  const importersOf = ctx.importersOf || (() => []);
  const hubMax = Number.isInteger(check.hubTests) && check.hubTests > 0 ? check.hubTests : HUB_TESTS;
  const hubs = [];
  const except = ctx.importersExcept || (() => false);

  // Text mentions: every needle of every changed file goes to one search
  // (git grep when the caller has it), then only the files it found are read.
  const needlesOf = new Map();
  for (const file of changed) {
    if (candidateSet.has(file) || (ctx.lowOnly && !ctx.isTest(file))) continue;
    const needles = [];
    if (ctx.isBroad && ctx.isBroad(file)) {
      // A broad file: look for the names this change touches, not the file.
      for (const name of (ctx.changedNames ? ctx.changedNames(file) : [])) needles.push({ text: name, broad: true, word: true, changes: true });
      needlesOf.set(file, needles);
      continue;
    }
    const stem = stemOf(file);
    const pathNeedle = file.replace(/\.[A-Za-z0-9]+$/, '');
    if (pathNeedle.includes('/')) needles.push({ text: pathNeedle, broad: false });
    // A long or compound name (stripe_service, modelCatalog) is specific:
    // every test that mentions it counts. A short plain one may be too common.
    const specific = stem.length >= 8 && /[_-]|[a-z][A-Z]/.test(stem);
    if (stem && stem.length >= 4 && !GENERIC.has(stem.toLowerCase())) needles.push({ text: `${stem}.`, broad: !specific, word: true });
    for (const dotted of modulePaths(file)) needles.push({ text: dotted, broad: false, word: true });
    if (check.select === 'node-test') for (const name of exportedNames(file, ctx.readFile(file) || '')) needles.push({ text: name, broad: true, word: true });
    needlesOf.set(file, needles);
  }
  const allNeedles = [...new Set([...needlesOf.values()].flat().map((needle) => needle.text))];
  let mentioning = candidates;
  if (allNeedles.length && ctx.grep) {
    const found = ctx.grep(allNeedles, check.roots);
    if (found) mentioning = candidates.filter((file) => found.has(file) || changed.includes(file));
  }
  if (!allNeedles.length) mentioning = [];

  for (const file of changed) {
    if (candidateSet.has(file)) { add(file, 'changed', file); continue; }
    if (ctx.lowOnly && !ctx.isTest(file)) continue;
    // imports, direct and one hop away
    for (const importer of importersOf(file)) {
      if (candidateSet.has(importer)) add(importer, `imports: ${file}`, file);
      else if (except(importer)) continue;
      const second = importersOf(importer).filter((test) => candidateSet.has(test));
      // A hub (a router many tests mount) would pull in all of its tests for
      // any file it imports. Its own tests run when the hub itself changes.
      // A test or test helper many tests import is their shared fixture, not
      // a hub: its importers really do run the changed code, so they count.
      // A split module that loads the changed file as its own feature part is
      // that file, not a hub in front of it: its tests run the part.
      const loadsIt = ctx.loadsPart && ctx.loadsPart(importer, file);
      if (second.length > hubMax && !ctx.isTest(importer) && !loadsIt) { hubs.push({ file: importer, tests: second.length, for: file }); continue; }
      for (const test of second) add(test, `imports: ${file} (via ${importer})`, file);
    }
    // named for it
    if (!(ctx.isBroad && ctx.isBroad(file))) for (const test of candidates) if (namedFor(check, test, file)) add(test, `named-for: ${file}`, file);
    // its text mentions it
    for (const needle of needlesOf.get(file) || []) {
      const bare = needle.text.replace(/\.$/, '');
      const re = needle.word ? (needle.text.endsWith('.') ? new RegExp(`${wordRegExp(bare).source}\\.`) : wordRegExp(bare)) : null;
      const hits = mentioning.filter((test) => {
        if (test === file) return false;
        const text = textOf(test);
        if (!text.includes(needle.text)) return false;
        return re ? re.test(text) : true;
      });
      if (needle.broad && hits.length > BROAD_NAME_HITS) { broadNames.push(`${bare} (${hits.length} tests)`); continue; }
      for (const test of hits) add(test, needle.changes ? `named-for: ${file} (changes ${bare})` : `named-for: ${file} (mentions ${bare})`, file);
    }
  }
  // owners
  for (const { glob, tests } of ctx.owners || []) {
    const re = globToRegExp(glob);
    const owned = changed.filter((file) => re.test(file));
    if (!owned.length) continue;
    for (const entry of tests) {
      const testRe = /[*?{]/.test(entry) ? globToRegExp(entry) : null;
      const matches = testRe ? files.filter((file) => testRe.test(file)) : (files.includes(entry) ? [entry] : []);
      for (const test of matches) for (const file of owned) add(test, `owner: ${glob}`, file);
    }
  }
  const tests = [...picks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([file, reasons]) => ({ file, reasons }));
  // A changed source file no test covers is a gap worth seeing.
  const uncovered = ctx.lowOnly ? [] : changed.filter((file) => !ctx.isLow(file) && !ctx.isTest(file) && !coveredBy.get(file));
  const max = Number.isInteger(check.max) && check.max > 0 ? check.max : 40;
  let fallback = null;
  if (!ctx.lowOnly && uncovered.length) fallback = `no test covers ${uncovered[0]}${uncovered.length > 1 ? ` (+${uncovered.length - 1} more)` : ''}`;
  else if (!ctx.lowOnly && tests.length > max) fallback = `${tests.length} tests selected, more than the max of ${max}: a big blast radius runs it all`;
  return { tests, uncovered, fallback, candidates: candidates.length, broadNames, max, hubs };
}

module.exports = { GENERIC, selectTests, isCandidate, isKind, KINDS, exportedNames, modulePaths, stemOf, kebab };
