'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { guideCommand } = require('../commands/guide');
const { INTENTS } = require('../lib/intents');

// guideCommand only prints and returns an exit code, so run it in-process
// with console.log captured. It reads no files and no environment.
function runGuide(t, args) {
  const lines = [];
  t.mock.method(console, 'log', (...parts) => lines.push(parts.join(' ')));
  const code = guideCommand(args);
  return { code, lines, text: lines.join('\n') };
}

function intentById(id) {
  return INTENTS.find((intent) => intent.id === id);
}

test('no arguments lists every intent with its first phrase and plain meaning', (t) => {
  const { code, lines } = runGuide(t, []);
  assert.strictEqual(code, 0);
  assert.strictEqual(lines.length, INTENTS.length);
  INTENTS.forEach((intent, index) => {
    const suffix = intent.confirm ? ' (asks you first)' : '';
    assert.strictEqual(lines[index], `"${intent.say[0]}"  ->  ${intent.plain}${suffix}`);
  });
});

test('no arguments marks only the confirm intents as asking first', (t) => {
  const { lines } = runGuide(t, []);
  const asking = lines.filter((line) => line.endsWith('(asks you first)'));
  assert.strictEqual(asking.length, INTENTS.filter((intent) => intent.confirm).length);
  assert.ok(asking.length > 0);
  assert.ok(lines.some((line) => !line.endsWith('(asks you first)')));
});

test('--json with no words prints the full intent map and exits 0', (t) => {
  const { code, lines } = runGuide(t, ['--json']);
  assert.strictEqual(code, 0);
  assert.strictEqual(lines.length, 1);
  assert.deepStrictEqual(JSON.parse(lines[0]), { intents: INTENTS });
});

test('a matching phrase prints the plain meaning, the command, and at most two alternatives', (t) => {
  const { code, lines } = runGuide(t, ['please', 'make', 'this', 'faster']);
  const expected = intentById('improve_one_thing');
  assert.strictEqual(code, 0);
  assert.strictEqual(lines[0], expected.plain);
  assert.strictEqual(lines[1], expected.do);
  assert.strictEqual(lines[2], 'you might also mean:');
  const alternatives = lines.slice(3);
  assert.strictEqual(alternatives.length, 2);
  alternatives.forEach((line) => assert.match(line, /^".+"$/));
});

test('a matching phrase for a confirm intent says it asks first', (t) => {
  const { code, lines } = runGuide(t, ['run overnight']);
  assert.strictEqual(code, 0);
  assert.strictEqual(lines[0], `${intentById('keep_going').plain} (asks you first)`);
  assert.strictEqual(lines[1], 'atris spaceship');
});

test('an unmatched phrase exits 1, says so, and offers three nearest phrases', (t) => {
  const { code, lines } = runGuide(t, ['purple elephant']);
  assert.strictEqual(code, 1);
  assert.strictEqual(lines[0], 'not sure yet. ask one question, then try again');
  assert.strictEqual(lines[1], 'you might also mean:');
  assert.strictEqual(lines.length, 5);
  lines.slice(2).forEach((line) => {
    assert.ok(INTENTS.some((intent) => line === `"${intent.say[0]}"`), line);
  });
});

test('--json with a match prints the matched intent and exits 0', (t) => {
  const { code, lines } = runGuide(t, ['catch me up', '--json']);
  assert.strictEqual(code, 0);
  const payload = JSON.parse(lines.join('\n'));
  assert.strictEqual(payload.intent.id, 'catch_up');
  assert.strictEqual(payload.intent.do, 'atris recap');
  assert.strictEqual(typeof payload.score, 'number');
  assert.strictEqual(payload.alternatives.length, 2);
});

test('--json with no match prints a null intent and exits 1', (t) => {
  const { code, lines } = runGuide(t, ['--json', 'purple elephant']);
  assert.strictEqual(code, 1);
  const payload = JSON.parse(lines.join('\n'));
  assert.strictEqual(payload.intent, null);
  assert.strictEqual(payload.alternatives.length, 3);
});

test('the --json flag is stripped from the words before matching', (t) => {
  const withFlag = runGuide(t, ['--json', 'run', 'overnight']);
  assert.strictEqual(JSON.parse(withFlag.text).intent.id, 'keep_going');
});

test('blank words behave like no arguments', (t) => {
  const { code, lines } = runGuide(t, ['   ']);
  assert.strictEqual(code, 0);
  assert.strictEqual(lines.length, INTENTS.length);
});

test('called with no argument at all it still lists the intents', (t) => {
  const lines = [];
  t.mock.method(console, 'log', (...parts) => lines.push(parts.join(' ')));
  assert.strictEqual(guideCommand(), 0);
  assert.strictEqual(lines.length, INTENTS.length);
});
