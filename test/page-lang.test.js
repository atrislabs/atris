const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkContentPage, compilePage, builtProblems, recordPick, PLAIN_CSS, lookSelectorProblems } = require('../lib/page-lang');
const { checkPage } = require('../lib/page-rules');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-page-lang-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
fs.writeFileSync(path.join(root, 'survey.csv'), 'term,drafts\n');
fs.writeFileSync(path.join(root, 'class.png'), '');

const PROSE = '<p>Each student wrote a draft every week, and the teacher read every one of them.</p>\n<p>The drafts got shorter and clearer as the term went on, and nobody wrote for them.</p>';
const page = (body, head = '<header><h1>Writing coach</h1></header>') => `<main>\n${head}\n${body}\n</main>\n`;
const rules = (text) => checkContentPage(text, 'p.html', { root }).findings.map((f) => `${f.rule}@${f.line}`);

test('a good content page passes every rule', () => {
  const good = page(`<section>\n<h2>40% more drafts</h2>\n${PROSE}\n<cite>survey.csv</cite>\n</section>\n<section>\n<h2>Ask for a seat</h2>\n<form action="/ask" method="post">\n<label for="email">Email</label>\n<input id="email" name="email" type="email" required>\n<button type="submit">Ask for a seat</button>\n<output>That email did not reach us, so please send it again.</output>\n</form>\n<img src="class.png" alt="The class at work">\n</section>\n<section>\n<h2>Sign in</h2>\n<form action="/in" method="post">\n<input type="hidden" name="csrf" value="abc123">\n<label for="pw">Password</label>\n<input id="pw" name="pw" type="password">\n<input type="submit" value="Sign in">\n<output>That password did not match, so please try again.</output>\n</form>\n</section>`);
  assert.deepStrictEqual(rules(good), []);
});

test('each grammar rule refuses its bad page at the line', () => {
  const cases = [
    ['lang-root', '<p>Before the page starts here.</p>\n' + page(PROSE), 1],
    ['lang-root', page(`<!-- a note -->\n${PROSE}`), 3],
    ['lang-tags', page(`<div>${PROSE}</div>`), 3],
    ['lang-attrs', page(`<section class="hero">\n${PROSE}\n</section>`), 3],
    ['lang-heading', page(PROSE, '<header><h1>Writing coach</h1><p>Better essays every week for your school.</p></header>'), 2],
    ['lang-heading', page(`<h1>Another title here</h1>\n${PROSE}`), 3],
    ['lang-source', page(`<section>\n<h2>40% more drafts</h2>\n${PROSE}\n<cite>missing.csv</cite>\n</section>`), 4],
    ['lang-image', page(`<section>\n${PROSE}\n<img src="nothing.png" alt="The class">\n</section>`), 6],
    ['lang-image', page(`<section>\n${PROSE}\n<img src="class.png">\n</section>`), 6],
    ['lang-form', page('<form action="/a">\n<input id="e" name="e">\n<button type="submit">Send the note</button>\n<output>That did not go through, so please send it again.</output>\n</form>'), 4],
    ['lang-form', page('<form action="/a">\n<label for="e">Email</label>\n<input id="e" name="e">\n<button type="submit">Send the note</button>\n</form>'), 3],
  ];
  for (const [id, text, line] of cases) assert.ok(rules(text).includes(`${id}@${line}`), `${id} at line ${line}: ${rules(text).join(', ')}`);
});

test('a built page must still be what was built, in plain or a picked look', () => {
  const content = page(PROSE);
  const plain = compilePage(content);
  assert.deepStrictEqual(builtProblems(plain, root), []);
  assert.strictEqual(builtProblems(plain.replace('every week', 'each week'), root)[0].rule, 'built-edited');
  assert.strictEqual(builtProblems(plain.replace('<style>', '<style>p{color:#333}'), root)[0].rule, 'built-edited');
  fs.mkdirSync(path.join(root, 'atris', 'looks'), { recursive: true });
  const css = 'body{font-family:Georgia,serif}';
  fs.writeFileSync(path.join(root, 'atris', 'looks', 'paper.css'), css);
  const paper = compilePage(content, { look: 'paper', lookCss: css });
  assert.strictEqual(builtProblems(paper, root)[0].rule, 'built-look-unpicked');
  recordPick(root, 'paper');
  assert.deepStrictEqual(builtProblems(paper, root), []);
  fs.writeFileSync(path.join(root, 'atris', 'looks', 'paper.css'), `${css}h1{font-size:3em}`);
  recordPick(root, 'paper');
  assert.strictEqual(builtProblems(paper, root)[0].rule, 'built-look-unpicked');
  assert.deepStrictEqual(lookSelectorProblems('main > h1, a[href^="http"], p:first-child{x:y}'), []);
  assert.strictEqual(lookSelectorProblems('.hero{x:y}\n#top{x:y}').length, 2);
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
    const kind = pick(['prose', 'table', 'form', 'list', 'stat']);
    if (kind === 'prose') sections.push(`<section>\n<h2>${title()}</h2>\n${para()}\n${para()}\n</section>`);
    if (kind === 'stat') sections.push(`<section>\n<h2>${1 + Math.floor(r() * 90)}% more ${pick(WORDS)}s</h2>\n${para()}\n${para()}\n<cite>https://example.org/${pick(WORDS)}</cite>\n</section>`);
    if (kind === 'table') {
      const rows = Array.from({ length: Math.floor(r() * 5) }, () => `<tr><th>${title()}</th><td>${Math.floor(r() * 99999).toLocaleString('en-US')}</td></tr>`).join('\n');
      sections.push(`<section>\n<h2>${title()}</h2>\n<table>\n<caption>${title()}</caption>\n<thead><tr><th>${pick(WORDS)}</th><th>${pick(WORDS)}</th></tr></thead>\n<tbody>\n${rows}\n</tbody>\n</table>\n<cite>https://example.org/data</cite>\n</section>`);
    }
    if (kind === 'list') {
      const items = Array.from({ length: Math.floor(r() * 4) }, () => `<li>${sentence()}</li>`).join('\n');
      const tag = pick(['ul', 'ol']);
      sections.push(`<section>\n<h2>${title()}</h2>\n${para()}\n${para()}\n<${tag}>\n${items}\n</${tag}>\n</section>`);
    }
    if (kind === 'form') {
      const id = `f${s}`;
      const field = pick([`<input id="${id}" name="${id}" type="text" required>`, `<textarea id="${id}" name="${id}"></textarea>`, `<select id="${id}" name="${id}"><option value="a">${title()}</option></select>`]);
      sections.push(`<section>\n<h2>${title()}</h2>\n<form action="/send" method="post">\n<label for="${id}">${title()}</label>\n${field}\n<button type="submit">${title()}</button>\n<output>${sentence()}</output>\n</form>\n</section>`);
    }
  }
  const footer = r() < 0.5 ? `\n<footer>\n${para()}\n${para()}\n</footer>` : '';
  return `<main>\n<header>\n<h1>${title()}</h1>\n</header>\n${sections.join('\n')}${footer}\n</main>\n`;
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
  assert.deepStrictEqual(lookSelectorProblems(PLAIN_CSS), []);
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
  const res = candidatePolicyGate({ workspace_root: repo, metadata: { changed_files: ['old.html', 'new.html'] } });
  assert.strictEqual(res.reason, 'slop_gate');
  assert.ok(res.offenders.includes('new.html:3 lang-tags'), res.offenders.join(', '));
  assert.ok(!res.offenders.some((o) => o.startsWith('old.html')), res.offenders.join(', '));
});
