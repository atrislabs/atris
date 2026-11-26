const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const site = require('../commands/site');
const publish = require('../lib/site-publish');
const { compilePage, recordPick } = require('../lib/page-lang');
const { PAGE_RULES } = require('../lib/page-rules');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-site-check-'));
const home = process.cwd();
process.chdir(root);
test.after(() => { process.chdir(home); fs.rmSync(root, { recursive: true, force: true }); });

const PROSE = '<p>Each student wrote a draft every week, and the teacher read every one of them.</p>\n<p>The drafts got shorter and clearer as the term went on, and nobody wrote for them.</p>';
const GOOD = `<main>\n<header><h1>Writing coach</h1></header>\n<section>\n<h2>Notes</h2>\n${PROSE}\n</section>\n</main>\n`;
const BAD = '<main>\n<header>\n<h1>Writing coach</h1>\n<p>Better essays every week.</p>\n</header>\n<div>Hi</div>\n</main>\n';

async function cli(argv) {
  const out = [], err = [];
  const saved = [console.log, console.error];
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  try { return { code: await site.run(argv), out: out.join('\n'), err: err.join('\n') }; } finally { [console.log, console.error] = saved; }
}
function folder(name, files) {
  const dir = path.join(root, name);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  return name;
}
let uploads = 0;
publish.run = async () => { uploads++; return 0; };

test('check refuses a bad page line by line on stderr and passes a good one', async () => {
  folder('pages', { 'bad.html': BAD, 'good.html': GOOD });
  const bad = await cli(['check', 'pages/bad.html']);
  assert.strictEqual(bad.code, 1);
  assert.match(bad.err, /^refused pages\/bad\.html \(2 lines to fix\)\nline 4: /);
  assert.match(bad.err, /line 6: a tag a content page does not use: "<div>"/);
  const good = await cli(['check', 'pages/good.html']);
  assert.deepStrictEqual([good.code, good.out], [0, 'ok pages/good.html: every rule passes']);
  const json = JSON.parse((await cli(['check', 'pages', '--json'])).out);
  assert.deepStrictEqual(json.files.map((f) => [f.file, f.kind, f.ok]), [['pages/bad.html', 'content', false], ['pages/good.html', 'content', true]]);
});

test('check always says which rules the project switched off', async () => {
  fs.mkdirSync(path.join(root, '.atris'), { recursive: true });
  fs.writeFileSync(path.join(root, '.atris', 'slop.rules.json'), JSON.stringify({ off: ['page-glow'] }));
  const res = await cli(['check', 'pages/good.html']);
  fs.rmSync(path.join(root, '.atris'), { recursive: true });
  assert.match(res.out, /switched off in \.atris\/slop\.rules\.json: page-glow/);
});

test('rules prints every rule the check enforces', async () => {
  const res = await cli(['rules']);
  for (const id of [...PAGE_RULES.map((r) => r.id), 'lang-root', 'lang-form']) assert.ok(res.out.includes(`  ${id}: `), id);
});

test('only a person at a terminal can pick a look', async () => {
  folder('atris/looks', { 'paper.css': 'body{font-family:Georgia,serif}' });
  const res = await cli(['look', 'pick', 'paper']);
  assert.strictEqual(res.code, 1);
  assert.ok(!fs.existsSync(path.join(root, 'atris', 'looks', 'picked.json')));
  assert.match((await cli(['looks'])).out, /paper: not picked/);
});

test('a content page builds to index.html in a look', async () => {
  const res = await cli(['pages/good.html', '--look', 'paper', '--out', 'built']);
  assert.strictEqual(res.code, 0);
  assert.match(fs.readFileSync(path.join(root, 'built', 'index.html'), 'utf8'), /<meta name="atris-page" content="paper sha256:/);
  assert.strictEqual((await cli(['pages/bad.html', '--out', 'built2'])).code, 1);
  assert.ok(!fs.existsSync(path.join(root, 'built2')));
});

test('publish and deploy upload nothing unless every page passes', async () => {
  const before = uploads;
  const plain = compilePage(GOOD);
  const refusals = [
    [folder('site-bad', { 'index.html': BAD }), /refused site-bad\/index\.html/],
    [folder('site-edited', { 'index.html': plain.replace('every week', 'each week') }), /edited after it was built\. rebuild it from the content page\./],
    [folder('site-look', { 'index.html': compilePage(GOOD, { look: 'paper', lookCss: 'body{font-family:Georgia,serif}' }) }), /look paper has no pick on record\. only the owner picks a look\./],
  ];
  for (const [dir, said] of refusals) {
    const res = await cli(['publish', dir, '--slug', 'demo']);
    assert.strictEqual(res.code, 1, dir);
    assert.match(res.err, said);
    const dry = await cli(['deploy', dir, '--name', 'demo', '--dry-run']);
    assert.strictEqual(dry.code, 1, dir);
  }
  assert.strictEqual(uploads, before);
  folder('site-clean', { 'index.html': plain, 'node_modules/x.html': BAD });
  assert.strictEqual((await cli(['publish', 'site-clean', '--slug', 'demo'])).code, 0);
  assert.strictEqual(uploads, before + 1);
  recordPick(root, 'paper');
  assert.strictEqual((await cli(['publish', 'site-look', '--slug', 'demo'])).code, 0);
  assert.strictEqual(uploads, before + 2);
});
