const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const site = require('../commands/site');
const publish = require('../lib/site-publish');
const { compilePage, recordPick, themeCss } = require('../lib/page-lang');
const { PAGE_RULES } = require('../lib/page-rules');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-site-check-'));
const home = process.cwd();
process.chdir(root);
// the exit hook also cleans up after a failed assert or process.exit, where test.after never runs.
// a signal ends the process without the exit hook. each one is turned into process.exit
const cleanup = () => { process.chdir(home); fs.rmSync(root, { recursive: true, force: true }); };
test.after(cleanup);
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => process.exit(sig === 'SIGINT' ? 130 : sig === 'SIGHUP' ? 129 : 143));

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
  assert.match(bad.err, /^refused pages\/bad\.html \(2 things to fix\)\nline 4: /);
  assert.match(bad.err, /line 6: a tag not on the allowed list: "<div>"/);
  const good = await cli(['check', 'pages/good.html']);
  assert.deepStrictEqual([good.code, good.out], [0, 'ok pages/good.html: every page rule passes. the browser rules did not run: atris site check pages/good.html --render runs them']);
  const json = JSON.parse((await cli(['check', 'pages', '--json'])).out);
  assert.deepStrictEqual(json.files.map((f) => [f.file, f.kind, f.ok]), [['pages/bad.html', 'content', false], ['pages/good.html', 'content', true]]);
  // one call gives the data and the words a plain run prints
  assert.deepStrictEqual(json.files.map((f) => f.text), [bad.err, good.out]);
});

test('a markdown site of one short paragraph passes its own check', async () => {
  folder('md', { 'team.md': '# Team\n\nThree bakers share the ovens and start the dough at four every morning.\n' });
  for (const theme of ['atris', 'terminal', 'paper']) {
    await cli(['md', '--out', `md-${theme}`, '--theme', theme]);
    const res = await cli(['check', `md-${theme}`]);
    assert.deepStrictEqual([theme, res.code, res.err], [theme, 0, '']);
  }
});

test('a form refusal names the one thing that is wrong, and the count matches the list', async () => {
  folder('forms', { 'hidden.html': '<main>\n<h1>Sign up</h1>\n<form>\n<label for="e">Email</label>\n<input id="e" type="email">\n<button>Join</button>\n<p role="alert" hidden>That email is taken.</p>\n</form>\n</main>\n' });
  const res = await cli(['check', 'forms/hidden.html']);
  assert.match(res.err, /^refused forms\/hidden\.html \(2 things to fix\)\n/);
  assert.match(res.err, /line 3: a form whose failure words never show: "<form>"\. write what went wrong in an <output>, or in an element with role="alert"/);
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
  const mode = async () => JSON.parse((await cli(['rules', '--json'])).out).mode;
  assert.deepStrictEqual([await mode(), await blocking(mode)], ['watch', 'block']);
  assert.doesNotMatch(res.out + (await cli(['--help'])).out, /--mode/);
});

test('only a person at a terminal can pick a theme for content pages', async () => {
  const theme = require('../commands/theme');
  const saved = console.error;
  console.error = () => {};
  try { assert.strictEqual(await theme.run(['pick', 'atris']), 1); } finally { console.error = saved; }
  assert.ok(!fs.existsSync(path.join(root, '.atris', 'theme.json')));
});

test('a content page builds to index.html in a theme', async () => {
  const res = await cli(['pages/good.html', '--theme', 'atris', '--out', 'built']);
  assert.strictEqual(res.code, 0);
  assert.match(fs.readFileSync(path.join(root, 'built', 'index.html'), 'utf8'), /<meta name="atris-page" content="atris sha256:/);
  assert.strictEqual((await cli(['pages/bad.html', '--out', 'built2'])).code, 1);
  assert.ok(!fs.existsSync(path.join(root, 'built2')));
});

test('in watch mode publish says what would fail and uploads as before', async () => {
  const before = uploads;
  const dir = folder('site-watch', { 'index.html': BAD });
  const out = [], err = [];
  assert.strictEqual(await upload([dir, '--slug', 'demo', '--json'], { log: (s) => out.push(s), error: (s) => err.push(s) }), 0);
  assert.strictEqual(uploads, before + 1);
  assert.match(err.join('\n'), /^page check in watch mode: these lines do not stop the upload\. in block mode each page marked would refuse stops it\.\nwould refuse site-watch\/index\.html \(2 things to fix\)\nline 4: /);
  const json = JSON.parse(out.join('\n'));
  assert.deepStrictEqual([json.verified, json.page_check.mode, json.page_check.ok, json.page_check.files[0].file], [true, 'watch', false, 'site-watch/index.html']);
  assert.strictEqual(await deploy.run([dir, '--name', 'demo', '--dry-run'], quiet), 0);
});

test('a fullstack deploy says its page check read only the html in the folder before the server build', async () => {
  const dir = folder('site-server', { 'package.json': '{ "scripts": { "start": "node server.js" } }' });
  const out = [];
  assert.strictEqual(await deploy.run([dir, '--fullstack', '--name', 'demo', '--dry-run'], { ...quiet, log: (s) => out.push(s) }), 0);
  assert.match(out.join('\n'), /^page check read 0 html files in the folder\. pages the server builds or draws were not checked$/m);
});

test('in block mode publish and deploy upload nothing unless every page passes', () => blocking(async () => {
  const before = uploads;
  const plain = compilePage(GOOD);
  const refusals = [
    [folder('site-bad', { 'index.html': BAD }), /refused site-bad\/index\.html/],
    [folder('site-edited', { 'index.html': plain.replace('every week', 'each week') }), /edited after it was built\. rebuild it from the content page\./],
    [folder('site-head', { 'index.html': plain.replace('</head>', '<style>p{color:red}</style>\n</head>') }), /edited after it was built/],
    [folder('site-look', { 'index.html': compilePage(GOOD, { look: 'atris', lookCss: themeCss(root, 'atris') }) }), /theme atris has no pick on record in \.atris\/theme\.json\. only the owner picks a theme for content pages, with atris theme pick <name> at a terminal\./],
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
  // a linked page publish does not upload is not checked either
  fs.symlinkSync(path.join(root, 'site-bad', 'index.html'), path.join(root, 'site-clean', 'link.html'));
  assert.strictEqual(await upload(['site-clean', '--slug', 'demo']), 0);
  assert.strictEqual(uploads, before + 1);
  recordPick(root, 'atris');
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
  // a failing page beside it does not hide it, in the words or in the record
  folder('spa', { 'bad.html': BAD });
  const out = [];
  err.length = 0;
  assert.strictEqual(await upload(['spa', '--slug', 'demo', '--json'], { log: (s) => out.push(s), error: (s) => err.push(s) }), 0);
  assert.match(err.join('\n'), /spa\/index\.html: not checked: a script draws this page/);
  assert.deepStrictEqual(JSON.parse(out.join('\n')).page_check.not_checked.map((n) => n.file), ['spa/index.html']);
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

// A pass without --render must not read as if the browser rules ran.
const { RENDER_RULES } = require('../lib/page-render');

// A page drawn by a script: its words show only once the browser runs the script.
const drawn = (body) => `<!doctype html>\n<html lang="en">\n<head><title>Hours</title></head>\n<body>\n<div id="root"></div>\n<script>document.getElementById('root').innerHTML = '${body}';</script>\n</body>\n</html>\n`;
const noBrowser = require('../lib/headless-chrome').findBrowser() ? false : 'no browser found on this computer; install Chrome, Chromium, Edge or Brave, or set CHROME_PATH to run it';
const withRules = async (rules, fn) => {
  fs.mkdirSync(path.dirname(rulesFile), { recursive: true });
  fs.writeFileSync(rulesFile, JSON.stringify(rules));
  try { return await fn(); } finally { fs.rmSync(rulesFile); }
};

test('--render opens the page in a browser: a clean page passes every rule and a wide box scrolls sideways', { skip: noBrowser }, async () => {
  folder('plain', { 'good.html': GOOD, 'wide.html': '<!doctype html>\n<html lang="en">\n<head><title>Plans</title></head>\n<body>\n<main>\n<h1>Plans</h1>\n<div style="width:2000px">One row of plan names.</div>\n</main>\n</body>\n</html>\n' });
  const good = await cli(['check', 'plain/good.html', '--render']);
  assert.deepStrictEqual([good.code, good.out], [0, 'ok plain/good.html: every rule passes']);
  const json = JSON.parse((await cli(['check', 'plain/good.html', '--render', '--json'])).out);
  assert.deepStrictEqual(json.files.map((f) => [f.file, f.ok, f.rendered]), [['plain/good.html', true, true]]);
  const wide = await cli(['check', 'plain/wide.html', '--render']);
  assert.strictEqual(wide.code, 1);
  assert.match(wide.err, /scrolls sideways at this width/);
});

test('a browser that cannot run still prints the page rules that ran and says the browser check did not run', { skip: process.platform === 'win32' ? 'the stand-in browser is a shell script' : false }, async () => {
  folder('plain', { 'good.html': GOOD });
  folder('pages', { 'bad.html': BAD });
  const broken = path.join(root, 'broken-chrome');
  fs.writeFileSync(broken, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
  const saved = process.env.CHROME_PATH;
  process.env.CHROME_PATH = broken;
  try {
    const good = await cli(['check', 'plain/good.html', '--render']);
    assert.strictEqual(good.code, 1);
    assert.strictEqual(good.err, `ok plain/good.html: every page rule passes. the browser rules did not run\nthe browser check did not run on plain/good.html: the browser ${broken} stopped with code 3 and printed nothing. check CHROME_PATH`);
    const bad = await cli(['check', 'pages/bad.html', '--render']);
    assert.strictEqual(bad.code, 1);
    assert.match(bad.err, /^refused pages\/bad\.html \(2 things to fix\)\n[\s\S]*"<div>"[\s\S]*\nthe browser check did not run on pages\/bad\.html: /);
    const run = await cli(['check', 'plain/good.html', '--render', '--json']);
    assert.strictEqual(run.code, 1);
    const json = JSON.parse(run.out);
    assert.deepStrictEqual(json.files.map((f) => [f.file, f.ok, f.rendered, typeof f.reason]), [['plain/good.html', true, false, 'string']]);
    assert.strictEqual(json.files[0].reason, `the browser ${broken} stopped with code 3 and printed nothing. check CHROME_PATH`);
  } finally {
    if (saved === undefined) delete process.env.CHROME_PATH; else process.env.CHROME_PATH = saved;
    fs.rmSync(broken);
  }
});

test('--render keeps a rule the project switched off switched off on a page a script draws', { skip: noBrowser }, async () => {
  folder('spa-sub', { 'index.html': drawn('<main><h1>Hours</h1><p>We open at seven every morning and close when the bread runs out, which is most days by two.</p></main>') });
  const on = await cli(['check', 'spa-sub/index.html', '--render']);
  assert.strictEqual(on.code, 1);
  assert.match(on.err, /page-subtitle/);
  const off = await withRules({ off: ['page-subtitle'] }, () => cli(['check', 'spa-sub/index.html', '--render']));
  assert.strictEqual(off.code, 0, off.err);
  assert.match(off.out, /^ok spa-sub\/index\.html: every rule passes\nswitched off in \.atris\/slop\.rules\.json: page-subtitle$/);
});

test('after --render a page a script draws reads every rule passes, unless the browser saw no words either', { skip: noBrowser }, async () => {
  folder('spa-drawn', { 'index.html': drawn('<main><header><h1>Writing coach</h1></header><section><h2>Notes</h2><p>Each student wrote a draft every week, and the teacher read every one of them.</p><p>The drafts got shorter and clearer as the term went on, and nobody wrote for them.</p></section></main>') });
  const res = await cli(['check', 'spa-drawn/index.html', '--render']);
  assert.deepStrictEqual([res.code, res.out], [0, 'ok spa-drawn/index.html: every rule passes']);
  const json = JSON.parse((await cli(['check', 'spa-drawn/index.html', '--render', '--json'])).out);
  assert.deepStrictEqual(json.files.map((f) => [f.rendered, f.notChecked]), [[true, []]]);
  folder('spa-empty', { 'index.html': drawn('') });
  assert.strictEqual((await cli(['check', 'spa-empty/index.html', '--render'])).out, 'ok spa-empty/index.html: no rule failed. not checked: a script draws this page and the browser saw no words after the wait. its words were not read');
});

test('the follow-up command quotes a path with a space', async () => {
  folder('my site', { 'home page.html': GOOD });
  const res = await cli(['check', 'my site/home page.html']);
  assert.deepStrictEqual([res.code, res.out], [0, "ok my site/home page.html: every page rule passes. the browser rules did not run: atris site check 'my site/home page.html' --render runs them"]);
});

test('the follow-up command reads a path that starts with a dash as a path and on windows keeps a backslash path plain', () => {
  const { report } = require('../lib/page-lang');
  const command = (file, platform) => {
    const out = [];
    report([{ file, ok: true, rendered: false, findings: [], notChecked: [] }], { log: (s) => out.push(s), platform });
    return out[0].replace(/^.*did not run: /, '');
  };
  assert.strictEqual(command('-page.html', 'darwin'), 'atris site check ./-page.html --render runs them');
  assert.strictEqual(command('=eq/p.html', 'darwin'), "atris site check '=eq/p.html' --render runs them");
  assert.strictEqual(command('pages\\good.html', 'win32'), 'atris site check pages\\good.html --render runs them');
  assert.strictEqual(command('my site\\home page.html', 'win32'), 'atris site check "my site\\home page.html" --render runs them');
});

const SUB = '<main>\n<header>\n<h1>Writing coach</h1>\n<p>Better essays every week.</p>\n</header>\n</main>\n';

test('a passing upload still names the rules the project switched off, on screen and in page_check', async () => {
  const dir = folder('site-sub', { 'index.html': SUB });
  assert.strictEqual(await blocking(() => upload([dir, '--slug', 'demo'])), 1);
  const before = uploads;
  const out = [], err = [];
  const code = await withRules({ pages: 'block', off: ['page-subtitle'] }, () => upload([dir, '--slug', 'demo', '--json'], { log: (s) => out.push(s), error: (s) => err.push(s) }));
  assert.deepStrictEqual([code, uploads], [0, before + 1]);
  assert.strictEqual(err.join('\n'), 'page check in block mode: switched off in .atris/slop.rules.json: page-subtitle');
  assert.deepStrictEqual(JSON.parse(out.join('\n')).page_check, { mode: 'block', ok: true, off: ['page-subtitle'], files: [], not_checked: [] });
});

// Every site command reads the rules file, the theme picks and the build from the folder it runs in.
test('check and build agree on a switched-off rule from any folder', async () => {
  folder('agree', { 'web/page.html': SUB, '.atris/slop.rules.json': '{ "off": ["page-subtitle"] }' });
  process.chdir(path.join(root, 'agree'));
  try {
    assert.deepStrictEqual([(await cli(['check', 'web/page.html'])).code, (await cli(['web/page.html', '--out', 'dist'])).code], [0, 0]);
    process.chdir(path.join(root, 'agree', 'web'));
    assert.deepStrictEqual([(await cli(['check', 'page.html'])).code, (await cli(['page.html', '--out', 'dist'])).code], [1, 1]);
  } finally { process.chdir(root); }
});

test('a page built in a picked theme passes the upload check from the folder where it was picked and built', async () => {
  folder('picked', { '.atris/slop.rules.json': '{ "pages": "block" }', 'web/page.html': GOOD });
  process.chdir(path.join(root, 'picked', 'web'));
  try {
    recordPick(process.cwd(), 'atris');
    assert.strictEqual((await cli(['page.html', '--theme', 'atris', '--out', 'dist'])).code, 0);
    const err = [];
    assert.strictEqual(await deploy.run(['dist', '--name', 'demo', '--dry-run'], { ...quiet, error: (s) => err.push(s) }), 0);
    assert.strictEqual(err.join('\n'), '');
  } finally { process.chdir(root); }
});

test('a rules file that cannot be read is named and the upload is refused', async () => {
  const before = uploads;
  folder('broken', { '.atris/slop.rules.json': '{ "pages": "block", }', 'index.html': compilePage(GOOD), 'good.html': GOOD });
  process.chdir(path.join(root, 'broken'));
  try {
    const said = /^\.atris\/slop\.rules\.json could not be read: /m;
    const res = await cli(['check', 'index.html']);
    assert.strictEqual(res.code, 0);
    assert.match(res.err, said);
    assert.match((await cli(['rules'])).err, said);
    const mode = await cli(['rules', '--json']);
    assert.deepStrictEqual([mode.code, JSON.parse(mode.out).mode], [0, 'unknown']);
    assert.match(mode.err, said);
    assert.match((await cli(['good.html', '--out', 'dist'])).err, said);
    const err = [];
    assert.strictEqual(await upload(['.', '--slug', 'demo'], { error: (s) => err.push(s) }), 1);
    assert.match(err.join('\n'), said);
    assert.strictEqual(await deploy.run(['.', '--name', 'demo', '--dry-run'], quiet), 1);
    // a setting that parses and means nothing is named the same way, system error names keep their case
    for (const [text, why] of [['{ "pages": "blocked" }', /pages is neither "block" nor "watch"/], ['{ "off": "page-subtitle" }', /off is not a list of rule ids/]]) {
      fs.writeFileSync(path.join(root, 'broken', '.atris', 'slop.rules.json'), text);
      const named = await cli(['rules', '--json']);
      assert.strictEqual(JSON.parse(named.out).mode, 'unknown');
      assert.match(named.err, why);
    }
    fs.rmSync(path.join(root, 'broken', '.atris', 'slop.rules.json'));
    fs.mkdirSync(path.join(root, 'broken', '.atris', 'slop.rules.json'));
    assert.match((await cli(['rules', '--json'])).err, /could not be read: EISDIR/);
  } finally { process.chdir(root); }
  assert.strictEqual(uploads, before);
});

test('a rules file in the list form atris slop rules --add writes reads as watch mode and the upload goes ahead', async () => {
  const before = uploads;
  folder('listform', { '.atris/slop.rules.json': '[{ "id": "no-synergy", "pattern": "synerg", "why": "the owner never says synergy" }]', 'index.html': compilePage(GOOD) });
  process.chdir(path.join(root, 'listform'));
  try {
    const mode = await cli(['rules', '--json']);
    assert.deepStrictEqual([mode.code, JSON.parse(mode.out).mode, mode.err], [0, 'watch', '']);
    assert.strictEqual(await upload(['.', '--slug', 'demo'], quiet), 0);
  } finally { process.chdir(root); }
  assert.strictEqual(uploads, before + 1);
});

test('rules says which rules this project switched off, in text and in --json', async () => {
  assert.deepStrictEqual(JSON.parse((await cli(['rules', '--json'])).out).off, []);
  assert.doesNotMatch((await cli(['rules'])).out, /switched off/);
  await withRules({ off: ['page-subtitle'] }, async () => {
    assert.match((await cli(['rules'])).out, /\nswitched off in \.atris\/slop\.rules\.json: page-subtitle\n/);
    assert.deepStrictEqual(JSON.parse((await cli(['rules', '--json'])).out).off, ['page-subtitle']);
  });
});

test('the machine output carries whether the browser rules ran as a field', async () => {
  folder('plain', { 'good.html': GOOD });
  const json = JSON.parse((await cli(['check', 'plain/good.html', '--json'])).out);
  assert.deepStrictEqual(json.files.map((f) => [f.file, f.ok, f.rendered]), [['plain/good.html', true, false]]);
});

test('rules lists every browser rule as one that needs --render', async () => {
  assert.strictEqual(RENDER_RULES.length, 7);
  const res = await cli(['rules']);
  const at = res.out.indexOf('browser rules, run only with atris site check <file> --render');
  assert.ok(at !== -1, res.out);
  for (const r of RENDER_RULES) assert.ok(res.out.indexOf(`  ${r.id}: `, at) > at, r.id);
  const json = JSON.parse((await cli(['rules', '--json'])).out);
  assert.deepStrictEqual(json.browser.map((r) => [r.id, r.needs]), RENDER_RULES.map((r) => [r.id, '--render']));
});

// a guess about what words mean is shown to the reviewer and never stops a page
const NOTED = GOOD.replace('</section>', '<p>This page lists every draft the class wrote this term, newest first.</p>\n</section>');
test('a page with only notes for the reviewer passes check, the upload check and the landing gate in block mode', () => blocking(async () => {
  folder('noted', { 'page.html': NOTED, 'both.html': NOTED.replace('<h2>Notes</h2>', '<h2>Notes</h2>\n<div>Hi</div>') });
  const res = await cli(['check', 'noted/page.html']);
  assert.strictEqual(res.code, 0, res.err);
  assert.match(res.out, /^ok noted\/page\.html: every page rule passes\. the browser rules did not run[^\n]*\nnoted\/page\.html:7 for the reviewer: text about the page[^\n]*: "This page lists[^\n]*"\. it may be fine: [^\n]+\.$/);
  const json = JSON.parse((await cli(['check', 'noted/page.html', '--json'])).out).files[0];
  assert.deepStrictEqual([json.ok, json.findings.map((f) => [f.rule, f.level])], [true, [['page-explanatory', 'warn']]]);
  // must-fix lines come first and only they are counted
  const both = await cli(['check', 'noted/both.html']);
  assert.strictEqual(both.code, 1);
  assert.match(both.err, /^refused noted\/both\.html \(1 thing to fix\)\nline 5: a tag not on the allowed list[^\n]*\nnoted\/both\.html:8 for the reviewer: /);
  const before = uploads;
  const built = folder('noted-site', { 'index.html': compilePage(NOTED) });
  assert.strictEqual(await upload([built, '--slug', 'demo']), 0);
  assert.strictEqual(uploads, before + 1);
  // the landing gate lands a new page with only notes and holds one that fails
  const { spawnSync } = require('child_process');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-note-gate-'));
  try {
    const git = (...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo, encoding: 'utf8' });
    git('init', '-q', '-b', 'master');
    fs.mkdirSync(path.join(repo, '.atris'));
    fs.writeFileSync(path.join(repo, '.atris', 'slop.rules.json'), '{ "pages": "block" }\n');
    git('add', '.'); git('commit', '-qm', 'start');
    fs.writeFileSync(path.join(repo, 'new.html'), NOTED);
    fs.writeFileSync(path.join(repo, 'docs.html'), GOOD.replace('</section>', '<pre><code>{{ name }} and {% if %}</code></pre>\n<div>Hi</div>\n</section>'));
    git('add', '.');
    const { candidatePolicyGate } = require('../lib/auto-accept-certified');
    const landed = candidatePolicyGate({ workspace_root: repo, metadata: { changed_files: ['new.html'] } });
    assert.strictEqual(landed.ok, true, (landed.offenders || []).join(', '));
    assert.deepStrictEqual(landed.gate.page_notes.map((n) => [n.file, n.rule]), [['new.html', 'page-explanatory']]);
    const shown = candidatePolicyGate({ workspace_root: repo, metadata: { changed_files: ['docs.html'] } });
    assert.strictEqual(shown.reason, 'slop_gate');
    assert.ok(shown.offenders.some((o) => /^docs\.html:\d+ lang-tags$/.test(o)), shown.offenders.join(', '));
    // template marks in the words never switch the page rules off
    fs.writeFileSync(path.join(repo, 'words.html'), GOOD.replace('</section>', '<p>Type {{ name }} where it goes and the room stays quiet for the hour.</p>\n</section>'));
    git('add', '.');
    const held = candidatePolicyGate({ workspace_root: repo, metadata: { changed_files: ['words.html'] } });
    assert.ok(held.offenders.some((o) => o.endsWith('page-word-quiet')), (held.offenders || []).join(', '));
    // a broken rules file is named on a page that passes too
    fs.writeFileSync(path.join(repo, '.atris', 'slop.rules.json'), '{ "pages": "blok" }\n');
    const typo = candidatePolicyGate({ workspace_root: repo, metadata: { changed_files: ['new.html'] } });
    assert.ok(typo.gate.advisories.some((a) => a.reason === 'page_rules_unreadable'), JSON.stringify(typo.gate.advisories));
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
}));
