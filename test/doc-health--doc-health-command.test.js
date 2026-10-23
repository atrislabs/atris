'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-health-command-'));
  const saved = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => key === 'HOME' || key.startsWith('ATRIS_')));
  for (const key of Object.keys(saved)) delete process.env[key];
  process.env.HOME = root;
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (key === 'HOME' || key.startsWith('ATRIS_')) delete process.env[key];
    }
    Object.assign(process.env, saved);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (file, text) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  // Bind resolution to this workspace without needing git or user config.
  write('atris/atris.md', '# temporary workspace\n');
  return { root, write };
}

function invoke(args, root) {
  const { docHealthCommand } = require('../commands/doc-health');
  const lines = [];
  const original = console.log;
  console.log = (...values) => lines.push(values.join(' '));
  try {
    const code = docHealthCommand(args, { cwd: root, now: Date.parse('2024-06-01T12:00:00Z') });
    return { code, output: lines.join('\n') };
  } finally {
    console.log = original;
  }
}

test('JSON report uses the supplied question file and resolves map lookups', t => {
  const { root, write } = fixture(t);
  write('guide.md', '# guide\n');
  write('atris/MAP.md', '| topic | path |\n| --- | --- |\n| guide | `guide.md` |\n');
  write('questions.jsonl', JSON.stringify({ q: 'where is the guide', expect: 'guide.md' }) + '\n');

  const result = invoke(['--json', '--questions', 'questions.jsonl'], root);
  assert.strictEqual(result.code, 0);
  const report = JSON.parse(result.output);
  assert.strictEqual(report.ok, true);
  assert.strictEqual(report.root, fs.realpathSync(root));
  assert.strictEqual(report.action, 'doc-health');
  assert.strictEqual(report.map_coverage.rows, 1);
  assert.deepStrictEqual(report.map_coverage.files, [{ path: 'guide.md', exists: true }]);
  assert.strictEqual(report.lookup_hops.path, 'questions.jsonl');
  assert.strictEqual(report.lookup_hops.one_hop, 1);
  assert.strictEqual(report.lookup_hops.score, 1);
  assert.deepStrictEqual(report.lookup_hops.questions, [
    { q: 'where is the guide', expect: 'guide.md', hops: 1, via: null },
  ]);
  assert.strictEqual(report.overall.total, 100);
});

test('text report skips blank and invalid questions without failing', t => {
  const { root, write } = fixture(t);
  write('atris/MAP.md', '');
  write('invalid.jsonl', '\nnot json\n{"q":"", "expect":"guide.md"}\n');

  const result = invoke(['--questions=invalid.jsonl'], root);
  assert.strictEqual(result.code, 0);
  assert.match(result.output, /^document health: 45\/100\n/);
  assert.match(result.output, /invalid question lines skipped: 2, 3/);
  assert.match(result.output, /skipped: no valid questions\./);
  assert.match(result.output, /lookup score: null; contributes 0 of 30 points\./);
});

test('fixing refs reports a missing map and returns failure', t => {
  const { root } = fixture(t);
  const result = invoke(['--fix-refs'], root);
  assert.deepStrictEqual(result, { code: 1, output: 'no atris/MAP.md in this workspace.' });
  assert.strictEqual(fs.existsSync(path.join(root, 'atris/MAP.md')), false);
});
