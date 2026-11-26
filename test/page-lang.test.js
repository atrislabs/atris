const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkContentPage, compilePage, builtProblems, recordPick, themeCss } = require('../lib/page-lang');
const { upsertProjectTheme } = require('../lib/theme');
const { checkPage } = require('../lib/page-rules');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-page-lang-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
fs.writeFileSync(path.join(root, 'survey.csv'), 'term,drafts\n');
fs.writeFileSync(path.join(root, 'class.png'), '');

const PROSE = '<p>Each student wrote a draft every week, and the teacher read every one of them.</p>\n<p>The drafts got shorter and clearer as the term went on, and nobody wrote for them.</p>';
const page = (body, head = '<header><h1>Writing coach</h1></header>') => `<main>\n${head}\n${body}\n</main>\n`;
const rules = (text) => checkContentPage(text, 'p.html', { root }).findings.map((f) => `${f.rule}@${f.line}`);

test('a good content page passes every rule', () => {
  const good = page(`<section>\n<h2>40% more drafts</h2>\n${PROSE}\n<cite>survey.csv</cite>\n</section>\n<section>\n<h2>Ask for a seat</h2>\n<form action="/ask" method="post" aria-label="Ask for a seat">\n<label for="email" lang="en">Email</label>\n<input id="email" name="email" type="email" autocomplete="email" maxlength="80" required>\n<button type="submit">Ask for a seat</button>\n</form>\n<p role="alert">That email did not reach us, so please send it again.</p>\n<img src="class.png" alt="The class at work">\n</section>\n<section>\n<h2>Sign in</h2>\n<form action="/in" method="post">\n<input type="hidden" name="csrf" value="abc123">\n<label for="pw">Password</label>\n<input id="pw" name="pw" type="password">\n<input type="submit" value="Sign in">\n<output>That password did not match, so please try again.</output>\n</form>\n</section>`);
  assert.deepStrictEqual(rules(good), []);
});

test('each grammar rule refuses its bad page at the line', () => {
  const cases = [
    ['lang-root', '<p>Before the page starts here.</p>\n' + page(PROSE), 1],
    ['lang-root', page(`<!-- a note -->\n${PROSE}`), 3],
    ['lang-tags', page(`<div>${PROSE}</div>`), 3],
    ['lang-attrs', page(`<section class="hero">\n${PROSE}\n</section>`), 3],
    ['lang-attrs', page(`<section onclick="go()">\n${PROSE}\n</section>`), 3],
    ['lang-attrs', page(`<section data-variant="hero">\n${PROSE}\n</section>`), 3],
    ['lang-attrs', page(`<p><a href="javascript:go()">Go to the next page</a></p>`), 3],
    ['lang-heading', page(`<h1>Another title here</h1>\n${PROSE}`), 3],
    ['lang-heading', page(`<h2>Notes</h2>\n<h1>Writing coach</h1>\n${PROSE}`, ''), 3],
    ['lang-heading', page(PROSE, '<header><p>Each draft.</p></header>'), 2],
    ['lang-source', page(`<section>\n<h2>40% more drafts</h2>\n${PROSE}\n<cite>missing.csv</cite>\n</section>`), 4],
    ['lang-image', page(`<section>\n${PROSE}\n<img src="nothing.png" alt="The class">\n</section>`), 6],
    ['lang-image', page(`<section>\n${PROSE}\n<img src="class.png">\n</section>`), 6],
    ['lang-form', page('<form action="/a">\n<input id="e" name="e">\n<button type="submit">Send the note</button>\n<output>That did not go through, so please send it again.</output>\n</form>'), 4],
    ['lang-form', page('<form action="/a">\n<label for="e">Email</label>\n<input id="e" name="e">\n<button type="submit">Send the note</button>\n</form>'), 3],
  ];
  for (const [id, text, line] of cases) assert.ok(rules(text).includes(`${id}@${line}`), `${id} at line ${line}: ${rules(text).join(', ')}`);
  // only a class or a style hears that the look is not theirs; a page with no header is fine
  const fixes = checkContentPage(page(`<section class="a" onclick="b">\n${PROSE}\n</section>\n<section onclick="b">\n${PROSE}\n</section>`), 'p.html', { root }).findings.filter((f) => f.rule === 'lang-attrs').map((f) => f.fix);
  assert.deepStrictEqual(fixes, ['remove it. the look is not yours to set', 'remove it. a content page holds words and structure only']);
  assert.deepStrictEqual(rules(page(`<section>\n<h2>Notes</h2>\n${PROSE}\n</section>`, '<h1>Writing coach</h1>')), []);
});

test('a built page must still be what was built, in plain or a picked theme', () => {
  const content = page(PROSE);
  const plain = compilePage(content);
  assert.deepStrictEqual(builtProblems(plain, root), []);
  assert.strictEqual(builtProblems(plain.replace('every week', 'each week'), root)[0].rule, 'built-edited');
  assert.strictEqual(builtProblems(plain.replace('<style>', '<style>p{color:#333}'), root)[0].rule, 'built-edited');
  const paper = compilePage(content, { look: 'paper', lookCss: themeCss(root, 'paper') });
  assert.strictEqual(builtProblems(paper, root)[0].rule, 'built-look-unpicked');
  recordPick(root, 'paper');
  assert.deepStrictEqual(builtProblems(paper, root), []);
  // the pick sits in .atris/theme.json beside the themes and a theme changed after it needs a new pick
  upsertProjectTheme('paper', { color: { accent: '#0000ff' } }, root);
  assert.deepStrictEqual(builtProblems(paper, root), []);
  const changed = compilePage(content, { look: 'paper', lookCss: themeCss(root, 'paper') });
  assert.strictEqual(builtProblems(changed, root)[0].rule, 'built-look-unpicked');
  assert.throws(() => themeCss(root, 'nope'), /^Error: no theme named nope\. atris theme list shows the themes$/);
});

// --- the compile invariant: any valid content page built in plain passes every page rule ---

function rng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const WORDS = 'student teacher draft week school term class essay note paper reading writing coach parent seat morning lesson ruler window garden river bread table chair library'.split(' ');
const FOREIGN = ['élève', 'cuaderno', 'Schüler', '学生', '작문', 'учитель', 'कक्षा', 'مدرسة'];

function generate(r) {
  const pick = (list) => list[Math.floor(r() * list.length)];
  const word = () => (r() < 0.1 ? pick(FOREIGN) : r() < 0.03 ? 'x'.repeat(120 + Math.floor(r() * 200)) : pick(WORDS));
  const sentence = () => { const w = Array.from({ length: 9 + Math.floor(r() * 6) }, word); w[0] = w[0][0].toUpperCase() + w[0].slice(1); return `${w.join(' ')}.`; };
  const para = () => `<p>${sentence()} ${sentence()}</p>`;
  const title = () => { const w = Array.from({ length: 3 + Math.floor(r() * 3) }, word); return w[0][0].toUpperCase() + w.join(' ').slice(1); };
  const sections = [];
  for (let s = 0; s < 1 + Math.floor(r() * 4); s++) {
    const kind = pick(['prose', 'table', 'form', 'list', 'stat', 'terms', 'more']);
    const wrap = pick(['section', 'article', 'aside']);
    if (kind === 'prose') sections.push(`<${wrap} aria-label="${pick(WORDS)}" lang="${pick(['en', 'fr', 'de'])}">\n<h2>${title()}</h2>\n${para()}\n<blockquote cite="https://example.org/${pick(WORDS)}">${para()}</blockquote>\n<p>${sentence()} Press <kbd>${pick(WORDS)}</kbd>, see <abbr title="${title()}">${pick(WORDS)}</abbr> and <em>${pick(WORDS)}</em>, water is H<sub>2</sub>O and E is mc<sup>2</sup>.</p>\n<hr>\n</${wrap}>`);
    if (kind === 'terms') {
      const terms = Array.from({ length: 1 + Math.floor(r() * 3) }, () => `<dt>${title()}</dt>\n<dd>${sentence()}</dd>`).join('\n');
      sections.push(`<section>\n<h2>${title()}</h2>\n${para()}\n${para()}\n<dl>\n${terms}\n</dl>\n</section>`);
    }
    if (kind === 'more') sections.push(`<section>\n<h2>${title()}</h2>\n${para()}\n${para()}\n<details${r() < 0.5 ? ' open' : ''}>\n<summary>${title()}</summary>\n${para()}\n</details>\n<address><a href="https://example.org/${pick(WORDS)}" rel="noopener" target="_blank" title="${title()}">${title()}</a></address>\n</section>`);
    if (kind === 'stat') sections.push(`<${wrap}>\n<h2>${1 + Math.floor(r() * 90)}% more ${pick(WORDS)}s</h2>\n${para()}\n${para()}\n<cite>https://example.org/${pick(WORDS)}</cite>\n</${wrap}>`);
    if (kind === 'table') {
      const rows = Array.from({ length: Math.floor(r() * 5) }, () => `<tr><th>${title()}</th><td>${Math.floor(r() * 99999).toLocaleString('en-US')}</td></tr>`).join('\n');
      sections.push(`<section>\n<h2>${title()}</h2>\n<table>\n<caption>${title()}</caption>\n<thead><tr><th scope="col" id="c${s}">${pick(WORDS)}</th><th scope="col">${pick(WORDS)}</th></tr></thead>\n<tbody>\n${rows}\n</tbody>\n</table>\n<cite>https://example.org/data</cite>\n</section>`);
    }
    if (kind === 'list') {
      const items = Array.from({ length: Math.floor(r() * 4) }, () => `<li>${sentence()}</li>`).join('\n');
      const tag = pick(['ul', 'ol start="3" reversed']);
      sections.push(`<section>\n<h2>${title()}</h2>\n${para()}\n${para()}\n<${tag}>\n${items}\n</${tag.split(' ')[0]}>\n</section>`);
    }
    if (kind === 'form') {
      const id = `f${s}`;
      const field = pick([`<input id="${id}" name="${id}" type="text" inputmode="numeric" pattern="[0-9]+" minlength="2" maxlength="9" autocomplete="off" required>`, `<input id="${id}" name="${id}" type="number" min="1" max="9" step="1">`, `<textarea id="${id}" name="${id}" aria-describedby="h${id}"></textarea>`, `<select id="${id}" name="${id}" multiple><option value="a" selected>${title()}</option></select>`]);
      const fails = pick([`<output>${sentence()}</output>\n</form>`, `<p role="alert">${sentence()}</p>\n</form>`, `</form>\n<p aria-live="polite">${sentence()}</p>`]);
      sections.push(`<section>\n<h2>${title()}</h2>\n<form action="/send" method="post">\n<label for="${id}">${title()}</label>\n${field}\n<button type="submit">${title()}</button>\n${fails}\n</section>`);
    }
  }
  const footer = r() < 0.5 ? `\n<footer>\n${para()}\n${para()}\n</footer>` : '';
  const head = r() < 0.5 ? `<header>\n<h1>${title()}</h1>\n</header>` : `<h1>${title()}</h1>`;
  const art = r() < 0.3 ? `\n<figure>\n<picture>\n<source srcset="https://example.org/${pick(WORDS)}.webp" type="image/webp">\n<img src="https://example.org/${pick(WORDS)}.png" alt="${title()}" width="640" height="480">\n</picture>\n</figure>` : '';
  return `<main lang="en">\n${head}${art}\n${sections.join('\n')}${footer}\n</main>\n`;
}

test('any valid content page built in plain passes every page rule', () => {
  const r = rng(20261126);
  for (let i = 0; i < 300; i++) {
    const content = generate(r);
    const own = checkContentPage(content, 'gen.html', { root });
    assert.deepStrictEqual(own.findings.map((f) => `${f.rule}@${f.line} ${f.text}`), [], `case ${i} is not a valid content page:\n${content}`);
    const built = checkPage(compilePage(content), 'gen.html', { root });
    assert.deepStrictEqual(built.findings.map((f) => `${f.rule}@${f.line} ${f.text}`), [], `case ${i} built in plain:\n${content}`);
  }
});

test('the landing gate holds a new page to every rule and leaves an edited old page to the line scan', (t) => {
  const { spawnSync } = require('child_process');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-page-gate-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo, encoding: 'utf8' });
  const old = page(`<div>${PROSE}</div>`);
  git('init', '-q', '-b', 'master');
  fs.writeFileSync(path.join(repo, 'old.html'), old);
  git('add', '.'); git('commit', '-qm', 'old');
  fs.writeFileSync(path.join(repo, 'old.html'), old.replace('every week', 'each week'));
  fs.writeFileSync(path.join(repo, 'new.html'), page(`<div>${PROSE}</div>`));
  git('add', '.');
  const { candidatePolicyGate } = require('../lib/auto-accept-certified');
  const task = { workspace_root: repo, metadata: { changed_files: ['old.html', 'new.html'] } };
  // watch mode, the default: the failing new page is an advisory and the work lands
  const watched = candidatePolicyGate(task);
  assert.strictEqual(watched.ok, true, (watched.offenders || []).join(', '));
  assert.ok(watched.gate.advisories.some((a) => a.reason === 'new_page_check_watch' && a.file === 'new.html' && a.rule === 'lang-tags'));
  fs.mkdirSync(path.join(repo, '.atris'));
  fs.writeFileSync(path.join(repo, '.atris', 'slop.rules.json'), '{ "pages": "block" }\n');
  const res = candidatePolicyGate(task);
  assert.strictEqual(res.reason, 'slop_gate');
  assert.ok(res.offenders.includes('new.html:3 lang-tags'), res.offenders.join(', '));
  assert.ok(!res.offenders.some((o) => o.startsWith('old.html')), res.offenders.join(', '));
  // a rules file with a typo holds the same way: the owner's choice is unknown
  fs.writeFileSync(path.join(repo, '.atris', 'slop.rules.json'), '{ "pages": "block", }\n');
  const typo = candidatePolicyGate(task);
  assert.strictEqual(typo.reason, 'slop_gate');
  assert.ok(typo.next_action.startsWith('fix or remove .atris/slop.rules.json'), typo.next_action);
  assert.ok(typo.gate.advisories.some((a) => a.reason === 'page_rules_unreadable' && a.file === '.atris/slop.rules.json' && /could not be read/.test(a.detail)));
  fs.writeFileSync(path.join(repo, '.atris', 'slop.rules.json'), '{ "pages": "block" }\n');
  // a moved page and an ignored file in a named folder are not new pages. a stray file there is named
  git('commit', '-qm', 'new');
  git('checkout', '-qb', 'move', 'master');
  git('mv', 'old.html', 'moved.html');
  fs.mkdirSync(path.join(repo, 'docs', 'coverage'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.gitignore'), 'docs/coverage/\n');
  fs.writeFileSync(path.join(repo, 'docs', 'coverage', 'index.html'), page(`<div>${PROSE}</div>`));
  fs.writeFileSync(path.join(repo, 'docs', 'readme.md'), 'Notes for the docs.\n');
  git('add', '.');
  fs.writeFileSync(path.join(repo, 'docs', 'draft.html'), page(`<div>${PROSE}</div>`));
  const moved = candidatePolicyGate({ workspace_root: repo, metadata: { changed_files: ['moved.html', 'docs'] } });
  assert.strictEqual(moved.ok, true, (moved.offenders || []).join(', '));
  assert.deepStrictEqual(moved.gate.advisories.filter((a) => a.reason === 'new_page_untracked_skipped').map((a) => a.detail), ['docs/draft.html']);
  // a piece of a page gets the page rules, a tell both scans see is named once, and a page a script draws is named as not read
  fs.writeFileSync(path.join(repo, 'card.html'), '<p>Each student stays quiet in the room for the hour.</p>\n');
  fs.writeFileSync(path.join(repo, 'glass.html'), '<!doctype html><html lang="en"><head><style>\n.c{backdrop-filter:blur(10px)}\n</style></head><body><main><p class="c">Each student wrote a draft every week and the teacher read them.</p></main></body></html>\n');
  fs.writeFileSync(path.join(repo, 'spa.html'), '<!doctype html><html lang="en"><head><script src="app.js"></script></head><body><div id="root"></div></body></html>\n');
  fs.writeFileSync(path.join(repo, 'caps.html'), '<!doctype html><html lang="en"><head><style>\n.e{text-transform:uppercase}\n</style></head><body><main>\n<p class="e">Each student wrote a draft every week and the teacher read them.</p></main></body></html>\n');
  git('add', 'card.html', 'glass.html', 'spa.html', 'caps.html');
  const pieceTask = { workspace_root: repo, metadata: { changed_files: ['card.html', 'glass.html', 'spa.html', 'caps.html'] } };
  const piece = candidatePolicyGate(pieceTask);
  assert.deepStrictEqual(piece.offenders, ['card.html:1 page-word-quiet', 'glass.html:2 page-glass', 'caps.html:4 page-all-caps']);
  // in watch mode the line rule holds the file and the page rule that replaces it adds no second line
  fs.writeFileSync(path.join(repo, '.atris', 'slop.rules.json'), '{}\n');
  const pieceWatch = candidatePolicyGate(pieceTask);
  assert.deepStrictEqual(pieceWatch.gate.advisories.filter((a) => a.reason === 'new_page_check_watch').map((a) => `${a.file}:${a.line} ${a.rule}`), ['card.html:1 page-word-quiet']);
  fs.writeFileSync(path.join(repo, '.atris', 'slop.rules.json'), '{ "pages": "block" }\n');
  assert.ok(piece.gate.advisories.some((a) => a.reason === 'new_page_not_read' && a.file === 'spa.html' && /a script draws this page/.test(a.detail)), JSON.stringify(piece.gate.advisories));
  // with no base branch to compare against the new page check cannot run: block mode holds and says so
  git('commit', '-qm', 'move');
  git('branch', '-m', 'master', 'trunk');
  const noBase = candidatePolicyGate({ workspace_root: repo, metadata: { changed_files: ['new.html'] } });
  assert.strictEqual(noBase.reason, 'new_page_check_not_run');
  assert.ok(noBase.gate.advisories.some((a) => a.reason === 'new_page_check_not_run' && /base branch/.test(a.detail)));
  // a broken rules file with no base names the file, not a block mode it never asked for
  fs.writeFileSync(path.join(repo, '.atris', 'slop.rules.json'), '{ "off": ["page-glow"], }\n');
  const noBaseTypo = candidatePolicyGate({ workspace_root: repo, metadata: { changed_files: ['new.html'] } });
  assert.strictEqual(noBaseTypo.reason, 'new_page_check_not_run');
  assert.ok(!/blocks on pages/.test(noBaseTypo.message) && /rules file could not be read/.test(noBaseTypo.message), noBaseTypo.message);
  assert.ok(noBaseTypo.next_action.startsWith('fix or remove .atris/slop.rules.json'), noBaseTypo.next_action);
  assert.ok(noBaseTypo.gate.advisories.some((a) => a.reason === 'page_rules_unreadable'));
  fs.writeFileSync(path.join(repo, '.atris', 'slop.rules.json'), '{}\n');
  const noBaseWatch = candidatePolicyGate({ workspace_root: repo, metadata: { changed_files: ['new.html'] } });
  assert.strictEqual(noBaseWatch.ok, true);
  assert.ok(noBaseWatch.gate.advisories.some((a) => a.reason === 'new_page_check_not_run'));
});
