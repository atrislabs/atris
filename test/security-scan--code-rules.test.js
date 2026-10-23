'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { CODE_RULES, RULES, scanLine, scanText } = require('../lib/security-scan');

const byId = Object.fromEntries(CODE_RULES.map((r) => [r.id, r]));

test('CODE_RULES lists the four code-execution rules, all medium and category code', () => {
  assert.deepStrictEqual(CODE_RULES.map((r) => r.id), [
    'eval-call',
    'new-function',
    'shell-exec-interpolation',
    'child-process-shell-true',
  ]);
  for (const r of CODE_RULES) {
    assert.strictEqual(r.cat, 'code');
    assert.strictEqual(r.sev, 'medium');
    assert.ok(r.re instanceof RegExp, `${r.id} has a regex`);
    assert.ok(r.why.length > 0, `${r.id} has a reason`);
    assert.ok(RULES.includes(r), `${r.id} is part of RULES`);
  }
});

test('eval-call flags a real eval call and skips method calls, longer names, and empty calls', () => {
  const re = byId['eval-call'].re;
  assert.strictEqual(re.test('const out = eval(code);'), true);
  assert.strictEqual(re.test('eval("1 + 1")'), true);
  assert.strictEqual(re.test('vm.eval(code)'), false);
  assert.strictEqual(re.test('retrieval(code)'), false);
  assert.strictEqual(re.test('eval()'), false);
});

test('new-function flags new Function() and ignores calls without new', () => {
  const re = byId['new-function'].re;
  assert.strictEqual(re.test('const f = new Function("a", "return a");'), true);
  assert.strictEqual(re.test('Function("a", "return a")'), false);
  assert.strictEqual(re.test('new Functional()'), false);
});

test('shell-exec-interpolation flags exec with interpolated input and ignores fixed commands', () => {
  const re = byId['shell-exec-interpolation'].re;
  assert.strictEqual(re.test('execSync(`git log ${branch}`)'), true);
  assert.strictEqual(re.test("exec('rm -rf ' + dir)"), true);
  assert.strictEqual(re.test("execFile('git', ['log', branch])"), false);
  assert.strictEqual(re.test("exec('git status')"), false);
  assert.strictEqual(re.test('execSync(`git status`)'), false);
});

test('child-process-shell-true flags shell: true only', () => {
  const re = byId['child-process-shell-true'].re;
  assert.strictEqual(re.test("spawn('npm', ['test'], { shell: true })"), true);
  assert.strictEqual(re.test('{shell:true}'), true);
  assert.strictEqual(re.test('{ shell: false }'), false);
  assert.strictEqual(re.test('{ shell: trueish }'), false);
});

test('scanLine reports each matching code rule on one line, in rule order', () => {
  const findings = scanLine('eval(new Function(body)())', CODE_RULES);
  assert.deepStrictEqual(findings.map((f) => f.rule), ['eval-call', 'new-function']);
  assert.deepStrictEqual(findings[0], {
    rule: 'eval-call',
    sev: 'medium',
    cat: 'code',
    why: byId['eval-call'].why,
    snippet: 'eval(',
  });
});

test('scanText reports 1-based line numbers and skips clean lines', () => {
  const text = ['const a = 1;', 'eval(a);', '', 'spawn("ls", { shell: true });'].join('\n');
  const findings = scanText(text, CODE_RULES);
  assert.deepStrictEqual(findings.map((f) => [f.rule, f.line]), [
    ['eval-call', 2],
    ['child-process-shell-true', 4],
  ]);
});

test('empty and clean input produce no code findings', () => {
  assert.deepStrictEqual(scanText('', CODE_RULES), []);
  assert.deepStrictEqual(scanText(undefined, CODE_RULES), []);
  assert.deepStrictEqual(scanLine('const total = a + b;', CODE_RULES), []);
});

test('the atris-allow-secret marker suppresses code findings on that line', () => {
  assert.deepStrictEqual(scanLine('eval(trusted); // atris-allow-secret', CODE_RULES), []);
});
