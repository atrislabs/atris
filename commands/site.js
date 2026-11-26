// atris site, turn a folder of markdown (docs, your wiki, memory) into a
// beautiful, navigable static site in the design system. Built on lib/site.js.
// A content page (plain html starting at <main>) is checked and built in a look (lib/page-lang.js).
// A theme colours a markdown site. A look is the owner's stylesheet for a content page.
//
//   atris site <dir|doc.md> [--out dist] [--theme atris|terminal|paper] [--title T] [--serve]
//   atris site <page.html> [--look <name>] [--out dist]
//   atris site check <file|dir> [--json] [--render]
//   atris site rules [--json]
//   atris site look | atris site look pick <name>
//   atris site publish <dir> --slug <slug> [--profile strict|app] [--spa] [--no-claim] [--build] [--json]

const fs = require('fs');
const path = require('path');
const { buildSite, serveSite } = require('../lib/site');
const { hasFlag } = require('../lib/arg-parser');

function flag(argv, name) { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : null; }
const lang = () => require('../lib/page-lang');
const shown = (file) => lang().shown(file);
const report = (...a) => lang().report(...a);

// Every site command reads .atris/slop.rules.json, the look picks and the build from the folder it
// runs in. A rules file that is there and cannot be read is named on stderr.
function rulesNote(root) {
  const problem = require('../lib/page-rules').rulesProblem(root);
  if (problem) console.error(problem);
  return problem;
}

async function check(argv) {
  const root = process.cwd();
  const target = argv.find((a) => !a.startsWith('-'));
  if (!target) { console.error('  atris site check <file|dir> [--json] [--render]'); return 2; }
  rulesNote(root);
  const list = lang().htmlFilesIn(target);
  if (!list.length) { console.error(`no html pages at ${target}`); return 2; }
  const siteRoot = fs.statSync(target).isDirectory() ? path.resolve(target) : null;
  const files = list.map((file) => ({ path: file, ...lang().checkFile(file, { root, label: shown(file), siteRoot }) }));
  if (hasFlag(argv, '--render')) {
    let renderCheck = null, why = '';
    try { ({ renderCheck } = require('../lib/page-render')); } catch (e) { why = e.message.split('\n')[0]; }
    // a page the browser could not open keeps its page rule results, rendered false and the reason
    for (const res of files) {
      const r = renderCheck ? await renderCheck(res.path, { widths: [390, 1280], root }) : null;
      if (!r || !r.ran) { res.reason = (r && r.reason) || why || 'no reason given'; continue; }
      res.findings.push(...(r.findings || []));
      res.results.push(...(r.results || []));
      res.ok = lang().mustFix(res).length === 0;
      res.rendered = true;
      // the browser read the words a script drew. the note that they were not read no longer holds.
      // when it saw no words either, the note says what the run found instead
      const drawnNote = (n) => n.startsWith('a script draws this page');
      res.notChecked = r.drewText ? res.notChecked.filter((n) => !drawnNote(n))
        : res.notChecked.map((n) => drawnNote(n) ? 'a script draws this page and the browser saw no words after the wait. its words were not read' : n);
    }
  }
  return report(files.map(({ path: _p, ...res }) => res), { json: hasFlag(argv, '--json') });
}

function rules(argv) {
  const { GRAMMAR } = lang();
  const pageRules = require('../lib/page-rules');
  const sheet = pageRules.ruleSheet();
  const root = process.cwd();
  const unread = rulesNote(root);
  const off = pageRules.switchedOff(root);
  const mode = unread ? 'unknown' : pageRules.pageMode(root);
  // the browser rules only run when the page is opened in a browser, so they are listed apart
  const browser = require('../lib/page-render').RENDER_RULES;
  if (hasFlag(argv, '--json')) {
    console.log(JSON.stringify({ grammar: GRAMMAR.map((r) => ({ id: r.id, line: r.line })), page: sheet, browser: browser.map((r) => ({ id: r.id, line: r.why, needs: '--render' })), mode, off }, null, 2));
    return 0;
  }
  // the order of work is the screens section of atris.md, the same copy every start-up file carries
  const order = require('../lib/opening-lines').screensRulesForRoot(root);
  const out = [
    ...(order ? ['order of work, from the screens section of atris.md', ...order.split('\n').map((l) => `  ${l}`), ''] : []),
    'content page',
    ...GRAMMAR.map((r) => `  ${r.id}: ${r.line}`),
    '',
    'upload check',
    '  publish checks every html page after any build. deploy checks the html pages in the folder before it uploads.',
    '  deploy --fullstack reads only the html already in the folder. pages the server builds or draws are not checked.',
    '  watch mode, the default: they print what fails and upload anyway.',
    '  block mode: they upload nothing until every page passes. the landing gate holds new pages the same way.',
    unread ? '  this project\'s mode is unknown until .atris/slop.rules.json can be read.' : `  this project is in ${mode} mode.`,
    `  ${require('../lib/page-lang').BLOCK_LINE}. atris init turns it on for a new project.`,
  ];
  if (off.length) out.push('', `switched off in .atris/slop.rules.json: ${off.join(', ')}`);
  for (const [group, list] of Object.entries(sheet)) {
    // a rule that only guesses, or the part of a rule that guesses, leaves notes and never blocks
    const mark = (r) => r.level === 'warn' ? ' (every hit is a note for the reviewer and never blocks)' : r.level === 'mixed' ? ` (part of it is a note for the reviewer and never blocks: ${r.maybe})` : '';
    out.push('', `page rules: ${group}`, ...list.map((r) => `  ${r.id}: ${r.line}${mark(r)}`));
  }
  out.push('', 'browser rules, run only with atris site check <file> --render', ...browser.map((r) => `  ${r.id}: ${r.why}`));
  console.log(out.join('\n'));
  return 0;
}

// atris site look lists the looks. atris site look pick <name> records the owner's pick.
function look(argv) {
  const root = process.cwd();
  if (argv.length) {
    const name = argv[1];
    if (argv[0] !== 'pick' || !name) { console.error('  atris site look\n  atris site look pick <name>'); return 2; }
    if (name === 'plain') { console.log('plain is built in and needs no pick.'); return 0; }
    const { useInteractiveTerminalUi } = require('../lib/computer-core');
    if (!useInteractiveTerminalUi()) { console.error('only the owner picks a look, at a terminal. no pick was recorded.'); return 1; }
    try { lang().recordPick(root, name); } catch (e) { console.error(e.message); return 2; }
    console.log(`picked ${name}. pages built in it can be published.`);
    return 0;
  }
  for (const look of lang().listLooks(root)) console.log(`${look.name}: ${look.state}`);
  return 0;
}

// A content page becomes <out>/index.html in a look, after every page rule passes.
function buildPage(input, argv) {
  const L = lang();
  const root = process.cwd();
  rulesNote(root);
  const file = path.resolve(input);
  const res = L.checkFile(file, { root, label: shown(file) });
  if (!res.ok) return report([res]);
  const look = flag(argv, '--look') || 'plain';
  let css;
  try { css = L.readLook(root, look); } catch (e) { console.error(e.message); return 2; }
  const bad = L.lookSelectorProblems(css);
  if (bad.length) {
    console.error(`refused look ${look} (${bad.length} selector${bad.length === 1 ? '' : 's'} to fix)`);
    for (const b of bad) console.error(`line ${b.line}: a class or id selector: "${b.text}". style elements and attributes only; content has no classes.`);
    return 1;
  }
  const html = L.compilePage(fs.readFileSync(file, 'utf8'), { look, lookCss: css });
  const built = require('../lib/page-rules').checkPage(html, `look ${look}`, { root });
  if (L.mustFix(built).length) return report([{ file: `${shown(file)} in look ${look}`, ok: false, findings: built.findings, off: built.off }]);
  const outDir = path.resolve(flag(argv, '--out') || 'dist');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'index.html'), html);
  console.log(`built ${shown(path.join(outDir, 'index.html'))} in look ${look}`);
  return 0;
}

function isContentFile(input) {
  if (!/\.html?$/i.test(input)) return false;
  try { return require('../lib/page-scan').parsePage(fs.readFileSync(input, 'utf8')).isContentPage; } catch { return false; }
}

async function run(argv) {
  if (argv[0] === 'publish') return require('../lib/site-publish').run(argv.slice(1));
  if (argv[0] === 'deploy') return require('./site-deploy').run(argv.slice(1));
  if (argv[0] === 'check') return check(argv.slice(1));
  if (argv[0] === 'rules') return rules(argv.slice(1));
  if (argv[0] === 'look') return look(argv.slice(1));

  const input = argv.find((a) => !a.startsWith('-'));
  if (!input || input === 'help' || hasFlag(argv, '--help')) {
    console.log(`
  atris site: build markdown sites, check and build content pages, or deploy web folders

    atris site <dir|doc.md> [--out dist] [--theme atris|terminal|paper] [--title T]
    atris site atris/wiki --title "Atris Wiki" --serve
    atris site <page.html> [--look <name>] [--out dist]
    atris site check <file|dir> [--json] [--render]
    atris site rules [--json]
    atris site look
    atris site look pick <name>
    atris site publish <dir> --slug <slug> [--profile strict|app] [--spa] [--no-claim] [--build] [--json]
    atris site deploy <dir> --name <slug> [--spa] [--dry-run] --yes
    atris site deploy <dir> --fullstack --name <slug> [--dry-run] --yes

  Each .md becomes a page; an index links them all. Same anti-slop design system,
  semantic data-atris-block sections, ready for the web app. --serve previews it.

  A content page is plain html that starts at <main>. check runs every page rule on it
  and --render adds the browser rules. rules prints them all. building it writes
  <out>/index.html in a look.
  A theme (--theme) colours a markdown site. A look (--look) is the owner's stylesheet
  for a content page and never takes a theme's name.
  Looks live at atris/looks/<name>.css. Only the owner picks one, at a terminal.

  publish uploads any built web folder through the hosted-sites api. deploy is
  the older site setup flow; --fullstack deploys a node server with render.
  publish checks every html page after any build. deploy checks the html pages in
  the folder, and --fullstack does not check pages the server builds. In watch mode,
  the default, they say what fails and upload anyway. In block mode they upload
  nothing if one fails.
  atris site rules says how to turn block mode on.
`);
    return input === 'help' || hasFlag(argv, '--help') ? 0 : 2;
  }

  if (isContentFile(input)) return buildPage(input, argv);

  let res;
  try {
    res = buildSite(input, {
      out: flag(argv, '--out') || 'dist',
      theme: flag(argv, '--theme'),
      title: flag(argv, '--title'),
      brand: flag(argv, '--brand'),
    });
  } catch (e) { console.error(`  ${e.message}`); return 2; }

  console.log(`\n  ✓ site built: ${res.pages.length} page${res.pages.length === 1 ? '' : 's'} + index -> ${res.outDir}/`);
  console.log(`    open ${res.indexPath}`);

  if (hasFlag(argv, '--serve')) {
    const port = Number(flag(argv, '--port')) || 4321;
    const { url } = await serveSite(res.outDir, port);
    console.log(`\n  serving at ${url} (ctrl-c to stop)\n`);
    await new Promise(() => {}); // keep alive until killed
  }
  return 0;
}

module.exports = { run };
