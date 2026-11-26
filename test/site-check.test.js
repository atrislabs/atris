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
const deploy = require('../commands/site-deploy');
const quiet = { log() {}, error() {} };
const fetch = async () => { uploads++; return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ verified: true }) }; };
const upload = (argv, deps = {}) => publish.run(argv, { ...quiet, fetch, apiBase: 'http://127.0.0.1:9', loadCredentials: () => ({ token: 't' }), ...deps });
const rulesFile = path.join(root, '.atris', 'slop.rules.json');
const blocking = async (fn) => { fs.mkdirSync(path.dirname(rulesFile), { recursive: true }); fs.writeFileSync(rulesFile, '{ "pages": "block" }\n'); try { return await fn(); } finally { fs.rmSync(rulesFile); } };

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
  // one call gives the data and the words a plain run prints
  assert.deepStrictEqual(json.files.map((f) => f.text), [bad.err, good.out]);
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
  assert.match(res.out, /this project is in watch mode[\s\S]*put "pages": "block" in \.atris\/slop\.rules\.json/);
  assert.deepStrictEqual([(await cli(['check', '--mode'])).out, (await blocking(() => cli(['check', '--mode']))).out], ['watch', 'block']);
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

test('in watch mode publish says what would fail and uploads as before', async () => {
  const before = uploads;
  const dir = folder('site-watch', { 'index.html': BAD });
  const out = [], err = [];
  assert.strictEqual(await upload([dir, '--slug', 'demo', '--json'], { log: (s) => out.push(s), error: (s) => err.push(s) }), 0);
  assert.strictEqual(uploads, before + 1);
  assert.match(err.join('\n'), /^page check in watch mode: the upload goes ahead\. in block mode these lines would stop it\.\nwould refuse site-watch\/index\.html \(2 lines to fix\)\nline 4: /);
  const json = JSON.parse(out.join('\n'));
  assert.deepStrictEqual([json.verified, json.page_check.mode, json.page_check.ok, json.page_check.files[0].file], [true, 'watch', false, 'site-watch/index.html']);
  assert.strictEqual(await deploy.run([dir, '--name', 'demo', '--dry-run'], quiet), 0);
});

test('in block mode publish and deploy upload nothing unless every page passes', () => blocking(async () => {
  const before = uploads;
  const plain = compilePage(GOOD);
  const refusals = [
    [folder('site-bad', { 'index.html': BAD }), /refused site-bad\/index\.html/],
    [folder('site-edited', { 'index.html': plain.replace('every week', 'each week') }), /edited after it was built\. rebuild it from the content page\./],
    [folder('site-look', { 'index.html': compilePage(GOOD, { look: 'paper', lookCss: 'body{font-family:Georgia,serif}' }) }), /look paper has no pick on record\. only the owner picks a look\./],
  ];
  for (const [dir, said] of refusals) {
    const err = [];
    assert.strictEqual(await publish.run([dir, '--slug', 'demo'], { ...quiet, error: (s) => err.push(s), fetch }), 1, dir);
    assert.match(err.join('\n'), said);
    // a slug or name of help is a slug, not a request for help
    assert.strictEqual(await upload([dir, '--slug', 'help']), 1, dir);
    assert.strictEqual(await deploy.run([dir, '--name', 'help', '--dry-run'], quiet), 1, dir);
  }
  assert.strictEqual(uploads, before);
  folder('site-clean', { 'index.html': plain, 'node_modules/x.html': BAD });
  assert.strictEqual(await upload(['site-clean', '--slug', 'demo']), 0);
  assert.strictEqual(uploads, before + 1);
  recordPick(root, 'paper');
  assert.strictEqual(await upload(['site-look', '--slug', 'demo']), 0);
  assert.strictEqual(uploads, before + 2);
}));

test('publish --build checks the built folder and in block mode uploads only when it passes', () => blocking(async () => {
  const before = uploads;
  const build = "node -e \"require('fs').mkdirSync('dist');require('fs').copyFileSync('page.html','dist/index.html')\"";
  const app = (name, page) => folder(name, { 'package.json': JSON.stringify({ scripts: { build } }), 'page.html': page });
  assert.strictEqual(await upload([app('app-bad', BAD), '--slug', 'demo', '--build']), 1);
  assert.strictEqual(uploads, before);
  assert.strictEqual(await upload([app('app-good', compilePage(GOOD)), '--slug', 'demo', '--build']), 0);
  assert.strictEqual(uploads, before + 1);
}));

test('a page whose styles or words the check could not see never reads as every rule passes', async () => {
  const glow = '.card{box-shadow:0 0 60px 20px #a855f7}';
  const raw = (head, body = '<p class="card">Each student wrote a draft every week, and the teacher read every one of them.</p>') => `<!doctype html><html lang="en"><head>${head}</head><body><main>${body}</main></body></html>`;
  folder('site-sheets', { 'index.html': raw('<link rel="stylesheet" href="/css/site.css">'), 'css/site.css': glow, 'typo.html': raw('<link rel="stylesheet" href="css/sty1es.css">') });
  const res = await cli(['check', 'site-sheets']);
  assert.match(res.err, /refused site-sheets\/index\.html[\s\S]*a glow/);
  assert.match(res.out, /ok site-sheets\/typo\.html: no rule failed\. not checked: css\/sty1es\.css is not there/);
  const err = [];
  assert.strictEqual(await blocking(() => publish.run(['site-sheets', '--slug', 'demo'], { ...quiet, error: (s) => err.push(s), fetch })), 1);
  assert.match(err.join('\n'), /line 1: a style sheet that is not in the folder: "css\/sty1es\.css"/);
  folder('spa', { 'index.html': raw('<script src="app.js"></script>', '<div id="root"></div>'), 'app.js': '' });
  assert.match((await cli(['check', 'spa'])).out, /not checked: a script draws this page/);
});

test('a site atris builds from clean markdown passes the upload check in every theme', async () => {
  const before = uploads;
  folder('md', {
    'hours.md': '# Hours\n\nWe open at seven every morning and close when the bread runs out, which is most days by two in the afternoon.\n\nOn Sundays we bake rye only, and the door opens an hour later.\n\n## Prices\n\n- Sourdough, four dollars\n- Rye, five dollars\n',
    'team.md': '# Team\n\nThree bakers share the ovens and take turns starting the dough at four in the morning, every single day of the year.\n\nAna runs the counter on weekdays and knows every regular by name.\n',
    'orders.md': '# Orders\n\nWe take orders for parties of ten or more if you write to us two days ahead of the party.\n\nPick up is at the side door, and we keep the order warm until noon.\n',
  });
  for (const theme of ['atris', 'terminal', 'paper']) {
    assert.strictEqual((await cli(['md', '--out', `md-${theme}`, '--theme', theme, '--title', 'Bakery'])).code, 0);
    const html = fs.readFileSync(path.join(root, `md-${theme}`, 'hours.html'), 'utf8');
    for (const words of ['On Sundays we bake rye only', 'Rye, five dollars']) assert.ok(html.includes(words), words);
    assert.strictEqual(await upload([`md-${theme}`, '--slug', 'demo']), 0, theme);
  }
  assert.strictEqual(uploads, before + 3);
});
