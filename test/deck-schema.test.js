const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  validateSpec,
  hasErrors,
  sortFindings,
  checkSpec,
  SLIDE_SCHEMA,
  ARCHE_TYPES,
} = require('../lib/deck-schema');
const { lintSpec } = require('../lib/deck-review');
const { SAMPLE } = require('../commands/deck');

test('the SAMPLE spec validates with no errors', () => {
  assert.equal(hasErrors(validateSpec(SAMPLE)), false);
});

test('schema registry and ARCHE render registry never drift', () => {
  const schemaTypes = Object.keys(SLIDE_SCHEMA).sort();
  const archeTypes = [...ARCHE_TYPES].sort();
  assert.deepEqual(schemaTypes, archeTypes, 'every render archetype needs a schema entry and vice versa');
});

test('unknown slide type is an error with the known list', () => {
  const findings = validateSpec({ theme: 'paper', slides: [{ type: 'wat', text: 'hi' }] });
  const f = findings.find((x) => x.rule === 'unknown-slide-type');
  assert.ok(f && f.severity === 'error');
  assert.equal(f.slide, 1);
});

test('missing required field is an error pointing at the slide', () => {
  const findings = validateSpec({ theme: 'ink', slides: [
    { type: 'title', headline: 'ok' },
    { type: 'quote', author: 'me' }, // no text
  ] });
  const f = findings.find((x) => x.rule === 'missing-field');
  assert.ok(f, 'expected a missing-field error');
  assert.equal(f.slide, 2);
});

test('unknown theme is a spec-level error', () => {
  const findings = validateSpec({ theme: 'rainbow', slides: [{ type: 'statement', text: 'x' }] });
  assert.ok(findings.some((x) => x.rule === 'unknown-theme' && x.slide === 0));
});

test('empty or missing slides array is an error', () => {
  assert.ok(validateSpec({ theme: 'paper', slides: [] }).some((f) => f.rule === 'no-slides'));
  assert.ok(validateSpec({ theme: 'paper' }).some((f) => f.rule === 'no-slides'));
});

test('non-array where an array is required is an error', () => {
  const findings = validateSpec({ theme: 'paper', slides: [{ type: 'columns', columns: 'nope' }] });
  assert.ok(findings.some((f) => f.rule === 'bad-array'));
});

test('alternative field names both satisfy a requirement', () => {
  // hero accepts headline OR text; bignumber accepts number OR value
  assert.equal(hasErrors(validateSpec({ slides: [{ type: 'hero', text: 'done' }] })), false);
  assert.equal(hasErrors(validateSpec({ slides: [{ type: 'bignumber', value: '99%' }] })), false);
});

test('checkSpec merges schema errors and taste lint, ordered', () => {
  const merged = checkSpec({
    theme: 'paper',
    slides: [
      { type: 'quote', text: 'It is not taste. It is proof.' }, // taste: not-x-contrast-copy
      { type: 'wat' }, // schema: unknown-slide-type
    ],
  }, lintSpec);
  assert.ok(merged.some((f) => f.rule === 'not-x-contrast-copy'));
  assert.ok(merged.some((f) => f.rule === 'unknown-slide-type'));
  // ordered by slide ascending
  const slideNos = merged.map((f) => f.slide);
  assert.deepEqual(slideNos, [...slideNos].sort((a, b) => a - b));
});

test('every shipped deck spec passes schema validation', () => {
  const dir = path.join(__dirname, '..', 'decks');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const spec = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const errs = validateSpec(spec).filter((f) => f.severity === 'error');
    assert.equal(errs.length, 0, `${file} has schema errors: ${JSON.stringify(errs)}`);
  }
});
