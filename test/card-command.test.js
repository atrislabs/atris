const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-card-command-'));
const originalHome = process.env.HOME;
const originalCwd = process.cwd();

// set before the module loads so nothing in it can reach the real home or repo
process.env.HOME = tmp;
process.chdir(tmp);

const { run } = require('../commands/card');

after(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

// run the command with console captured; returns { code, out, err }
function runCard(argv) {
  const logs = []; const errs = [];
  const realLog = console.log; const realErr = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => errs.push(a.join(' '));
  let code;
  try { code = run(argv); }
  finally { console.log = realLog; console.error = realErr; }
  return { code, out: logs.join('\n'), err: errs.join('\n') };
}

const outBase = (name) => path.join(tmp, name);
const readHtml = (name) => fs.readFileSync(`${outBase(name)}.html`, 'utf8');

test('help prints usage for the help word and the --help flag', () => {
  for (const argv of [['help'], ['--help']]) {
    const r = runCard(argv);
    assert.strictEqual(r.code, 0);
    assert.match(r.out, /atris card, one line of text into an on-brand image/);
    assert.match(r.out, /--kind statement\|quote\|stat/);
    assert.match(r.out, /--size og\|wide\|square\|story/);
    assert.match(r.out, /--html-only/);
    assert.strictEqual(r.err, '');
  }
  assert.deepStrictEqual(fs.readdirSync(tmp), [], 'help must not write any files');
});

test('rejects an unknown kind with exit 2 and lists the real kinds', () => {
  const r = runCard(['hello', '--kind', 'poster']);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /unknown kind "poster"/);
  assert.match(r.err, /statement, quote, stat/);
});

test('rejects an unknown size with exit 2 and lists the real sizes', () => {
  const r = runCard(['hello', '--size', 'huge']);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /unknown size "huge"/);
  assert.match(r.err, /og, wide, square, story/);
});

test('asks for text on statement and quote cards, and for a number on stat cards', () => {
  const noText = runCard([]);
  assert.strictEqual(noText.code, 2);
  assert.match(noText.err, /give the card some text/);

  const noQuote = runCard(['--kind', 'quote', '--by', 'someone']);
  assert.strictEqual(noQuote.code, 2);
  assert.match(noQuote.err, /give the card some text/);

  const noNumber = runCard(['--kind', 'stat', '--label', 'faster']);
  assert.strictEqual(noNumber.code, 2);
  assert.match(noNumber.err, /stat cards need --number/);

  assert.deepStrictEqual(fs.readdirSync(tmp), [], 'rejected runs must not write any files');
});

test('--html-only writes a statement card with the headline, kicker, and default og size', () => {
  const r = runCard(['Ship', 'faster', '--kicker', 'Atris launch', '--sub', 'Less waiting', '--html-only', '--out', outBase('statement')]);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /statement card \(1200x630, theme atris\)/);
  assert.ok(r.out.includes(`${outBase('statement')}.html`));

  const html = readHtml('statement');
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<h1 class="headline">Ship faster<\/h1>/);
  assert.match(html, /<div class="kicker">Atris launch<\/div>/);
  assert.match(html, /<p class="sub">Less waiting<\/p>/);
  assert.match(html, /html,body\{width:1200px;height:630px/);
  assert.ok(!fs.existsSync(`${outBase('statement')}.png`), 'html-only must not render a png');
});

test('--size changes the card dimensions in both the message and the html', () => {
  const expected = { og: [1200, 630], wide: [1920, 1080], square: [1080, 1080], story: [1080, 1920] };
  for (const [size, [w, h]] of Object.entries(expected)) {
    const name = `size-${size}`;
    const r = runCard(['Sized', '--size', size, '--html-only', '--out', outBase(name)]);
    assert.strictEqual(r.code, 0);
    assert.match(r.out, new RegExp(`\\(${w}x${h}, theme atris\\)`));
    assert.ok(readHtml(name).includes(`width:${w}px;height:${h}px`), `${size} html should be ${w}x${h}`);
  }
});

test('quote cards show the quote and who said it', () => {
  const r = runCard(['It just works.', '--kind', 'quote', '--by', 'a founder', '--html-only', '--out', outBase('quote')]);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /quote card/);
  const html = readHtml('quote');
  assert.match(html, /<blockquote class="qtext">It just works\.<\/blockquote>/);
  assert.match(html, /<div class="by">a founder<\/div>/);
});

test('stat cards take the number and label from flags with no positional text', () => {
  const r = runCard(['--kind', 'stat', '--number', '10x', '--label', 'faster reviews', '--html-only', '--out', outBase('stat')]);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /stat card/);
  const html = readHtml('stat');
  assert.match(html, /<div class="big">10x<\/div>/);
  assert.match(html, /<div class="statlabel">faster reviews<\/div>/);
});

test('--out drops a .png suffix and writes the html beside it; brand and version reach the footer', () => {
  const r = runCard(['Branded', '--brand', 'Acme & Co', '--version', 'v9.9.9', '--html-only', '--out', `${outBase('named')}.png`]);
  assert.strictEqual(r.code, 0);
  assert.ok(fs.existsSync(`${outBase('named')}.html`));
  const html = readHtml('named');
  assert.match(html, /<span class="mark">Acme &amp; Co<\/span>/);
  assert.match(html, /<span class="ver">v9\.9\.9<\/span>/);
});

test('an unknown theme falls back to the default theme instead of crashing', () => {
  const r = runCard(['Fallback', '--theme', 'no-such-theme', '--html-only', '--out', outBase('fallback')]);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /theme atris/);
  assert.match(readHtml('fallback'), /<h1 class="headline">Fallback<\/h1>/);
});
