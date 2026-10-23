#!/usr/bin/env node
// mutate.js <checkout> <out-dir> [--files a.js,b.js] [--per-file 6]
// Finds blind spots: one small deliberate break at a time in a lib file, run
// the tests that load that file, and keep the break as a job only if every
// test still passes. Restores the file after each try. Zero dependencies.
'use strict';
if (require.main !== module) return;
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const [root, outDir] = process.argv.slice(2);
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const perFile = Number(arg('--per-file', 6));
const only = arg('--files', '') ? arg('--files', '').split(',') : null;

const SWAPS = [
  [' === ', ' !== '], [' !== ', ' === '],
  [' >= ', ' > '], [' <= ', ' < '], [' > ', ' >= '], [' < ', ' <= '],
  [' && ', ' || '], [' || ', ' && '],
  ['return true;', 'return false;'], ['return false;', 'return true;'],
  [' + 1', ' - 1'], [' - 1', ' + 1'],
];

function outsideStrings(line, idx) {
  const before = line.slice(0, idx);
  for (const q of ["'", '"', '`']) if ((before.split(q).length - 1) % 2 === 1) return false;
  return !before.includes('//');
}

function testsLoading(file) {
  const base = path.basename(file, '.js');
  const dir = path.dirname(file);
  const re = new RegExp(`require\\(['"]\\.\\./${dir}/${base.replace(/[-.]/g, '\\$&')}(\\.js)?['"]\\)`);
  return fs.readdirSync(path.join(root, 'test'))
    .filter((t) => t.endsWith('.test.js'))
    .filter((t) => re.test(fs.readFileSync(path.join(root, 'test', t), 'utf8')))
    .map((t) => path.join('test', t));
}

function runTests(tests) {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mut-'));
  const r = spawnSync('node', ['--test', ...tests], {
    cwd: root, timeout: 60000, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: tmp, TMPDIR: require('os').tmpdir(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ATRIS_SKIP_UPDATE_CHECK: '1', TZ: 'UTC' },
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  return r.status === 0;
}

fs.mkdirSync(outDir, { recursive: true });
const libs = only || ['lib', 'commands'].flatMap((d) => fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.js')).map((f) => `${d}/${f}`));
let made = 0;
for (const file of libs) {
  const tests = testsLoading(file);
  if (!tests.length || tests.length > 6) continue;
  const abs = path.join(root, file);
  const original = fs.readFileSync(abs, 'utf8');
  if (!runTests(tests)) continue;
  const lines = original.split('\n');
  const sites = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    for (const [from, to] of SWAPS) {
      const at = line.indexOf(from);
      if (at >= 0 && outsideStrings(line, at)) sites.push({ i, from, to, at });
    }
  });
  // spread the sample across the file
  const step = Math.max(1, Math.floor(sites.length / perFile));
  const pick = sites.filter((_, k) => k % step === 0).slice(0, perFile);
  for (const s of pick) {
    const mutated = lines.slice();
    mutated[s.i] = lines[s.i].slice(0, s.at) + s.to + lines[s.i].slice(s.at + s.from.length);
    fs.writeFileSync(abs, mutated.join('\n'));
    let survived = false;
    try { survived = runTests(tests); } finally { fs.writeFileSync(abs, original); }
    if (!survived) continue;
    const base = path.basename(file, '.js');
    const id = `mut-${path.dirname(file)}-${base}-L${s.i + 1}-${SWAPS.findIndex(([f, t]) => f === s.from && t === s.to)}`;
    const job = {
      id, kind: 'mut', target: file, line: s.i + 1, from: s.from.trim(), to: s.to.trim(),
      before: lines[s.i].trim(), after: mutated[s.i].trim(), tests,
      files: [`test/${base}${path.dirname(file) === 'commands' ? '-cmd' : ''}--mut-L${s.i + 1}-${SWAPS.findIndex(([f, t]) => f === s.from && t === s.to)}.test.js`],
    };
    fs.writeFileSync(path.join(outDir, `${id}.json`), JSON.stringify(job));
    made++;
  }
}
console.log(`blind spots found: ${made}`);
