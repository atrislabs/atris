const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanFile, detect, RULES, applyFixes } = require('../commands/slop');
// Slop samples live in a data file the scanner skips, so this file itself scans clean.
const FX = require('./fixtures/slop-samples.json');

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

test('rules are well-formed (id, severity, regex, why)', () => {
  for (const r of RULES) {
    assert.ok(r.id && typeof r.id === 'string');
    assert.ok(['error', 'warn'].includes(r.sev));
    assert.ok(r.re instanceof RegExp);
    assert.ok(r.why && typeof r.why === 'string');
  }
});

test('flags the canonical slop tells', () => {
  const slop = [
    FX.gradientHeadlineOpen,
    FX.hypeLine,
    '</div>',
  ].join('\n');
  const hits = scanFile(tmpFile('Slop.tsx', slop)).map((f) => f.rule);
  assert.ok(hits.includes('ai-gradient-text'), 'gradient text');
  assert.ok(hits.includes('ai-purple-gradient'), 'purple gradient');
  assert.ok(hits.includes('hype-copy'), 'hype copy');
  assert.ok(hits.includes('decorative-emoji'), 'emoji');
});

test('flags em dash as an AI-writing tell', () => {
  const hits = scanFile(tmpFile('Copy.tsx', FX.emDashCopy)).map((f) => f.rule);
  assert.ok(hits.includes('em-dash'), 'em dash');
  // a plain hyphen must NOT trip it
  assert.equal(scanFile(tmpFile('Ok.tsx', '<p>On-call, half-asleep.</p>')).length, 0);
});

test('flags the hover-lift reflex but not a subtle hover scale', () => {
  const lift = scanFile(tmpFile('Card.tsx', FX.hoverLiftCard)).map((f) => f.rule);
  assert.ok(lift.includes('hover-lift'), 'translate-y lift + big scale');
  // the blessed subtle scale (1.02-1.05) must NOT trip it
  assert.ok(!scanFile(tmpFile('Ok.tsx', '<div className="hover:scale-105">')).map((f) => f.rule).includes('hover-lift'));
  assert.ok(!scanFile(tmpFile('Ok2.tsx', '<div className="hover:scale-100">')).map((f) => f.rule).includes('hover-lift'));
});

test('flags the decorative blur blob but not a small legit blur', () => {
  const blob = scanFile(tmpFile('Hero.tsx', FX.blurBlob)).map((f) => f.rule);
  assert.ok(blob.includes('decorative-blur-blob'), 'aurora-blob background');
  // a small deliberate blur (e.g. an image placeholder) must NOT trip it
  assert.ok(!scanFile(tmpFile('Ok.css', '.thumb { filter: blur(4px); }')).map((f) => f.rule).includes('decorative-blur-blob'));
  // frosted blur is a different tell (glassmorphism), not this one
  assert.ok(!scanFile(tmpFile('Ok2.tsx', FX.backdropBlurSmall)).map((f) => f.rule).includes('decorative-blur-blob'));
});

test('clean markup produces zero findings', () => {
  const clean = [
    '<section className="rounded-lg border border-stone-200 bg-stone-50 p-12">',
    '  <h1 className="text-stone-900 font-semibold">Read your incidents in the dark</h1>',
    '</section>',
  ].join('\n');
  assert.equal(scanFile(tmpFile('Clean.tsx', clean)).length, 0);
});

test('flags the hero-kicker composite across JSX lines', () => {
  const kicker = [
    '<div className="flex items-center gap-3">',
    FX.kickerDot,
    '  <span className="font-mono text-[11px] tracking-widest text-stone-400">Natural voice</span>',
    '</div>',
  ].join('\n');
  const hits = scanFile(tmpFile('Hero.tsx', kicker));
  assert.ok(hits.some((f) => f.rule === 'hero-kicker'), 'hero-kicker pair rule');
  assert.equal(hits.find((f) => f.rule === 'hero-kicker').sev, 'error');
});

test('flags a dot char followed by an all-caps kicker label', () => {
  const hits = scanFile(tmpFile('Kicker.tsx', FX.kickerDotCaps)).map((f) => f.rule);
  assert.ok(hits.includes('kicker-dot-caps'));
  // a bullet separator with normal copy must NOT trip it
  assert.ok(!scanFile(tmpFile('Sep.tsx', '<span>2 min read ● Updated today</span>')).map((f) => f.rule).includes('kicker-dot-caps'));
  // ASCII wireframes in prose docs use ● as radio/transport glyphs: exempt
  assert.ok(!scanFile(tmpFile('idea.md', FX.boxDrawingControls)).map((f) => f.rule).includes('kicker-dot-caps'));
});

test('a lone status dot far from any label does not trip the pair rule', () => {
  const ok = [
    '<span className="h-2 w-2 rounded-full bg-stone-300" />',
    '', '', '', '', '',
    '<p className="text-sm">All systems normal</p>',
  ].join('\n');
  assert.ok(!scanFile(tmpFile('Dot.tsx', ok)).some((f) => f.rule === 'hero-kicker'));
});

test('flags the pastel icon tile but not a plain pastel card or a neutral square', () => {
  const tile = scanFile(tmpFile('Feature.tsx', FX.pastelIconTile)).map((f) => f.rule);
  assert.ok(tile.includes('pastel-icon-tile'), 'pastel rounded icon tile');
  // a large padded pastel section (no small square) must NOT trip it
  assert.ok(!scanFile(tmpFile('Ok.tsx', FX.pastelSection)).map((f) => f.rule).includes('pastel-icon-tile'));
  // a neutral (non-pastel) rounded square avatar must NOT trip it
  assert.ok(!scanFile(tmpFile('Ok2.tsx', '<div className="h-12 w-12 rounded-full bg-stone-200" />')).map((f) => f.rule).includes('pastel-icon-tile'));
});

test('flags the dark premium hero gradient but not a colorful or solid-dark one', () => {
  const dark = scanFile(tmpFile('Hero.tsx', FX.darkHeroGradient)).map((f) => f.rule);
  assert.ok(dark.includes('dark-hero-gradient'), 'near-black slate-to-black gradient');
  // a solid dark background (no gradient stops) must NOT trip it
  assert.ok(!scanFile(tmpFile('Ok.tsx', '<section className="bg-black text-white">')).map((f) => f.rule).includes('dark-hero-gradient'));
  // a dark gradient that stays mid-tone (not fading to black/950) must NOT trip it
  assert.ok(!scanFile(tmpFile('Ok2.tsx', '<section className="bg-gradient-to-b from-slate-900 to-slate-700">')).map((f) => f.rule).includes('dark-hero-gradient'));
});

test('flags a colored glow shadow but not a neutral or sizeonly shadow', () => {
  const glow = scanFile(tmpFile('Cta.tsx', FX.glowShadowButton)).map((f) => f.rule);
  assert.ok(glow.includes('colored-glow-shadow'), 'tinted neon glow shadow');
  // a plain sized shadow with no color must NOT trip it
  assert.ok(!scanFile(tmpFile('Ok.tsx', '<div className="shadow-lg" />')).map((f) => f.rule).includes('colored-glow-shadow'));
  // a neutral-tinted shadow (stone/gray) must NOT trip it
  assert.ok(!scanFile(tmpFile('Ok2.tsx', '<div className="shadow-stone-200" />')).map((f) => f.rule).includes('colored-glow-shadow'));
});

test('flags a cross-hue rainbow gradient but not a monochrome or neutral one', () => {
  const rainbow = scanFile(tmpFile('Cta.tsx', FX.rainbowButton)).map((f) => f.rule);
  assert.ok(rainbow.includes('rainbow-gradient'), 'pink-to-orange cross-hue gradient');
  // a same-family monochrome gradient (blue to blue) must NOT trip it
  assert.ok(!scanFile(tmpFile('Ok.tsx', '<div className="bg-gradient-to-r from-blue-500 to-blue-700" />')).map((f) => f.rule).includes('rainbow-gradient'));
  // a subtle neutral light gradient (shade 50, out of the saturated range) must NOT trip it
  assert.ok(!scanFile(tmpFile('Ok2.tsx', '<div className="bg-gradient-to-b from-gray-50 to-white" />')).map((f) => f.rule).includes('rainbow-gradient'));
});

test('flags an svg noise-grain overlay but not plain markup', () => {
  const grain = scanFile(tmpFile('Grain.tsx', FX.grainFilter)).map((f) => f.rule);
  assert.ok(grain.includes('noise-grain-overlay'), 'svg turbulence grain texture');
  // ordinary markup with no turbulence filter must NOT trip it
  assert.ok(!scanFile(tmpFile('Ok.tsx', '<div className="bg-white p-8">clean</div>')).map((f) => f.rule).includes('noise-grain-overlay'));
});

test('findings carry file:line + rule id for the verification gate', () => {
  const f = scanFile(tmpFile('X.css', FX.glassCss))[0];
  assert.equal(f.line, 3);
  assert.equal(f.rule, 'glassmorphism');
  assert.ok(f.file.endsWith('X.css'));
});

// --- atris slop dead: require-graph dead-code detection ------------------------

const { findDeadCode } = require('../commands/slop');

function fixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-dead-'));
  const w = (rel, content) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return p;
  };
  w('package.json', JSON.stringify({ name: 'fx', bin: { fx: 'bin/fx.js' } }));
  w('bin/fx.js', "const { live } = require('../cmds/live.js'); require('../cmds/uses-loader.js'); live();");
  w('cmds/live.js', "const h = require('../lib/helper'); module.exports = { live: () => h() };");
  w('lib/helper.js', 'module.exports = () => 1;');
  w('cmds/orphan.js', 'module.exports = () => "nobody requires me";'); // dead
  w('lib/lonely.js', 'module.exports = () => "only a test imports me";');
  w('test/lonely.test.js', "require('../lib/lonely');");
  // dynamic dispatch: named as a string, never statically required
  w('cmds/dynamic.js', 'module.exports = () => "loaded by name";');
  w('lib/loader.js', "const n = 'dynamic'; module.exports = () => require('../cmds/' + n);");
  w('cmds/uses-loader.js', "require('../lib/loader');");
  return root;
}

test('slop dead: finds the unreachable file, spares live/test-only/dynamic ones', () => {
  const root = fixtureRepo();
  const r = findDeadCode(root, { dirs: ['cmds', 'lib'] });
  const rel = (f) => path.relative(root, f);
  assert.deepEqual(r.dead.map(rel), ['cmds/orphan.js'], 'only the true orphan is dead');
  assert.deepEqual(r.testOnly.map(rel), ['lib/lonely.js'], 'test-only file is flagged separately');
  // dynamic.js is unreachable statically but string-mentioned, so it must NOT be dead
  assert.ok(!r.dead.map(rel).includes('cmds/dynamic.js'), 'string-mention safety net holds');
  assert.ok(r.candidates >= 6);
});

test('slop dead: a bin using require(path.join(...)) plus a test import is not test-only', () => {
  // Regression: `ax` reaches lib/permission-grants.js only via a computed
  // require(path.join(__dirname, 'lib', 'permission-grants.js')) that the static
  // edge parser can't follow, while a test imports it statically. The prod
  // string-mention must outrank the test-only classification.
  const root = fixtureRepo();
  const w = (rel, content) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  w('lib/grants.js', 'module.exports = { matchGrant: () => null };');
  w('bin/fx.js', "const { live } = require('../cmds/live.js'); require('../cmds/uses-loader.js');"
    + " const path = require('path'); const g = require(path.join(__dirname, '..', 'lib', 'grants.js'));"
    + ' live(); g.matchGrant();');
  w('test/grants.test.js', "require('../lib/grants');");
  const r = findDeadCode(root, { dirs: ['cmds', 'lib'] });
  const rel = (f) => path.relative(root, f);
  assert.ok(!r.testOnly.map(rel).includes('lib/grants.js'), 'prod computed-require rescues it from test-only');
  assert.ok(!r.dead.map(rel).includes('lib/grants.js'), 'and it is not dead');
  // the genuinely test-only file is still flagged
  assert.ok(r.testOnly.map(rel).includes('lib/lonely.js'), 'true test-only file still flagged');
});

test('slop dead: clean repo reports zero dead', () => {
  const root = fixtureRepo();
  fs.rmSync(path.join(root, 'cmds/orphan.js'));
  const r = findDeadCode(root, { dirs: ['cmds', 'lib'] });
  assert.equal(r.dead.length, 0);
});

test('slop dead: empty/missing dirs do not throw', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-dead-empty-'));
  const r = findDeadCode(root, { dirs: ['cmds', 'lib'] });
  assert.equal(r.candidates, 0);
  assert.deepEqual(r.dead, []);
});

test('slop dead --exports: flags an export nothing names, spares used and short ones', () => {
  const root = fixtureRepo();
  const w = (rel, content) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  // helper exports: usedFn (imported by live.js via destructure name below), orphanFn (nobody), run (too short)
  w('lib/helper.js', [
    'function usedHelperFn() { return 1; }',
    'function orphanHelperFn() { return 2; }',
    'function run() { return 3; }',
    'module.exports = {',
    '  usedHelperFn,',
    '  orphanHelperFn,',
    '  run,',
    '};',
  ].join('\n'));
  w('cmds/live.js', "const { usedHelperFn } = require('../lib/helper'); module.exports = { live: () => usedHelperFn() };");
  const { findOrphanedExports } = require('../commands/slop');
  const files = [path.join(root, 'lib/helper.js')];
  const all = [];
  (function walkAll(d) { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); const st = fs.statSync(p); if (st.isDirectory()) walkAll(p); else if (p.endsWith('.js')) all.push(p); } })(root);
  const orphans = findOrphanedExports(root, files, all).map((o) => o.name);
  assert.deepEqual(orphans, ['orphanHelperFn'], 'only the truly unnamed export flags');
});

test('slop --help and -h print usage and exit 0 instead of scanning', () => {
  const { slopCommand } = require('../commands/slop');
  for (const flag of ['--help', '-h']) {
    const lines = [];
    const orig = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    let code;
    try { code = slopCommand([flag]); } finally { console.log = orig; }
    const out = lines.join('\n');
    assert.equal(code, 0, `${flag} exits 0`);
    assert.match(out, /atris slop, deterministic slop detector/, `${flag} prints usage`);
    assert.doesNotMatch(out, /em-dash|⚠/, `${flag} does not run a scan`);
  }
});

test('detect scans every path, not just the first', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-detect-multi-'));
  const clean = path.join(dir, 'clean.tsx');
  const bad = path.join(dir, 'bad.tsx');
  fs.writeFileSync(clean, '<div className="bg-stone-50 p-4">clean</div>\n');
  fs.writeFileSync(bad, FX.gradientHeadlineLine);
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  let code;
  try { code = detect([clean, bad, '--json']); } finally { console.log = orig; }
  const out = lines.join('\n');
  assert.equal(code, 1, 'second path is scanned so slop is found');
  const result = JSON.parse(out);
  assert.equal(result.scanned, 2, 'both files scanned');
  assert.ok(result.slop >= 1, 'at least one slop tell found');
  assert.ok(result.findings.some((f) => f.file.endsWith('bad.tsx')), 'finding is from the second file');
});

test('a self-scan skips the rule tables but still checks the rest of the scanner', () => {
  const self = path.join(__dirname, '..', 'commands', 'slop.js');
  assert.deepEqual(scanFile(self), [], 'the rule tables do not flag themselves');
  // a copy elsewhere is a different file, so its tables are scanned like any code
  const copy = tmpFile('slop.js', fs.readFileSync(self, 'utf8'));
  assert.ok(scanFile(copy).length > 0, 'the skip is tied to the scanner file, not its name');
  // a rule that matches every line shows what the self-scan skips: only the
  // two tables and lines marked to ignore, so a dash anywhere else is caught
  const lines = fs.readFileSync(self, 'utf8').split('\n');
  const tables = new Set();
  let inside = false;
  lines.forEach((line, i) => {
    if (/^const (?:RULES|PAIR_RULES) = \[/.test(line)) inside = true;
    if (line.includes('slop-ignore-next-line')) tables.add(i + 1);
    else if (line.includes('slop-ignore')) tables.add(i);
    if (inside) tables.add(i);
    if (inside && /^\];/.test(line)) inside = false;
  });
  const seen = new Set(scanFile(self, [{ id: 'any', sev: 'warn', re: /^/ }], []).map((f) => f.line - 1));
  assert.ok(tables.size > 50 && tables.size < lines.length / 4, 'both tables are found and stay a small part of the file');
  lines.forEach((line, i) => assert.equal(seen.has(i), !tables.has(i), `line ${i + 1} is ${tables.has(i) ? 'skipped' : 'scanned'}`));
});

test('the em dash fix turns a paired aside into parentheses and a lone dash into a comma', () => {
  const { applyFixes } = require('../commands/slop');
  const D = '\u2014';
  const file = tmpFile('copy.md', [
    `The gate ${D} the one CI runs ${D} blocks it.`,
    `Fast, reliable ${D} and calm.`,
    `word${D}aside${D}word`,
    `ends with an aside ${D} like this ${D}.`,
  ].join('\n'));
  applyFixes([file], RULES);
  assert.deepEqual(fs.readFileSync(file, 'utf8').split('\n'), [
    'The gate (the one CI runs) blocks it.',
    'Fast, reliable, and calm.',
    'word (aside) word',
    'ends with an aside (like this).',
  ]);
});

test('the em dash fix gives a short list label a colon and leaves long list sentences alone', () => {
  const { applyFixes } = require('../commands/slop');
  const D = '\u2014';
  const file = tmpFile('list.md', [
    `- **Name** ${D} what it does`,
    `  * plain words over jargon ${D} say the thing`,
    `1. Boot ${D} read the map`,
    `- **Name** ${D} does a thing ${D} mostly`,
    `- a long sentence that keeps going and going well past sixty characters ${D} then a dash`,
    `Name ${D} not a list line`,
  ].join('\n'));
  applyFixes([file], RULES);
  assert.deepEqual(fs.readFileSync(file, 'utf8').split('\n'), [
    '- **Name**: what it does',
    '  * plain words over jargon: say the thing',
    '1. Boot: read the map',
    '- **Name**: does a thing, mostly',
    '- a long sentence that keeps going and going well past sixty characters, then a dash',
    'Name, not a list line',
  ]);
});

test('the em dash fix keeps punctuation already beside a dash instead of doubling it', () => {
  const { applyFixes } = require('../commands/slop');
  const D = '\u2014';
  const file = tmpFile('punct.md', [
    `first, ${D} then`,
    `done; ${D} next`,
    `word ${D}, more`,
    `ends ${D}.`,
    `wraps to the next line ${D}`,
    'and keeps going.',
  ].join('\n'));
  applyFixes([file], RULES);
  assert.deepEqual(fs.readFileSync(file, 'utf8').split('\n'), [
    'first, then',
    'done; next',
    'word, more',
    'ends.',
    'wraps to the next line,',
    'and keeps going.',
  ]);
});

test('a fix run prints each changed line before and after, and quiet mode stays one line', () => {
  const D = '\u2014';
  const run = (argv) => {
    const lines = [];
    const orig = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    let code;
    try { code = detect(argv); } finally { console.log = orig; }
    return { code, out: lines.join('\n') };
  };
  const body = ['# Notes', `We checked it, ${D} and it held.`, 'nothing to fix here', ''].join('\n');
  const file = tmpFile('note.md', body);
  const { code, out } = run([file, '--fix']);
  assert.equal(code, 0, 'clean after the fix');
  assert.match(out, /note\.md:2\n\s+before  We checked it, \u2014 and it held\.\n\s+after   We checked it, and it held\./);
  assert.doesNotMatch(out, /nothing to fix here/, 'untouched lines are not listed');

  const quiet = run([tmpFile('note.md', body), '--fix', '--quiet']);
  assert.doesNotMatch(quiet.out, /before|after/, 'quiet mode skips the line list');
});

test('the machine output of a fix run lists each changed line before and after', () => {
  const D = '\u2014';
  const file = tmpFile('note.md', ['# Notes', `We checked it, ${D} and it held.`, 'nothing to fix here', ''].join('\n'));
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  let code;
  try { code = detect([file, '--fix', '--json']); } finally { console.log = orig; }
  const result = JSON.parse(lines.join('\n'));
  assert.equal(code, 0);
  assert.equal(result.fixed, 1);
  assert.equal(result.changes.length, 1, 'only the edited line is listed');
  const [c] = result.changes;
  assert.ok(c.file.endsWith('note.md') && !path.isAbsolute(c.file), 'file is relative like findings');
  assert.equal(c.line, 2);
  assert.equal(c.before, `We checked it, ${D} and it held.`);
  assert.equal(c.after, 'We checked it, and it held.');
  // a scan without the fix flag still carries the field, empty
  lines.length = 0;
  console.log = (...a) => lines.push(a.join(' '));
  try { detect([file, '--json']); } finally { console.log = orig; }
  assert.deepEqual(JSON.parse(lines.join('\n')).changes, []);
});

test('in markdown the dash rule leaves inline code and fenced blocks alone', () => {
  const { applyFixes } = require('../commands/slop');
  const D = '\u2014';
  const body = [
    `Run \`grep ${D} x\` here ${D} then stop.`,
    `- \`--fix\` ${D} repairs dashes`,
    '```',
    `echo ${D}`,
    '```',
    '~~~',
    `printf "a ${D} b"`,
    '~~~',
    `The gate ${D} the one CI runs ${D} **blocks** it.`,
  ].join('\n');
  const file = tmpFile('doc.md', body);
  assert.deepEqual(scanFile(file).map((f) => f.line), [1, 2, 9], 'code lines are not flagged');
  applyFixes([file], RULES);
  assert.deepEqual(fs.readFileSync(file, 'utf8').split('\n'), [
    `Run \`grep ${D} x\` here, then stop.`,
    '- `--fix`: repairs dashes',
    '```',
    `echo ${D}`,
    '```',
    '~~~',
    `printf "a ${D} b"`,
    '~~~',
    'The gate (the one CI runs) **blocks** it.',
  ]);
  assert.deepEqual(scanFile(file), [], 'clean once the prose is fixed');
  // backticks mean nothing in plain text, so every dash there still counts
  assert.equal(scanFile(tmpFile('doc.txt', body)).length, 5);
});

test('each fix is named by the shape it took, and the preview groups them by kind', () => {
  const { applyFixes } = require('../commands/slop');
  const D = '\u2014';
  const body = [
    `The gate ${D} the one CI runs ${D} blocks it.`,
    `## Setup ${D} first run`,
    `We checked it ${D} and it held.`,
    `It ran fine ${D}`,
    '',
    `Pages 10${D}12 cover it.`,
    `It works ${D} and the gate ${D} the strict one ${D} still holds.`,
    `${D} a dash that opens the line`,
    `We tried twice ${D} and it held.`,
    `The tool is fast ${D} the build is green.`,
  ].join('\n');
  const file = tmpFile('kinds.md', body);
  const { changes } = applyFixes([file], RULES, { write: false });
  assert.deepEqual(changes.map((c) => c.kind), [
    'parentheses', 'colon', 'comma', 'period', 'hyphen', 'parentheses + comma', 'dropped', 'comma', 'semicolon',
  ]);
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { detect([file, '--dry-run']); } finally { console.log = orig; }
  const out = lines.join('\n');
  assert.match(out, /by kind: comma 2, parentheses 1, colon 1, period 1, hyphen 1, parentheses \+ comma 1, dropped 1, semicolon 1/);
  // the two comma fixes sit together under their own heading, biggest group first
  assert.match(out, /comma \(2\)\n\n\s+\S+kinds\.md:3\n.*\n.*\n\n\s+\S+kinds\.md:9\n/);
  assert.ok(out.indexOf('comma (2)') < out.indexOf('parentheses (1)'), 'biggest group comes first');
  assert.equal(fs.readFileSync(file, 'utf8'), body, 'a dry run writes nothing');
});

test('a dry run shows what the fix would change and leaves the file alone', () => {
  const D = '\u2014';
  const body = ['# Notes', `We checked it, ${D} and it held.`, ''].join('\n');
  const file = tmpFile('note.md', body);
  const run = (argv) => {
    const lines = [];
    const orig = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    let code;
    try { code = detect(argv); } finally { console.log = orig; }
    return { code, out: lines.join('\n') };
  };
  const { code, out } = run([file, '--dry-run']);
  assert.equal(code, 1, 'the slop is still there, so the gate still fails');
  assert.match(out, /would fix 1 tell/);
  assert.match(out, /after   We checked it, and it held\./);
  assert.equal(fs.readFileSync(file, 'utf8'), body, 'nothing written');

  const json = JSON.parse(run([file, '--dry-run', '--json']).out);
  assert.equal(json.dryRun, true);
  assert.equal(json.changes.length, 1);
  assert.equal(json.slop, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), body, 'nothing written in machine mode either');
});

test('machine output through a pipe arrives whole, past the 64 KB pipe buffer', () => {
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-pipe-'));
  const lines = Array.from({ length: 1500 }, (_, i) => `line ${i} keeps going \u2014 and on`);
  fs.writeFileSync(path.join(dir, 'big.md'), lines.join('\n') + '\n');
  const bin = path.join(__dirname, '..', 'bin', 'atris.js');
  const r = spawnSync(process.execPath, [bin, 'slop', 'detect', dir, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 1, 'slop found still exits 1');
  assert.ok(r.stdout.length > 65536, `output should pass one pipe buffer, got ${r.stdout.length} bytes`);
  const json = JSON.parse(r.stdout);
  assert.equal(json.slop, 1500);
});

test('fix turns a dash between two numbers into a hyphen, keeping the range', () => {
  const file = tmpFile('ranges.md', [
    'We ran it 2020\u20142024 and it held.',
    '- pages 10 \u2014 20 cover setup',
    'Shipped 3 \u2014 the rest wait.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'We ran it 2020-2024 and it held.',
    '- pages 10-20 cover setup',
    'Shipped 3, the rest wait.',
  ]);
});

test('fix does not join a number to a date or a hyphenated word as a range', () => {
  // from a validator log heading and the math harvest reports
  const file = tmpFile('not-ranges.md', [
    '### Tick 1 \u2014 2026-04-15',
    'Class 1 \u2014 8-regular graphs on n=14',
    'pages 10\u201420 and 30 \u2014 40.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '### Tick 1: 2026-04-15',
    'Class 1: 8-regular graphs on n=14',
    'pages 10-20 and 30-40.',
  ]);
});

test('fix drops a dash that opens a line instead of leaving a leading comma', () => {
  const file = tmpFile('attribution.md', [
    '\u2014 Keshav, on the first run',
    '> \u2014 a quoted attribution',
    '  \u2014indented and tight',
    'Mid-line stays a comma \u2014 like this.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'Keshav, on the first run',
    '> a quoted attribution',
    '  indented and tight',
    'Mid-line stays a comma, like this.',
  ]);
});

test('fix moves the mark of a dash that opens a wrapped line to the line above', () => {
  // dropping the dash fused two sentences: "checks below" then "these are
  // the reward"; a credit or a line above that already ends keeps the drop
  const file = tmpFile('wrapped.md', [
    'The judge only ranks pairs of emails',
    '\u2014 so the ranking clears the noise floor.',
    '',
    'Run the specific checks below',
    '   \u2014 these are the actual reward function.',
    '',
    '"Read this book and change your odds."',
    '\u2014 Garry Tan, president of Y Combinator',
    '',
    'Thanks for the intro',
    '\u2014 Sanketh',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES, { write: false });
  assert.deepEqual(changes.map((c) => [c.line, c.after]), [
    [1, 'The judge only ranks pairs of emails,'],
    [2, 'so the ranking clears the noise floor.'],
    [4, 'Run the specific checks below;'],
    [5, '   these are the actual reward function.'],
    [8, 'Garry Tan, president of Y Combinator'],
    [11, 'Sanketh'],
  ]);
  // both lines of a moved mark share one kind, so the report keeps them together
  assert.deepEqual(changes.map((c) => c.kind), ['comma moved up', 'comma moved up', 'semicolon moved up', 'semicolon moved up', 'dropped', 'dropped']);
});

test('fix treats dashes in a row as one dash, never a comma run', () => {
  const file = tmpFile('doubled.md', [
    'He said \u2014\u2014 nothing at all.',
    'Wait \u2014 \u2014 \u2014 what?',
    '\u2014\u2014 the old attribution',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'He said, nothing at all.',
    'Wait, what?',
    'the old attribution',
  ]);
});

test('fix puts a comma against a closing quote with no stray space', () => {
  const file = tmpFile('quotes.md', [
    '"Hold on \u2014" she said.',
    '\u201cWait\u2014\u201d he said.',
    'He said \u2014 "go" and left.',
    "It was 'nearly done\u2014' by then.",
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '"Hold on," she said.',
    '\u201cWait,\u201d he said.',
    'He said, "go" and left.',
    "It was 'nearly done,' by then.",
  ]);
});

test('fix keeps an aside that already has parentheses in one pair', () => {
  const file = tmpFile('parens.md', [
    'It works \u2014 (mostly) \u2014 fine.',
    'Pick one \u2014 (a) or (b) \u2014 then go.',
    'The tool \u2014 which we built \u2014 now ships.',
    // shape from this repo's weight-optimize README
    'ASI is **scale** \u2014 model size, data, compute \u2014 which is a bet.',
    'It held \u2014 mostly \u2014 although slowly.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'It works (mostly) fine.',
    'Pick one, (a) or (b), then go.',
    'The tool (which we built) now ships.',
    'ASI is **scale** (model size, data, compute), which is a bet.',
    'It held (mostly), although slowly.',
  ]);
});

test('fix gives a bold label that opens a line a colon, like a list label', () => {
  // shapes from this repo's skill and feature docs
  const file = tmpFile('bold.md', [
    '**Beliefs** \u2014 3-5 convictions. Not rules \u2014 things held true.',
    '> **For Executor Agent** \u2014 Follow these steps exactly.',
    '__Values__ \u2014 ordered by priority.',
    'The **gate** \u2014 the one CI runs \u2014 blocks it.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '**Beliefs**: 3-5 convictions. Not rules, things held true.',
    '> **For Executor Agent**: Follow these steps exactly.',
    '__Values__: ordered by priority.',
    'The **gate** (the one CI runs) blocks it.',
  ]);
});

test('fix gives a second code or bold label in a list line a colon, like the first', () => {
  // sfhq's map came out "`confidenceFloor`: line 21, `isConfident`, line 22"
  const file = tmpFile('fields.md', [
    '- `confidenceFloor` \u2014 line 21, `isConfident` \u2014 line 22',
    '- **Board** \u2014 tab 0; **Guides** \u2014 tab 1',
    // a dash before a joining word goes on with the sentence
    '- `fix` \u2014 runs it, `slow` \u2014 and the old one waits',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '- `confidenceFloor`: line 21, `isConfident`: line 22',
    '- **Board**: tab 0; **Guides**: tab 1',
    '- `fix`: runs it, `slow`, and the old one waits',
  ]);
});

test('fix keeps a label that ends in its own punctuation and adds no colon', () => {
  // the question list in the design policy came out as a question mark then a colon
  const file = tmpFile('punct-label.md', [
    '1. **what is it?** \u2014 clear product description',
    '**Note:** \u2014 read this first.',
    '- **Done.** \u2014 shipped',
    '- **Name** \u2014 what it does',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '1. **what is it?** clear product description',
    '**Note:** read this first.',
    '- **Done.** Shipped',
    '- **Name**: what it does',
  ]);
});

test('fix gives a two-word name in a code comment a colon before an order', () => {
  // from the API client, where "// Hard deadline" took a semicolon
  const file = tmpFile('comment-name.js', [
    '    // Hard deadline \u2014 kill request after 2x the timeout regardless of activity',
    '// Retry budget \u2014 stop after three tries',
    // a lowercase comment may carry on the line above
    '    // slow path \u2014 run it again later',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '    // Hard deadline: kill request after 2x the timeout regardless of activity',
    '// Retry budget: stop after three tries',
    '    // slow path; run it again later',
  ]);
});

test('fix keeps a lone letter before a hyphen lowercase when it starts a sentence', () => {
  // from a vision summary, where "k-anonymous" came out "K-anonymous"
  const file = tmpFile('letter-term.md', [
    '7. **Patterns, not data.** \u2014 k-anonymous, example pattern',
    'It clusters. \u2014 k-means works fine here.',
    'He said "it held." \u2014 x-axis shows time.',
    'It held. **What now?** \u2014 n-gram counts next.',
    // a plain word still takes its capital
    'It held. \u2014 a-ha, it works.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '7. **Patterns, not data.** k-anonymous, example pattern',
    'It clusters. k-means works fine here.',
    'He said "it held." x-axis shows time.',
    'It held. **What now?** n-gram counts next.',
    'It held. A-ha, it works.',
  ]);
});

test('fix stacks no semicolon on a question that ends inside italics or bold', () => {
  // from podcast notes, where a full clause after the question took "?*;"
  const file = tmpFile('emphasis-stop-clause.md', [
    '- Prompt to find a secret: *What valuable company is nobody building?* \u2014 every correct answer is necessarily a secret',
    'It held. **Did it?** \u2014 the gate says yes.',
    'See Yang **et al.** \u2014 they found it',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '- Prompt to find a secret: *What valuable company is nobody building?* Every correct answer is necessarily a secret',
    'It held. **Did it?** The gate says yes.',
    'See Yang **et al.**, they found it',
  ]);
});

test('fix starts the next sentence with a capital after a bold or italic stop', () => {
  // a pitch FAQ wrote each question in bold, a dash, then a lowercase answer
  const file = tmpFile('bold-stop.md', [
    '- **Why now?** \u2014 the market moved',
    '**Is it safe?** \u2014 yes, mostly.',
    '*Really?* \u2014 nobody reads it.',
    'Done. **What now?** \u2014 the next step waits.',
    // a short form ends no sentence, and a lowercase line stays lowercase
    '- **Acme Inc.** \u2014 makes boxes',
    '1. **why now?** \u2014 the market moved',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '- **Why now?** The market moved',
    '**Is it safe?** Yes, mostly.',
    '*Really?* Nobody reads it.',
    'Done. **What now?** The next step waits.',
    '- **Acme Inc.** makes boxes',
    '1. **why now?** the market moved',
  ]);
});

test('fix gives a code span that opens a line a colon, in markdown and plain text', () => {
  // build notes write a command, a dash, then what it showed
  const md = tmpFile('notes.md', [
    '`node --test test/x.test.js` \u2014 9 tests, all green.',
    'Run `atris slop detect` \u2014 it reports the tells.',
  ].join('\n'));
  const txt = tmpFile('notes.txt', '`npm test` \u2014 clean.');
  const { changes } = applyFixes([md, txt], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '`node --test test/x.test.js`: 9 tests, all green.',
    'Run `atris slop detect`; it reports the tells.',
    '`npm test`: clean.',
  ]);
});

test('fix gives a heading title and subtitle a colon, but not before a joining word', () => {
  // shapes from this repo's feature, policy, and member docs
  const file = tmpFile('headings.md', [
    '# Audit Gaps \u2014 Build Plan',
    '### Track A \u2014 `atris-cli`',
    '## What this is \u2014 and is not',
    '## Status: COMPLETE \u2014 both classes exhausted',
    'A plain line \u2014 not a heading',
    // a last dash before a joining word goes on with the subtitle
    '## Setup \u2014 install it \u2014 then run it',
    '## Audit \u2014 the gaps \u2014 and the plan',
    '## Plan \u2014 a \u2014 b \u2014 then c',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '# Audit Gaps: Build Plan',
    '### Track A: `atris-cli`',
    '## What this is, and is not',
    '## Status: COMPLETE, both classes exhausted',
    'A plain line, not a heading',
    '## Setup: install it, then run it',
    '## Audit: the gaps, and the plan',
    '## Plan, a, b, then c',
  ]);
});

test('fix gives a bold phrase that opens a sentence partway through a line a colon', () => {
  // from the endgame skill and a numbered setup step in this repo
  const file = tmpFile('mid-label.md', [
    '2. **Path**: Chain backward, etc. **Include eliminate steps** \u2014 what gets deleted.',
    'Review it. **Always re-run the checks** \u2014 the sandbox gives false failures.',
    'We ran it **twice** \u2014 and it held.',
    'It held. **What now?** \u2014 we ship.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '2. **Path**: Chain backward, etc. **Include eliminate steps**: what gets deleted.',
    'Review it. **Always re-run the checks**: the sandbox gives false failures.',
    'We ran it **twice**, and it held.',
    'It held. **What now?** We ship.',
  ]);
});

test('fix gives an aside already inside parentheses commas, so none nest', () => {
  // from this repo's feature notes, where the fixer used to nest a second pair
  const file = tmpFile('nested.md', [
    '(It may halt for other reasons \u2014 the CLI spawn \u2014 but not for this.)',
    'Run it (and the gate \u2014 the strict one \u2014).',
    'Run it (twice), then the gate \u2014 the strict one \u2014 holds.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '(It may halt for other reasons, the CLI spawn, but not for this.)',
    'Run it (and the gate, the strict one).',
    'Run it (twice), then the gate (the strict one) holds.',
  ]);
});

test('fix gives a dash that opens a short list a colon', () => {
  // from this repo's skill files, where a comma made the list read as more of
  // the phrase before it: "broken refs, ghost names, stale lessons"
  const file = tmpFile('list.md', [
    'Fast research sweep \u2014 arxiv, semantic scholar, github, web.',
    'Not just broken refs \u2014 ghost names, stale lessons, and dead code. Then stop.',
    'How execution flows \u2014 dev server startup, request lifecycle, build pipeline',
    'Works with Docs, Sheets, Slides \u2014 creates a full copy.',
    'It held \u2014 and we ran, tested, shipped.',
    'We tried \u2014 one, two, three times it failed here today and then.',
    // from the atris library design skill: a list that closes the bracket its
    // dash sits in takes a colon too, so 80% is not read as one of the items
    'Raise the floor (automate the mechanical 80% \u2014 scaffolding, grids, state matrices).',
    'Run the gate \u2014 tests, docs, lint) after.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'Fast research sweep: arxiv, semantic scholar, github, web.',
    'Not just broken refs: ghost names, stale lessons, and dead code. Then stop.',
    'How execution flows: dev server startup, request lifecycle, build pipeline',
    'Works with Docs, Sheets, Slides, creates a full copy.',
    'It held, and we ran, tested, shipped.',
    'We tried, one, two, three times it failed here today and then.',
    'Raise the floor (automate the mechanical 80%: scaffolding, grids, state matrices).',
    'Run the gate, tests, docs, lint) after.',
  ]);
});

test('fix gives a numbered name that opens a line a colon, like a label', () => {
  // from the math night status files and a validator log in this repo
  const file = tmpFile('numbered.md', [
    'Class 1 \u2014 8-regular graphs on n=14:',
    '**Next:** Tick 2 \u2014 wire the smoke check into CI.',
    '> Phase B \u2014 the cleanup pass',
    'We ran Class 1 \u2014 and it held.',
    'Plan 2 \u2014 and the gate \u2014 held up.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'Class 1: 8-regular graphs on n=14:',
    '**Next:** Tick 2: wire the smoke check into CI.',
    '> Phase B: the cleanup pass',
    'We ran Class 1, and it held.',
    'Plan 2, and the gate, held up.',
  ]);
});

test('fix keeps a paired aside after a plain-word label as parentheses', () => {
  // from a sample of AI-written docs, where the first dash took a colon and
  // the second a comma: "Retries: up to 3, happen automatically"
  const file = tmpFile('label-aside.md', [
    '- Retries \u2014 up to 3 \u2014 happen automatically.',
    'Version 1.2 \u2014 released March 2026 \u2014 adds rollback.',
    '- **Build** \u2014 run it \u2014 then ship.',
    '- Retries \u2014 up to 3. Then \u2014 it stops.',
    // two more dashes after the label pair among themselves; the label stays
    '- Inbox Triage \u2014 23 emails \u2014 all read \u2014 processed today.',
    // a next dash before a joining word goes on with the sentence, like the bold one
    '1. Setup \u2014 install it \u2014 then run it',
    '- Deploy \u2014 build the image \u2014 and push it.',
    // a label that holds its own colon reads the same way, as in swarlo's logs
    "- gap: touch \u2014 refresh an open claim's heartbeat \u2014 existed on the server.",
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '- Retries (up to 3) happen automatically.',
    'Version 1.2 (released March 2026) adds rollback.',
    '- **Build**: run it, then ship.',
    '- Retries: up to 3. Then, it stops.',
    '- Inbox Triage: 23 emails (all read) processed today.',
    '1. Setup: install it, then run it',
    '- Deploy: build the image, and push it.',
    "- gap: touch (refresh an open claim's heartbeat) existed on the server.",
  ]);
});

test('fix keeps a comma when a list item dash comes before a joining word', () => {
  // from a sample README ("Redis, SQS: and more") and a math night proof note
  const file = tmpFile('list-joining.md', [
    '- **Pluggable**: adapters for Redis, SQS \u2014 and more',
    '* vertex 0 has outdeg <= d0 (totalizer) \u2014  so exactly d0,',
    '- Zero config \u2014 just install it',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '- **Pluggable**: adapters for Redis, SQS, and more',
    '* vertex 0 has outdeg <= d0 (totalizer), so exactly d0,',
    '- Zero config: just install it',
  ]);
});

test('fix keeps the colon after a label that already holds one', () => {
  // a comma here was tried and read worse in 30-odd repo lines: the second
  // colon explains the first, and a comma turns it into a run-on
  const file = tmpFile('second-colon.md', [
    '- **Weak:** Can be too rigid \u2014 sometimes a score is not the point.',
    '  - **Result:** PASS \u2014 Moved to Completed Features section',
    '- **cli:** `init` no longer overwrites files \u2014 closes #1290.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '- **Weak:** Can be too rigid: sometimes a score is not the point.',
    '  - **Result:** PASS: Moved to Completed Features section',
    '- **cli:** `init` no longer overwrites files: closes #1290.',
  ]);
});

test('fix gives an italic label that opens a line a colon, like a bold one', () => {
  // from a sample pull request description, where "_Note_" took a comma
  const file = tmpFile('italic-label.md', [
    '_Note_ \u2014 requires Node 18+.',
    '> *Tip* \u2014 run it twice.',
    '* item \u2014 a list line, not a label',
    '_private_value \u2014 kept as is',
    '- *Retries* \u2014 up to 3 \u2014 happen automatically.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '_Note_: requires Node 18+.',
    '> *Tip*: run it twice.',
    '* item: a list line, not a label',
    '_private_value, kept as is',
    '- *Retries*: up to 3, happen automatically.',
  ]);
});

test('fix turns a table cell that holds only a dash into a hyphen', () => {
  // from the skill zones one-pager, where the cell became a stray comma
  const file = tmpFile('table.md', [
    '| 1 | We sit with one person on your team | \u2014 |',
    '| \u2014 | none yet |\u2014|',
    '| 2 | Build the skill \u2014 then ship it | done |',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '| 1 | We sit with one person on your team | - |',
    '| - | none yet |-|',
    '| 2 | Build the skill, then ship it | done |',
  ]);
  assert.deepEqual(scanFile(file).map((f) => f.line), [], 'nothing left to flag');
});

test('a line marked slop-ignore is neither flagged nor fixed', () => {
  // the copy-editor skill quotes a dash-heavy sentence as its bad example
  const D = '\u2014';
  const body = [
    '**Before:**',
    '<!-- slop-ignore-next-line -->',
    `> promoted by institutions${D}not by the people${D}even in documents.`,
    `A quoted tell ${D} kept on purpose. <!-- slop-ignore -->`,
    `This one ${D} is real slop.`,
  ].join('\n');
  const file = tmpFile('ignore.md', body);
  assert.deepEqual(scanFile(file).map((f) => f.line), [5], 'only the unmarked line is flagged');
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.line), [5], 'only the unmarked line is fixed');
  assert.deepEqual(fs.readFileSync(file, 'utf8').split('\n').slice(0, 4), body.split('\n').slice(0, 4));
});

test('fix drops a dash after a quote that already ends its sentence', () => {
  // from this repo's feature notes, policies, and the endgame skill; a name
  // that closes the line is who said the quote, so it takes parentheses
  const file = tmpFile('quote-end.md', [
    'He said "the gap is wiring." \u2014 PERSONA.md exists.',
    '"Connect them looking backward." \u2014 Steve Jobs',
    '> \u201cWhy not now?\u201d \u2014 Grace Hopper',
    'He said "it held." \u2014 Then',
    'Ask "what did we miss?" \u2014 Then read the calls.',
    'They think "who made this?" \u2014 that is the goal.',
    '- "What did we miss?" \u2014 summarizes calls',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'He said "the gap is wiring." PERSONA.md exists.',
    '"Connect them looking backward." (Steve Jobs)',
    '> \u201cWhy not now?\u201d (Grace Hopper)',
    'He said "it held." Then',
    'Ask "what did we miss?" Then read the calls.',
    'They think "who made this?"; that is the goal.',
    '- "What did we miss?": summarizes calls',
  ]);
});

test('fix joins two full clauses with a semicolon, not a comma splice', () => {
  // from the design policy, the spaceship idea, and the validator; 33 repo
  // lines took a semicolon here and each was read
  const file = tmpFile('clause-join.md', [
    "this isn't optional \u2014 it's part of good design.",
    "fastq isn't \u2014 it's ~200 lines.",
    'It never dies on a bad tick \u2014 it survives halts.',
    'Never animate width or height \u2014 they trigger layout.',
    "Skip the dark default \u2014 that's how it starts looking the same.",
    'We fixed the gap \u2014 this time with tests.',
    'Then \u2014 it stops.',
    'Use `PUT` \u2014 that is for updates.',
    'Run `npm test` \u2014 then ship.',
    // a contrast that corrects itself is not two clauses; its right side is a
    // fragment, so it keeps the comma (design policy, 45 "not" lines read)
    "not because they're more creative \u2014 because they own the craft.",
    "Not because it's fast \u2014 because it's honest.",
    'Not rules \u2014 convictions.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    "this isn't optional; it's part of good design.",
    "fastq isn't; it's ~200 lines.",
    'It never dies on a bad tick; it survives halts.',
    'Never animate width or height; they trigger layout.',
    "Skip the dark default; that's how it starts looking the same.",
    'We fixed the gap, this time with tests.',
    'Then, it stops.',
    'Use `PUT`; that is for updates.',
    'Run `npm test`, then ship.',
    "not because they're more creative, because they own the craft.",
    "Not because it's fast, because it's honest.",
    'Not rules, convictions.',
  ]);
});

test('fix joins a noun clause after the dash with a semicolon', () => {
  // from the land, mission, and endgame files; 7 repo lines moved and each was read
  const file = tmpFile('not-clause.md', [
    'A stopped mission is not a twin \u2014 restart is allowed.',
    'Do NOT put examples here \u2014 every `- ` line under `## Pending` is read.',
    'The command is not yet wired \u2014 the template exists but no verb.',
    'It is not green \u2014 even when the build is red.',
    'Not sends, not laps \u2014 replies. A reply is the market.',
    // a helping verb joins with no "not" too, unless a second "the" or a
    // "that" makes the right side one phrase; a plain verb still needs "not"
    'The tool is fast \u2014 the build is green.',
    'Task is still open \u2014 receipt did not move it to review.',
    'The cache was cold \u2014 the first call could take a second.',
    'Same pid but an hour old \u2014 the tick runs and clears the lock.',
    'It MUST keep its own root \u2014 task state stays isolated.',
    // a short "not" opener has no verb, so the clause explains it with a colon
    'Zero hits. Not exhaustive \u2014 the frontier was not extended.',
    'Not yet \u2014 it ships Friday.',
    '- **Not yet** \u2014 it ships Friday.',
    'Not only does it fail \u2014 it crashes.',
    // a plain verb in "s" joins after a determiner and one more word
    'This dir is not safe \u2014 a stray /tmp/atris turns them into fixtures.',
    'Lines DO NOT SURVIVE \u2014 the next `atris task render` regenerates the file.',
    'Name the owner, not a fix \u2014 the changes from whoever saw it.',
    'It is not the cause \u2014 the old tests from CI.',
    'Every pending row, not just the first 12 \u2014 the bug this fix closes.',
    'Null engine fails every task \u2014 the exam is not rigged to pass.',
    'Pin it for `tick` \u2014 the verb the fleet runs every cycle.',
    'Tick history (the compounding signal \u2014 proves the loop is recursive).',
    'Command tests for autopilot \u2014 the decision helpers the CLI uses.',
    // a naming word that restates the noun before it keeps its comma
    'They meet at the same intersection \u2014 the next thing /autopilot should ship.',
    'Read the logs \u2014 the one thing is clear.',
    // one short place phrase may sit between the subject and its verb
    'The bound holds for small graphs \u2014 the counting slack at degree 4 is only 2.',
    'The queue looks fine \u2014 the oldest job in the queue is stale.',
    // a second place phrase still joins; a joining word keeps its comma
    'Read the logs \u2014 the work for agents in the fleet is done.',
    'It is not green \u2014 even when the build in CI is red.',
    // a verb that reports a fact starts no subject; a plural word before a noun does
    'Endpoint was null \u2014 proves instance was stale.',
    'The cache missed \u2014 settings file is stale.',
    // a past form counts only when it never describes a noun
    'The run stopped \u2014 showed queue was full.',
    'The review is done \u2014 suggested fix is ready.',
    // "nothing" and its kin before a verb in "ed" or "s" start a clause
    'The gate held \u2014 nothing in the queue moved.',
    'Check the board \u2014 nobody claimed it.',
    'Ship it \u2014 nothing fancy.',
    'Keep it plain \u2014 nothing less than that.',
    // a count and a plural noun before a verb in "ed" start a clause too
    'The fix is small \u2014 two lines in the fixer changed.',
    'It is done \u2014 both checks passed.',
    'Keep the board \u2014 two tests marked as flaky.',
    // "nine of fourteen" and its kin before a plural and a verb start one too
    'Ask who reads the key \u2014 nine of fourteen toggles read nowhere.',
    'It was noise \u2014 2 of 2 reported "violations" were the same false positive.',
    'Pick a plan \u2014 one of `free`, `pro` or `max`.',
    'Check the board \u2014 two of the tests in CI.',
    // "the" and a verb in "ed" start a clause only before a stop, a word
    // like "out", or an object; a noun phrase keeps its comma
    'Ran the suite \u2014 the slow tests timed out.',
    'We shipped it \u2014 the old flag stopped working.',
    'Ship it \u2014 the new signed build.',
    'Keep notes \u2014 the files stored in atris.',
    // common past verbs without "ed" count too; a "they" before the verb does not
    'The reason was not a timeout \u2014 the gate let the tick through.',
    'Clearly not real \u2014 the file built fine.',
    'Read the notes \u2014 the version they made.',
    'Read the notes \u2014 the version they shipped.',
    // a title where every word is capitalized names a thing, so it never
    // joins; words in all capitals are shouting and still do
    'Inbox Triage \u2014 23 emails processed',
    'Release Notes \u2014 it ships Friday.',
    // a plain verb with "it" or "them" after it joins; one with its own verb after does not
    'Your journal tracks how ideas evolve \u2014 the navigator reads it to understand context.',
    'Ship it \u2014 the gate checks them.',
    'Command tests for autopilot \u2014 the decision helpers it uses.',
    // an object with its own "the" joins when a stop or "on" ends it; a word
    // after it makes the right side one noun phrase
    'IDs can be short \u2014 the CLI resolves the prefix',
    'Pills are tappable \u2014 a tap focuses the next turn on that computer.',
    'Chat greps for it \u2014 a regression turns the gate red instead of waiting.',
    'Read the board \u2014 the old builds the gate keeps green.',
    'Author block docs \u2014 the live docs the Atris editor renders, with charts.',
    // a word in "ly" that says how joins the same way; "mostly" does not
    'Hand off \u2014 the voice acknowledges instantly and the agent answers.',
    'Ship the patch \u2014 the fixer works cleanly.',
    'It is old code \u2014 the tests mostly.',
    // a word in "s" before ", which is" is a verb; a noun in "us" or "ics" is not
    'It silently does nothing \u2014 the unbulleted form works, which is why nobody noticed.',
    'Check the deploy \u2014 the build status, which is green.',
    'Read the report \u2014 the eval metrics, which is the point.',
    // "once", "when" or "if" with a comma and a subject after it starts a
    // second sentence; with no subject after the comma it only adds a condition
    'This is the archive \u2014 once the endgame closes, future runs can read this.',
    'Run the gate \u2014 when it passes, the branch lands.',
    'It fails \u2014 when the disk is full.',
    'Ship it \u2014 if you can, after lunch.',
    // a command with "it" after the comma is a sentence; "then it" is not
    'Keep the log \u2014 if it breaks, trace it.',
    'Ship it \u2014 if you can, then it lands.',
    // clauses that open with "when" or "if" are not a list, and may hold commas
    'Watch the queue \u2014 when it fills, if it stalls, drain it.',
    'The tool runs \u2014 when needed, before lunch, after the build.',
    // "each time" and "every time" open one like "when" does
    'The cache warms up \u2014 every time a tick lands, the gate holds.',
    'Keep the log \u2014 each time it breaks, trace it.',
    'The cache warms up \u2014 each time it fails, after lunch.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'A stopped mission is not a twin; restart is allowed.',
    'Do NOT put examples here; every `- ` line under `## Pending` is read.',
    'The command is not yet wired; the template exists but no verb.',
    'It is not green, even when the build is red.',
    'Not sends, not laps, replies. A reply is the market.',
    'The tool is fast; the build is green.',
    'Task is still open; receipt did not move it to review.',
    'The cache was cold; the first call could take a second.',
    'Same pid but an hour old; the tick runs and clears the lock.',
    'It MUST keep its own root; task state stays isolated.',
    'Zero hits. Not exhaustive: the frontier was not extended.',
    'Not yet: it ships Friday.',
    '- **Not yet**: it ships Friday.',
    'Not only does it fail; it crashes.',
    'This dir is not safe; a stray /tmp/atris turns them into fixtures.',
    'Lines DO NOT SURVIVE; the next `atris task render` regenerates the file.',
    'Name the owner, not a fix, the changes from whoever saw it.',
    'It is not the cause, the old tests from CI.',
    'Every pending row, not just the first 12, the bug this fix closes.',
    'Null engine fails every task; the exam is not rigged to pass.',
    'Pin it for `tick`, the verb the fleet runs every cycle.',
    'Tick history (the compounding signal, proves the loop is recursive).',
    'Command tests for autopilot, the decision helpers the CLI uses.',
    'They meet at the same intersection, the next thing /autopilot should ship.',
    'Read the logs; the one thing is clear.',
    'The bound holds for small graphs; the counting slack at degree 4 is only 2.',
    'The queue looks fine; the oldest job in the queue is stale.',
    'Read the logs; the work for agents in the fleet is done.',
    'It is not green, even when the build in CI is red.',
    'Endpoint was null, proves instance was stale.',
    'The cache missed; settings file is stale.',
    'The run stopped, showed queue was full.',
    'The review is done; suggested fix is ready.',
    'The gate held; nothing in the queue moved.',
    'Check the board; nobody claimed it.',
    'Ship it, nothing fancy.',
    'Keep it plain, nothing less than that.',
    'The fix is small; two lines in the fixer changed.',
    'It is done; both checks passed.',
    'Keep the board, two tests marked as flaky.',
    'Ask who reads the key; nine of fourteen toggles read nowhere.',
    'It was noise; 2 of 2 reported "violations" were the same false positive.',
    'Pick a plan, one of `free`, `pro` or `max`.',
    'Check the board, two of the tests in CI.',
    'Ran the suite; the slow tests timed out.',
    'We shipped it; the old flag stopped working.',
    'Ship it, the new signed build.',
    'Keep notes, the files stored in atris.',
    'The reason was not a timeout; the gate let the tick through.',
    'Clearly not real; the file built fine.',
    'Read the notes, the version they made.',
    'Read the notes, the version they shipped.',
    'Inbox Triage, 23 emails processed',
    'Release Notes, it ships Friday.',
    'Your journal tracks how ideas evolve; the navigator reads it to understand context.',
    'Ship it; the gate checks them.',
    'Command tests for autopilot, the decision helpers it uses.',
    'IDs can be short; the CLI resolves the prefix',
    'Pills are tappable; a tap focuses the next turn on that computer.',
    'Chat greps for it; a regression turns the gate red instead of waiting.',
    'Read the board, the old builds the gate keeps green.',
    'Author block docs, the live docs the Atris editor renders, with charts.',
    'Hand off; the voice acknowledges instantly and the agent answers.',
    'Ship the patch; the fixer works cleanly.',
    'It is old code, the tests mostly.',
    'It silently does nothing; the unbulleted form works, which is why nobody noticed.',
    'Check the deploy, the build status, which is green.',
    'Read the report, the eval metrics, which is the point.',
    'This is the archive; once the endgame closes, future runs can read this.',
    'Run the gate; when it passes, the branch lands.',
    'It fails, when the disk is full.',
    'Ship it, if you can, after lunch.',
    'Keep the log; if it breaks, trace it.',
    'Ship it, if you can, then it lands.',
    'Watch the queue; when it fills, if it stalls, drain it.',
    'The tool runs, when needed, before lunch, after the build.',
    'The cache warms up; every time a tick lands, the gate holds.',
    'Keep the log; each time it breaks, trace it.',
    'The cache warms up, each time it fails, after lunch.',
  ]);
});

test('fix in a script changes comments only, never strings or patterns', () => {
  // the lesson fixtures in this repo's tests are parsed by the code they test;
  // 214 repo fixes sat in strings like these, and every one is left alone now
  const file = tmpFile('fixture.test.js', [
    "// the lock is stale \u2014 it gets cleared",
    "const lesson = '- **[2026-01-01] loop** \u2014 fail \u2014 no mechanism.';",
    "assert.match(out, /Launcher \u2014 The Closer/); // labels \u2014 kept as written",
    "const url = 'https://x.dev'; // the docs \u2014 this time with tests",
    "const md = `# Plan",
    "## Step \u2014 one // not a comment",
    "`;",
    '/*',
    " * Retries \u2014 up to 3 \u2014 happen automatically.",
    ' */',
    "const pattern = /https?:\\/\\//; const label = 'keep \u2014 exactly';",
    "const slash = /[/]x/; const note = 'a \u2014 b';",
    "const half = total / 2; // split \u2014 evenly",
    "// e.g. `selection-\u2014-member` stays \u2014 the slug is code",
  ].join('\n'));
  const { changes } = applyFixes([file], RULES, { write: false });
  assert.deepEqual(changes.map((c) => c.after), [
    '// the lock is stale; it gets cleared',
    "assert.match(out, /Launcher \u2014 The Closer/); // labels, kept as written",
    "const url = 'https://x.dev'; // the docs, this time with tests",
    ' * Retries (up to 3) happen automatically.',
    'const half = total / 2; // split, evenly',
    "// e.g. `selection-\u2014-member` stays; the slug is code",
  ]);
});

test('fix leaves link addresses, HTML tags, and code in plain text alone', () => {
  // a dash in an address or attribute used to pair with a prose dash and drop
  // a parenthesis into the path; alt text and link text are still prose
  const md = tmpFile('links.md', [
    'See <https://x.dev/a\u2014b> for it \u2014 really.',
    'Open [the guide](https://x.dev/a\u2014b) \u2014 it helps.',
    '<a title="x \u2014 y" href="/z">link</a> works \u2014 well.',
    '![chart \u2014 q3](img/a\u2014b.png) shows it.',
  ].join('\n'));
  const txt = tmpFile('note.txt', 'Run `a \u2014 b` here \u2014 then stop.');
  const { changes } = applyFixes([md, txt], RULES, { write: false });
  assert.deepEqual(changes.map((c) => c.after), [
    'See <https://x.dev/a\u2014b> for it, really.',
    'Open [the guide](https://x.dev/a\u2014b); it helps.',
    '<a title="x \u2014 y" href="/z">link</a> works, well.',
    '![chart, q3](img/a\u2014b.png) shows it.',
    'Run `a \u2014 b` here, then stop.',
  ]);
});

test('a placeholder in angle brackets is prose, so its dash is flagged and fixed', () => {
  // template fields like "<one line, what it does>" were read as HTML tags and
  // kept their dash; a tag with an attribute or a comment stays literal
  const lines = [
    'description: <one line \u2014 what this member does>',
    '- deferred: <ideas explicitly parked \u2014 must not invade the mission>',
    '<a title="x \u2014 y">link</a> stays.',
    '<!-- Workspace \u2014 2026-03-23 -->',
  ];
  const file = tmpFile('placeholder.md', lines.join('\n'));
  assert.deepEqual(scanFile(file).filter((f) => f.rule === 'em-dash').map((f) => f.line), [1, 2]);
  const { changes } = applyFixes([file], RULES, { write: false });
  assert.deepEqual(changes.map((c) => c.after), [
    'description: <one line, what this member does>',
    '- deferred: <ideas explicitly parked, must not invade the mission>',
  ]);
});

test('fix keeps a link address whole when it has a title or nested parentheses', () => {
  // a titled link used to lose its mask, so "a-b" in the path became "a, b";
  // the title is masked too, so its dash never pairs with one outside the link
  const file = tmpFile('link-title.md', [
    'Open [the guide](https://x.dev/a\u2014b "Guide \u2014 v2") \u2014 it helps.',
    'See [Up](https://x.org/wiki/Up_(film\u20142009)) for it \u2014 really.',
    '![pic](img/a_(1\u20142).png) shows \u2014 a lot.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES, { write: false });
  assert.deepEqual(changes.map((c) => c.after), [
    'Open [the guide](https://x.dev/a\u2014b "Guide \u2014 v2"); it helps.',
    'See [Up](https://x.org/wiki/Up_(film\u20142009)) for it, really.',
    '![pic](img/a_(1\u20142).png) shows, a lot.',
  ]);
});

test('fix leaves footnote and reference labels alone and fixes the prose around them', () => {
  // a dash in a label used to pair with a prose dash: "[^note (1] Then more)"
  const file = tmpFile('refs.md', [
    'A claim.[^note\u20141] Then more \u2014 after.',
    '[^note\u20141]: The source \u2014 page 4.',
    'See [the guide][ref\u20141] \u2014 it helps.',
    '[ref\u20141]: https://x.dev/a\u2014b "Guide \u2014 v2"',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES, { write: false });
  assert.deepEqual(changes.map((c) => c.after), [
    'A claim.[^note\u20141] Then more, after.',
    '[^note\u20141]: The source, page 4.',
    'See [the guide][ref\u20141]; it helps.',
    '[ref\u20141]: https://x.dev/a\u2014b "Guide, v2"',
  ]);
});

test('fix leaves keyboard tags, HTML code, and inline math alone', () => {
  // a dash inside the pair used to become a comma: "<kbd>Ctrl, C</kbd>"
  const file = tmpFile('inline-literal.md', [
    'Press <kbd>Ctrl\u2014C</kbd> to stop \u2014 then wait.',
    'Use <code>a \u2014 b</code> here \u2014 carefully.',
    'The math $a\u2014b$ holds \u2014 always.',
    'Display $$x\u2014y$$ is fine \u2014 mostly.',
    'It costs $5 \u2014 and $10 for two.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES, { write: false });
  assert.deepEqual(changes.map((c) => c.after), [
    'Press <kbd>Ctrl\u2014C</kbd> to stop, then wait.',
    'Use <code>a \u2014 b</code> here, carefully.',
    'The math $a\u2014b$ holds, always.',
    'Display $$x\u2014y$$ is fine, mostly.',
    'It costs $5, and $10 for two.',
  ]);
});

test('fix attributes a quote with no stop of its own with a comma', () => {
  // a README testimonial; of 22 repo lines with a dash after a closing quote,
  // none read better with another mark, so the comma is the settled choice
  const file = tmpFile('quote-attribution.md', [
    '> "It just works" \u2014 a happy user',
    '> \u201cFast and boring\u201d \u2014 Jane Doe, maintainer',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '> "It just works", a happy user',
    '> \u201cFast and boring\u201d, Jane Doe, maintainer',
  ]);
});

test('fix credits a quote in bold or italics the same way as a plain one', () => {
  // the fix wrote '*"power."*, Musk' mid-paragraph and '*"power."* Musk' at
  // its end, and a list label quote took a colon: '"Less, but better.": Dieter Rams'
  const file = tmpFile('emphasis-credit.md', [
    '> *"The limiting factor is electrical power."* \u2014 Musk',
    '> *"Token pricing drops by half every three months."* \u2014 Nadella',
    '',
    '- "Simplicity is the ultimate sophistication." \u2014 Leonardo da Vinci',
    '- **"We will see one-person companies."** \u2014 Sam Altman.',
    '- "Let\'s circle back on this." \u2014 Dead.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES, { write: false });
  assert.deepEqual(changes.map((c) => c.after), [
    '> *"The limiting factor is electrical power."* (Musk)',
    '> *"Token pricing drops by half every three months."* (Nadella)',
    '- "Simplicity is the ultimate sophistication." (Leonardo da Vinci)',
    '- **"We will see one-person companies."** (Sam Altman).',
    '- "Let\'s circle back on this.": Dead.',
  ]);
});

test('fix joins a dash after "Inc." or "et al." with a comma, since no sentence ended', () => {
  // the period read as a sentence end, so the dash just went and fused the
  // line: "Cooling, Inc. Columbus, OH", "Yang et al. Forward testing effect"
  const file = tmpFile('short-forms.md', [
    '## Airfast Heating & Cooling, Inc. \u2014 Columbus, OH',
    '- Pastotter; Yang et al. \u2014 forward testing effect',
    'Rulin Shao et al. \u2014 61 citations',
    'Covers resets, OAuth callbacks, etc. \u2014 NOT checkout.',
    'Admin-only, path-safe. \u2014 DONE.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES, { write: false });
  assert.deepEqual(changes.map((c) => c.after), [
    '## Airfast Heating & Cooling, Inc., Columbus, OH',
    '- Pastotter; Yang et al., forward testing effect',
    'Rulin Shao et al., 61 citations',
    'Covers resets, OAuth callbacks, etc., NOT checkout.',
    'Admin-only, path-safe. DONE.',
  ]);
});

test('fix gives a long bold list label a colon, but a comma before a joining word', () => {
  // the "1." of a numbered list ends no sentence, but a long bold phrase after
  // it still labels what follows; before "and", "but", "or" or "so" it goes on
  // with its sentence, which the fix wrote as "catching up**: and that's great"
  const file = tmpFile('bold-list.md', [
    '24. **Decide the deployer-vs-provider classification under the EU AI Act** \u2014 the scope settles it.',
    '5. **Open source is catching up** \u2014 and that\'s great.',
    '1. **Assign Elastic IP** \u2014 so the endpoint URL is stable across restarts.',
    'One is commodity. **Audit + loop is what customers pay for** \u2014 and is hard to copy.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES, { write: false });
  assert.deepEqual(changes.map((c) => c.after), [
    '24. **Decide the deployer-vs-provider classification under the EU AI Act**: the scope settles it.',
    '5. **Open source is catching up**, and that\'s great.',
    '1. **Assign Elastic IP**, so the endpoint URL is stable across restarts.',
    'One is commodity. **Audit + loop is what customers pay for**, and is hard to copy.',
  ]);
});

test('fix credits a speaker with a short note after the name', () => {
  // a note after the name left the whole credit bare: '"Make it good." Steve
  // Jobs, WWDC 1997'; a sentence after a quote is no credit and keeps its fix
  const file = tmpFile('credit-note.md', [
    '> "Make it good." \u2014 Steve Jobs, WWDC 1997',
    '> "Good." \u2014 Tony M. (same sources)',
    '> "Action produces information." \u2014 Armstrong via Marchese',
    '> "Less is more." \u2014 Antoine de Saint-Exup\u00e9ry',
    '1. **"It took me half an hour to make, just a fun thing on the side."** \u2014 Prydz on Call on Me',
    '> "Stop." \u2014 Honestly, I liked it.',
    '> "Coffee?" \u2014 Banner Dark is the safe pick.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES, { write: false });
  assert.deepEqual(changes.map((c) => c.after), [
    '> "Make it good." (Steve Jobs, WWDC 1997)',
    '> "Good." (Tony M., same sources)',
    '> "Action produces information." (Armstrong via Marchese)',
    '> "Less is more." (Antoine de Saint-Exup\u00e9ry)',
    '1. **"It took me half an hour to make, just a fun thing on the side."** (Prydz on Call on Me)',
    '> "Stop." Honestly, I liked it.',
    '> "Coffee?" Banner Dark is the safe pick.',
  ]);
});

test('fix gives a list label that is one whole quote a colon after the quote', () => {
  // the skill zones one-pager lists sample questions, each with what it does
  const file = tmpFile('quote-label.md', [
    '- "What happened on the calls?" \u2014 summarizes transcripts',
    '* \u201cShip it.\u201d \u2014 the motto we keep',
    '- Ask "what did we miss?" \u2014 then read the calls',
    '1. **what is it?** \u2014 clear product description',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '- "What happened on the calls?": summarizes transcripts',
    '* \u201cShip it.\u201d: the motto we keep',
    '- Ask "what did we miss?" then read the calls',
    '1. **what is it?** clear product description',
  ]);
});

test('fix gives a whole-line bold phrase a colon, like a heading', () => {
  // from the research and email skills
  const file = tmpFile('bold-heading.md', [
    '**Source A \u2014 arxiv API**',
    '> **Source B \u2014 Semantic Scholar API**',
    '**Ship it \u2014 and say so**',
    '**Reply in thread (IMPORTANT \u2014 use this for all replies):**',
    'This is **a bold \u2014 phrase** in a line.',
    // a last dash before a joining word goes on with the phrase
    '**Setup \u2014 install it \u2014 then run it**',
    '> **Ship \u2014 the build \u2014 and the notes**',
    '**Plan \u2014 a \u2014 b \u2014 then c**',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '**Source A: arxiv API**',
    '> **Source B: Semantic Scholar API**',
    '**Ship it, and say so**',
    '**Reply in thread (IMPORTANT, use this for all replies):**',
    'This is **a bold, phrase** in a line.',
    '**Setup: install it, then run it**',
    '> **Ship: the build, and the notes**',
    '**Plan, a, b, then c**',
  ]);
});

test('fix never pairs two dashes across a sentence end', () => {
  // shapes taken from this repo's own docs, where the old fixer opened a
  // parenthesis in one sentence and closed it in the next
  const file = tmpFile('sentences.md', [
    'Steal from sites you like \u2014 linear.app, arc. But do not copy \u2014 learn.',
    'Not rules \u2014 beliefs. Not copied \u2014 earned.',
    'It said "stop." \u2014 then it went \u2014 and left.',
    'Doubt \u2014 a failing check, a bad lesson \u2014 is a map.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'Steal from sites you like, linear.app, arc. But do not copy, learn.',
    'Not rules, beliefs. Not copied, earned.',
    'It said "stop." then it went, and left.',
    'Doubt (a failing check, a bad lesson) is a map.',
  ]);
});

test('fix gives a list item inside a quote the same label colon', () => {
  // the label rule stopped at the quote mark, so "> - item" kept a comma
  const file = tmpFile('quoted-list.md', [
    '> - quoted item \u2014 what it does',
    '> > 1. **Gate** \u2014 blocks bad copy',
    '> - Redis \u2014 and more',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES, { write: false });
  assert.deepEqual(changes.map((c) => c.after), [
    '> - quoted item: what it does',
    '> > 1. **Gate**: blocks bad copy',
    '> - Redis, and more',
  ]);
});

test('fix gives an odd run of three dashes in one sentence commas, not one pair', () => {
  // "A (b) c, d" paired the first two and left the third a comma
  const file = tmpFile('dash-run.md', [
    'A \u2014 b \u2014 c \u2014 d.',
    'Two asides \u2014 one \u2014 and \u2014 two \u2014 here.',
    'It ran \u2014 fast. Red \u2014 blue \u2014 gold \u2014 all of it.',
    'It works \u2014 and the gate \u2014 the strict one \u2014 still holds.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES, { write: false });
  assert.deepEqual(changes.map((c) => c.after), [
    'A, b, c, d.',
    'Two asides (one) and (two) here.',
    'It ran, fast. Red, blue, gold, all of it.',
    'It works, and the gate (the strict one) still holds.',
  ]);
});

test('fix gives a run of "label: value" fields commas, and a signed score no range', () => {
  // swarlo scorecards came out "shipped: 1/1 (halt: 0%) reward: 0" and "+4-404"
  const file = tmpFile('field-run.md', [
    '- **loop** \u2014 shipped: 1/1 \u2014 wall-clock: 20.6h \u2014 halt: 0% \u2014 reward: 0 \u2014 lessons: 0',
    '- **hint** \u2014 shipped: 1/1 \u2014 verify: 437 tests \u2014 reward: +4 \u2014 404 on missing routes',
    'Pages 10 \u2014 20 cover it.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES, { write: false });
  assert.deepEqual(changes.map((c) => c.after), [
    '- **loop**: shipped: 1/1, wall-clock: 20.6h, halt: 0%, reward: 0, lessons: 0',
    '- **hint**: shipped: 1/1, verify: 437 tests, reward: +4, 404 on missing routes',
    'Pages 10-20 cover it.',
  ]);
});

test('fix never pairs two dashes across the edge of a quote', () => {
  // the aside opened inside the quote and closed outside it: '"go (now") and'
  const file = tmpFile('quote-edge.md', [
    'He said "go \u2014 now" \u2014 and left.',
    'She wrote \u201cship it \u2014 today\u201d \u2014 then slept.',
    'The tag \u2014 "beta" \u2014 stays on.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES, { write: false });
  assert.deepEqual(changes.map((c) => c.after), [
    'He said "go, now", and left.',
    'She wrote \u201cship it, today\u201d, then slept.',
    'The tag ("beta") stays on.',
  ]);
});

test('fix never pairs two dashes across the edge of a bold or code mark', () => {
  // a sfhq log came out '**SFH-16 (insider guide library.** The old one was fake) seven'
  const file = tmpFile('bold-edge.md', [
    '**SFH-16 \u2014 insider guide library.** The old one was fake \u2014 seven left.',
    '`npm test \u2014 strict` passed \u2014 then it shipped.',
    'The gate \u2014 **the strict one** \u2014 holds.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES, { write: false });
  assert.deepEqual(changes.map((c) => c.after), [
    '**SFH-16, insider guide library.** The old one was fake, seven left.',
    '`npm test \u2014 strict` passed, then it shipped.',
    'The gate (**the strict one**) holds.',
  ]);
});

test('fix gives a name that opens a paragraph a colon, like a definition', () => {
  // from this repo's feature docs: "v2 then a dash then harness re-verified"
  // under a heading, and "MEMBER.md then a dash then an open-source standard"
  const file = tmpFile('term.md', [
    '## Status',
    '',
    'v2 \u2014 harness re-verified',
    'a wrapped line \u2014 keeps its comma',
    '',
    'MEMBER.md \u2014 an open standard.',
    '',
    'Yes \u2014 we did it.',
    '',
    'CLI \u2014 the tool \u2014 ships.',
    '',
    // two to four capitalized words are a title the rest describes
    'Inbox Triage \u2014 23 emails processed',
    'Atris Labs \u2014 a wrapped line keeps its comma.',
    '',
    'Yes Sir \u2014 and then some.',
    '',
    // a last dash before a joining word goes on with the sentence
    'v2 \u2014 shipped \u2014 then rolled back',
    '',
    'Inbox Triage \u2014 23 emails \u2014 and 4 drafts.',
    '',
    'v3 \u2014 shipped \u2014 then pulled \u2014 for a week \u2014 ok',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES, { write: false });
  assert.deepEqual(changes.map((c) => c.after), [
    'v2: harness re-verified',
    'a wrapped line, keeps its comma',
    'MEMBER.md: an open standard.',
    'Yes, we did it.',
    'CLI (the tool) ships.',
    'Inbox Triage: 23 emails processed',
    'Atris Labs, a wrapped line keeps its comma.',
    'Yes Sir, and then some.',
    'v2: shipped, then rolled back',
    'Inbox Triage: 23 emails, and 4 drafts.',
    'v3 (shipped) then pulled (for a week) ok',
  ]);
});

test('fix gives an aside that holds its own parentheses commas, not a second pair', () => {
  // "(then (maybe) stop)" nests; an aside that is one whole pair keeps it
  const file = tmpFile('nested-aside.md', [
    'Read it \u2014 then (maybe) stop \u2014 ok.',
    'The gate \u2014 the one CI (and hooks) run \u2014 blocks it.',
    'Scale \u2014 (model size, data) \u2014 is a bet.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES, { write: false });
  assert.deepEqual(changes.map((c) => c.after), [
    'Read it, then (maybe) stop, ok.',
    'The gate, the one CI (and hooks) run, blocks it.',
    'Scale (model size, data) is a bet.',
  ]);
});

test('fix gives an aside that opens with a joining word commas, not parentheses', () => {
  // the words between the dashes go on with the sentence instead of breaking it
  const file = tmpFile('joining-aside.md', [
    '- **Setup** \u2014 install it \u2014 then run it \u2014 and ship',
    'A file \u2014 or a folder \u2014 works.',
    'The gate \u2014 the strict one \u2014 holds.',
    // a lone joining word takes no comma after it
    'Ship it \u2014 then \u2014 wait.',
    'Run it \u2014 or \u2014 skip it.',
    // "so" before a describing word and "yet another" are real asides
    'The fix \u2014 so small it fits in a line \u2014 shipped.',
    'The build \u2014 yet another one \u2014 failed.',
    'We paused \u2014 so it could drain \u2014 and restarted.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES, { write: false });
  assert.deepEqual(changes.map((c) => c.after), [
    '- **Setup**: install it, then run it, and ship',
    'A file, or a folder, works.',
    'The gate (the strict one) holds.',
    'Ship it, then wait.',
    'Run it, or skip it.',
    'The fix (so small it fits in a line) shipped.',
    'The build (yet another one) failed.',
    'We paused, so it could drain, and restarted.',
  ]);
});

test('fix joins a full clause after a field value with a semicolon, not a second colon', () => {
  // from a writing member file, where the field took a stacked colon
  const file = tmpFile('field-clause.md', [
    '- pass: you call `atris write pass <n>` when a beat holds up \u2014 the AI never calls it',
    // a list after the value is explained, so it keeps the colon
    '- innovation lane: true gaps get one paragraph each \u2014 what is missing, why no fix, what next',
    '- risk: none \u2014 verification only',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '- pass: you call `atris write pass <n>` when a beat holds up; the AI never calls it',
    '- innovation lane: true gaps get one paragraph each: what is missing, why no fix, what next',
    '- risk: none, verification only',
  ]);
});

test('fix gives a whole-line bold sentence a comma before through, via or with', () => {
  // from the endgame skill, where the dash took a colon like a subtitle
  const file = tmpFile('bold-how.md', [
    '2. **Add each REVERSE PATH step as a tagged task \u2014 through the task db when one exists.**',
    '**Ship the build \u2014 with the new flag on.**',
    '- **Ship the build \u2014 via the queue.**',
    // a bold title with a plain subtitle keeps its colon
    '**Source A \u2014 arxiv API**',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '2. **Add each REVERSE PATH step as a tagged task, through the task db when one exists.**',
    '**Ship the build, with the new flag on.**',
    '- **Ship the build, via the queue.**',
    '**Source A: arxiv API**',
  ]);
});

test('fix starts an order after a clause that follows a semicolon', () => {
  // from the kernel prompt, where an order opened the line before the semicolon
  const file = tmpFile('order-after-semicolon.md', [
    'preflight: run the verifier first; if it passes, the task is already done \u2014 halt and write rubric-not-falsifiable',
    // two orders side by side are still one sentence
    'Kill the group at timeout \u2014 spawn the phase detached.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'preflight: run the verifier first; if it passes, the task is already done; halt and write rubric-not-falsifiable',
    'Kill the group at timeout, spawn the phase detached.',
  ]);
});

test('fix starts an order and a second order after a comma as their own clause', () => {
  // from the verify-falsifiability idea, where "proceed" read as a past verb
  const file = tmpFile('two-orders.md', [
    "If it passes already, the task is already done \u2014 halt, don't proceed.",
    'The build failed \u2014 do not proceed.',
    // a past verb after a plain order still names a thing
    'Plan B \u2014 copy drafted for 1.6.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    "If it passes already, the task is already done; halt, don't proceed.",
    'The build failed; do not proceed.',
    'Plan B: copy drafted for 1.6.',
  ]);
});

test('fix gives an order a colon when a bold phrase closes the clause before it', () => {
  // from the design policy, where the order spelled out the bold phrase
  const file = tmpFile('bold-then-order.md', [
    'AI is best used to **raise the floor** \u2014 automate the mechanical 80% (layout, grids).',
    // a plain clause before an order still starts a new one
    'Pruning the worktree deletes proof \u2014 copy receipts out first.',
    // a bold verdict as a field value never takes a second colon
    'Result: **FAIL** \u2014 fix the repository first.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'AI is best used to **raise the floor**: automate the mechanical 80% (layout, grids).',
    'Pruning the worktree deletes proof; copy receipts out first.',
    'Result: **FAIL**, fix the repository first.',
  ]);
});

test('fix gives a dash before a list of site or file names a colon', () => {
  // from the design policy, where the dots in the names hid the list
  const file = tmpFile('dotted-list.md', [
    'steal from places you like \u2014 linear.app, vercel.com, raycast.com, arc browser. but go on.',
    'The checks run \u2014 lint, test.js, build.',
    // a sentence-ending stop is no inner dot, so two names stay a comma
    'We ship it \u2014 linear.app, vercel.com.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'steal from places you like: linear.app, vercel.com, raycast.com, arc browser. but go on.',
    'The checks run: lint, test.js, build.',
    'We ship it, linear.app, vercel.com.',
  ]);
});

test('fix points back at a bare list with a colon before "these" or "those"', () => {
  // from the design policy, where the list took a semicolon like a clause
  const file = tmpFile('list-then-these.md', [
    'purple gradients, instrument serif, "claude beige" \u2014 these are gravity wells.',
    'The reds, greens and blues \u2014 those are the colors.',
    // a real clause before "these" still starts a new one
    'We shipped the fix \u2014 these are the notes.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'purple gradients, instrument serif, "claude beige": these are gravity wells.',
    'The reds, greens and blues: those are the colors.',
    'We shipped the fix; these are the notes.',
  ]);
});

test('fix gives a script header comment that names its own file a colon', () => {
  // from the deterministic task scripts, where the name took a comma
  const file = tmpFile('header.js', [
    '#!/usr/bin/env node',
    '// det/changelog.js \u2014 build a grouped changelog from commit history.',
    '',
    '// Plain words \u2014 nothing to define here, so the comma stays.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '// det/changelog.js: build a grouped changelog from commit history.',
    '// Plain words, nothing to define here, so the comma stays.',
  ]);
});

test('fix drops a dash just inside an opening italic or bold mark at line start', () => {
  // from the agents page, where the credit kept a comma after the mark
  const file = tmpFile('mark-dash.md', [
    '*\u2014 an agent who tried it*',
    '',
    '**\u2014 the team**',
    '',
    '- _\u2014 someone_',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '*an agent who tried it*',
    '**the team**',
    '- _someone_',
  ]);
});

test('fix moves a dash just inside an opening mark mid-line out of the mark', () => {
  // the comma used to land inside the mark: "Ship it *, now*"
  const file = tmpFile('mark-dash-mid.md', [
    'Ship it *\u2014 now*.',
    '',
    'Ship it **\u2014 today**, then rest.',
    '',
    'Ship it _\u2014 now_ and go.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'Ship it, *now*.',
    'Ship it, **today**, then rest.',
    'Ship it, _now_ and go.',
  ]);
});

test('fix moves a dash just inside a closing mark out of the mark', () => {
  // the comma and a stray space used to land inside: "*now, * then rest"
  const file = tmpFile('mark-dash-close.md', [
    'Ship it *now \u2014* then rest.',
    '',
    'We ship _fast \u2014_ always.',
    '',
    'Ship it \u2014*now* please.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'Ship it *now*, then rest.',
    'We ship _fast_, always.',
    'Ship it, *now* please.',
  ]);
});

test('fix gives a pair of dashes around one emphasized word commas', () => {
  // one stressed word read as a bracketed aside: "We ship (*fast*) every day"
  const file = tmpFile('mark-dash-pair.md', [
    'We ship *\u2014 fast \u2014* every day.',
    '',
    'The gate \u2014 **always** \u2014 blocks it.',
    '',
    'The gate \u2014 *the one CI runs* \u2014 blocks it.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'We ship, *fast*, every day.',
    'The gate, **always**, blocks it.',
    'The gate (*the one CI runs*) blocks it.',
  ]);
});

test('fix gives a pair of dashes around a lone how-often word commas', () => {
  // "always" read as a bracketed aside: "The gate (always) blocks it"
  const file = tmpFile('adverb-dash-pair.md', [
    'The gate \u2014 always \u2014 blocks it.',
    '',
    'It will \u2014 eventually \u2014 ship.',
    '',
    'The tool \u2014 Redis \u2014 runs it.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'The gate, always, blocks it.',
    'It will, eventually, ship.',
    'The tool (Redis) runs it.',
  ]);
});

test('fix gives a pair of dashes around a short stock phrase commas', () => {
  // "of course" read as a bracketed aside: "It works (of course) on day one"
  const file = tmpFile('stock-dash-pair.md', [
    'It works \u2014 of course \u2014 on day one.',
    '',
    'We keep it \u2014 for now \u2014 as is.',
    '',
    'The tool \u2014 in fact Redis \u2014 runs it.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'It works, of course, on day one.',
    'We keep it, for now, as is.',
    'The tool (in fact Redis) runs it.',
  ]);
});

test('fix gives a pair of dashes around a lone linking word commas', () => {
  // "however" read as a bracketed aside: "Ship it (however) when green"
  const file = tmpFile('link-dash-pair.md', [
    'Ship it \u2014 however \u2014 when green.',
    '',
    'The gate \u2014 too \u2014 blocks it.',
    '',
    'Ship it \u2014 however late \u2014 today.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'Ship it, however, when green.',
    'The gate, too, blocks it.',
    'Ship it (however late) today.',
  ]);
});

test('fix reads no word that only says when as the subject of a clause', () => {
  // "now ships" after a dash read as a bare subject and a verb
  const file = tmpFile('when-word.md', [
    'The tool we built \u2014 now ships to everyone.',
    'The fix we wrote \u2014 already runs in CI.',
    // a real bare subject still starts its own clause
    'We ran it \u2014 nothing breaks now.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'The tool we built, now ships to everyone.',
    'The fix we wrote, already runs in CI.',
    'We ran it; nothing breaks now.',
  ]);
});

test('fix gives a line-end dash a semicolon when the next line opens a new clause', () => {
  // from the Orb member file, where the wrap hid a comma splice
  const file = tmpFile('line-end-clause.md', [
    'Created from a live interview with Keshav, 2026-07-04. Re-interview to amend \u2014',
    'this is a living file.',
    '',
    // any other opening word may finish the subject above, so the comma stays
    'The tool we built \u2014',
    'now ships to everyone.',
    '',
    'The question: "how are we converting them \u2014',
    'where are they this week?"',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'Created from a live interview with Keshav, 2026-07-04. Re-interview to amend;',
    'The tool we built,',
    'The question: "how are we converting them,',
  ]);
});

test('fix ends a paragraph-ending dash with a period, keeps a wrapping one a comma', () => {
  const file = tmpFile('line-end.md', [
    'The tool we built \u2014',
    'now ships to everyone.',
    '',
    'We tried it and it held \u2014',
    '',
    'Is it done? \u2014',
    'The last line ends here \u2014',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'The tool we built,',
    'We tried it and it held.',
    'Is it done?',
    'The last line ends here.',
  ]);
});

test('fix leaves a dash alone in brackets or quotes, since it names the mark', () => {
  // a style guide line in a sibling repo came out "No em dashes (: ) unless"
  const file = tmpFile('names.md', [
    '- [ ] No em dashes (\u2014) unless direct quote or title separator',
    'The mark "\u2014" is banned \u2014 use a comma.',
    'A [\u2014] cell \u2014 it means nothing.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'The mark "\u2014" is banned; use a comma.',
    'A [\u2014] cell; it means nothing.',
  ]);
});

test('fix drops a pair of dashes pressed inside a bracket', () => {
  const file = tmpFile('inside.md', [
    'Ship it (\u2014 maybe \u2014) now.',
    'See the list [\u2014 draft \u2014].',
    'Ship it (soon \u2014 maybe \u2014) now.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'Ship it (maybe) now.',
    'See the list [draft].',
    'Ship it (soon, maybe) now.',
  ]);
});

test('fix joins a bare subject and a verb that moves toward a place with a semicolon', () => {
  // from the craftpad repo, where the comma made a splice
  const file = tmpFile('bare.md', [
    'Blocks use `overflow: hidden` \u2014 content clips to the bounding box.',
    'The sheet is live \u2014 data flows into it every hour.',
    'We ship the page \u2014 content blocks on the side.',
    'See the setup \u2014 quickly moves to the end.',
    // one plain word after the verb that ends the sentence counts too
    'These are not build errors \u2014 xcodebuild compiles fine.',
    '- **inject a constraint** \u2014 "monochrome only," "one font weight" \u2014 scarcity forces creativity',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'Blocks use `overflow: hidden`; content clips to the bounding box.',
    'The sheet is live; data flows into it every hour.',
    'We ship the page, content blocks on the side.',
    'See the setup, quickly moves to the end.',
    'These are not build errors; xcodebuild compiles fine.',
    '- **inject a constraint**: "monochrome only," "one font weight"; scarcity forces creativity',
  ]);
});

test('fix keeps a colon before a dash pair and stacks no comma on it', () => {
  // from the terrace repo, which came out "T35b:, DONE"
  const file = tmpFile('stack.md', [
    'I reviewed "T35b: \u2014 DONE 2026-06-11 (navigator) \u2014 Name the resetter".',
    'The gate \u2014 strict (very) \u2014 held.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'I reviewed "T35b: DONE 2026-06-11 (navigator), Name the resetter".',
    'The gate, strict (very), held.',
  ]);
});

test('fix joins a subject with a "not" contraction or "still" before its verb with a semicolon', () => {
  // from the terrace repo, where the comma made a splice
  const file = tmpFile('adverb.md', [
    'The tests ran on unchecked bullets \u2014 the picker can\'t see DONE state.',
    'Hand it to the skill \u2014 the member still owns verification.',
    'Run it and wait \u2014 a one-shot session never wakes again.',
    'Atris owns the report \u2014 the same surface that already runs agent work.',
    'Keep the list \u2014 the files still open.',
    // the "the" may be left off; a joining word is no subject
    'PR #59 merged \u2014 review queue now loads each item.',
    'Two helpers survived \u2014 `findAppsTab` still reached for the tab bar.',
    'Trigger it as sections enter \u2014 but don\'t mess with scroll speed.',
    'It computes a leaderboard \u2014 not just likes.',
    // after a plural, a verb with no "s" counts when more words follow it
    'Goal still pursuing \u2014 diminishing returns now suggest moving on.',
    'Check whether the flag is set \u2014 dead sheets still cause conflicts.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'The tests ran on unchecked bullets; the picker can\'t see DONE state.',
    'Hand it to the skill; the member still owns verification.',
    'Run it and wait; a one-shot session never wakes again.',
    'Atris owns the report, the same surface that already runs agent work.',
    'Keep the list, the files still open.',
    'PR #59 merged; review queue now loads each item.',
    'Two helpers survived; `findAppsTab` still reached for the tab bar.',
    'Trigger it as sections enter, but don\'t mess with scroll speed.',
    'It computes a leaderboard, not just likes.',
    'Goal still pursuing; diminishing returns now suggest moving on.',
    'Check whether the flag is set; dead sheets still cause conflicts.',
  ]);
});

test('fix joins "each", its noun and a verb in "s" after a dash with a semicolon', () => {
  // from the terrace repo, where the comma made a splice
  const file = tmpFile('each.md', [
    'Started the loop (15m) \u2014 each tick re-reads the latest logs for new items.',
    'Events are a proxy \u2014 each completed Magic Circle session writes a summary.',
    'Two reviewers looked \u2014 each signs off on the merge.',
    // no "the" or place word may sit before the verb
    'The cache warms up \u2014 each time the loop runs.',
    'The repos are split \u2014 each with its own tests folder.',
    // "each time" or "every time" opens a "when" clause, not a subject
    'The cache warms up \u2014 each time the loop runs it.',
    'The cache warms up \u2014 every time the loop runs it.',
    'The cache warms up \u2014 each time CI runs the suite.',
    'The cache warms up \u2014 every time CI still runs the suite.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'Started the loop (15m); each tick re-reads the latest logs for new items.',
    'Events are a proxy; each completed Magic Circle session writes a summary.',
    'Two reviewers looked; each signs off on the merge.',
    'The cache warms up, each time the loop runs.',
    'The repos are split, each with its own tests folder.',
    'The cache warms up, each time the loop runs it.',
    'The cache warms up, every time the loop runs it.',
    'The cache warms up, each time CI runs the suite.',
    'The cache warms up, every time CI still runs the suite.',
  ]);
});

test('fix joins a plural and a common verb with more words after a dash with a semicolon', () => {
  // from the atris-cli, terrace and sfhq repos, where the comma made a splice
  const file = tmpFile('plural.md', [
    'Backgrounds set mood \u2014 flat backgrounds say "I didn\'t think about this."',
    'The deploy gate is disabled \u2014 master merges do NOT reach prod by themselves.',
    'The group needs no build assignment \u2014 new VALID builds appear automatically.',
    // a "the", a plural before a noun, or a short name after a semicolon stays
    'Read the board \u2014 the changes users need first.',
    'Keep the list \u2014 build logs, test runs and receipts.',
    'Six defects; the big one \u2014 audit rows carry no identity.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'Backgrounds set mood; flat backgrounds say "I didn\'t think about this."',
    'The deploy gate is disabled; master merges do NOT reach prod by themselves.',
    'The group needs no build assignment; new VALID builds appear automatically.',
    'Read the board, the changes users need first.',
    'Keep the list, build logs, test runs and receipts.',
    'Six defects; the big one, audit rows carry no identity.',
  ]);
});

test('fix joins a "the" subject and a verb that is rarely a noun after a dash with a semicolon', () => {
  const file = tmpFile('rare-verb.md', [
    'Keep it short \u2014 the config lives in one file.',
    'It is simple \u2014 the answer appears in the log.',
    'We moved it \u2014 the signing key belongs to the team now.',
    'Read the notes \u2014 the rule applies to every file.',
    // a pronoun before the verb, "of" after it, or no words after it stays
    'Open the folder \u2014 the file it belongs to.',
    'We read the book \u2014 the private lives of founders.',
    'Ship it \u2014 the config lives.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'Keep it short; the config lives in one file.',
    'It is simple; the answer appears in the log.',
    'We moved it; the signing key belongs to the team now.',
    'Read the notes; the rule applies to every file.',
    'Open the folder, the file it belongs to.',
    'We read the book, the private lives of founders.',
    'Ship it, the config lives.',
  ]);
});

test('fix keeps the comma when a plain word and a name sit before the verb', () => {
  // from a research note, where "a topic Atris sits on top of" names a topic
  const file = tmpFile('name-verb.md', [
    'Agents work offline now \u2014 a topic Atris sits directly on top of.',
    'We cut the list \u2014 the release Keshav approves quickly before launch.',
    // a run of capitals is no name, so the clause still joins
    'The lookup is fixed \u2014 the new CLI resolves the prefix.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'Agents work offline now, a topic Atris sits directly on top of.',
    'We cut the list, the release Keshav approves quickly before launch.',
    'The lookup is fixed; the new CLI resolves the prefix.',
  ]);
});

test('fix never pairs two dashes across a table cell border', () => {
  // from planning tables, which came out "HIGH (improves all output | HIGH) unique"
  const file = tmpFile('table.md', [
    '| 1 | /copy-edit skill | 2-3h | HIGH \u2014 improves all output | HIGH \u2014 unique, no equivalent |',
    '| What it is | Hosted RL \u2014 bring your own envs | Self-hosted RL \u2014 the backend captures runs |',
    // a pair inside one cell is still an aside
    '| Gate | the strict one \u2014 the one CI runs \u2014 holds | done |',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '| 1 | /copy-edit skill | 2-3h | HIGH: improves all output | HIGH: unique, no equivalent |',
    '| What it is | Hosted RL, bring your own envs | Self-hosted RL, the backend captures runs |',
    '| Gate | the strict one (the one CI runs) holds | done |',
  ]);
});

test('fix reads each table cell on its own, like the start of a block', () => {
  // from planning tables, where rules read across cell borders
  const file = tmpFile('cells.md', [
    '| R3 \u2014 pick customer + workflow | Yes \u2014 this is the cleanest signal | \u2014 (none) |',
    '| `toastCopy.test.ts` \u2014 13 tests for toast copy | HIGH \u2014 confirmed hiring March 2026 |',
    '| 9 | Kael\'s father Dol \u2014 the parallel that connects the men | KEEP |',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '| R3: pick customer + workflow | Yes, this is the cleanest signal | (none) |',
    '| `toastCopy.test.ts`: 13 tests for toast copy | HIGH: confirmed hiring March 2026 |',
    '| 9 | Kael\'s father Dol, the parallel that connects the men | KEEP |',
  ]);
});

test('fix keeps the right border of a drawn box in line', () => {
  // a dash is three characters with its spaces and a comma two, so every boxed
  // line used to come out one column short of the border above it
  const B = '\u2502';
  const file = tmpFile('box.md', [
    `${B} STEP 1/5 \u2014 Creating middleware      ${B}`,
    `${B}         ${B} 1. BUILD  \u2014 Does it compile?            ${B}             ${B}`,
    `${B}  0. RESUME     \u2014 read previous logs     ${B}`,
  ].join('\n'));
  const { changes } = applyFixes([file], RULES, { write: false });
  assert.deepEqual(changes.map((c) => c.after), [
    `${B} STEP 1/5, Creating middleware       ${B}`,
    `${B}         ${B} 1. BUILD    Does it compile?            ${B}             ${B}`,
    `${B}  0. RESUME       read previous logs     ${B}`,
  ]);
  for (const c of changes) assert.equal(c.after.length, c.before.length);
});

test('fix turns a padded dash into spaces so a column of descriptions stays in line', () => {
  // a folder tree came out "people/, one page" beside "schema.md: page
  // conventions", the column gone and the marks mixed; two spaces after a
  // long phrase is a typo in a sentence and keeps the usual fix, and a
  // list marker alone before the padding names nothing, so its dash just goes
  const file = tmpFile('columns.md', [
    '\u251c\u2500\u2500 people/            \u2014 one page per human being',
    '\u251c\u2500\u2500 schema.md          \u2014 page conventions, templates, workflows',
    '/atris-do           \u2014 Executor: build step-by-step',
    '\u251c\u2500\u2500 permissions: text[]  \u2014 execute, read_secrets, emit_output',
    '4. Latest team member log for the horizon  \u2014 prior handoff',
    '-  \u2014 jidapa@pallet.com',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES, { write: false });
  assert.deepEqual(changes.map((c) => c.after), [
    '\u251c\u2500\u2500 people/              one page per human being',
    '\u251c\u2500\u2500 schema.md            page conventions, templates, workflows',
    '/atris-do             Executor: build step-by-step',
    '\u251c\u2500\u2500 permissions: text[]    execute, read_secrets, emit_output',
    '4. Latest team member log for the horizon: prior handoff',
    '- jidapa@pallet.com',
  ]);
  for (const c of changes.slice(0, 4)) assert.equal(c.after.length, c.before.length);
});

test('fix keeps a scorecard line readable field by field', () => {
  // the scorecard reader needs a hyphen between every field; the fix used to
  // keep only the first one and turn the rest into commas, so it read nothing
  const { getScorecardsPath, readScorecards } = require('../lib/scorecard');
  const atrisDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-scorecard-'));
  const file = getScorecardsPath(atrisDir);
  fs.writeFileSync(file, '- **[2026-04-11] check-before-acting** \u2014 shipped: 2/3 \u2014 wall-clock: 5.3h \u2014 halt: 0% \u2014 reward: 12 \u2014 lessons: 2\n');
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), ['- **[2026-04-11] check-before-acting** - shipped: 2/3 - wall-clock: 5.3h - halt: 0% - reward: 12 - lessons: 2']);
  assert.deepEqual(readScorecards(atrisDir).map((s) => [s.slug, s.tasksShipped, s.wallClockHours, s.totalReward, s.lessonsGenerated]), [['check-before-acting', 2, 5.3, 12, 2]]);
});

test('fix leaves a bold task title readable to the task list', () => {
  // the fix writes "**Title**: text"; the task-list reader took only a dash
  // there and read the title back as "Title - : text"
  const { parseSection } = require('../lib/todo-fallback');
  const file = tmpFile('TODO.md', [
    '## Backlog',
    '- **T1:** **Fix the picker** \u2014 stop it reselecting done work',
    '- **T2:** [endgame] **Ship docs** \u2014 one \u2014 two',
    '- **T3:** **Polling**, not SSE \u2014 it reads status on a timer',
  ].join('\n'));
  applyFixes([file], RULES);
  assert.deepEqual(parseSection(fs.readFileSync(file, 'utf8'), 'Backlog').map((t) => t.title), [
    'Fix the picker - stop it reselecting done work',
    'Ship docs - one, two',
    'Polling, not SSE: it reads status on a timer',
  ]);
});

test('fix leaves a file reference note readable to the ref healer', () => {
  // the fix writes "`path:N`: `name` does X"; the healer took the name only
  // after a dash or a bracket, so a moved ref it used to heal came up nameless
  const { healBrokenMapRefs } = require('../commands/clean');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-heal-'));
  fs.mkdirSync(path.join(dir, 'atris'));
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'lib', 'plug.js'), '// header\n'.repeat(7) + 'function buildPlugin() {}\n');
  const map = path.join(dir, 'atris', 'MAP.md');
  fs.writeFileSync(map, '- `lib/plug.js:1` \u2014 `buildPlugin` packages the skills\n');
  applyFixes([map], RULES);
  assert.equal(fs.readFileSync(map, 'utf8'), '- `lib/plug.js:1`: `buildPlugin` packages the skills\n');
  assert.equal(healBrokenMapRefs(dir, path.join(dir, 'atris')).healed, 1);
  assert.equal(fs.readFileSync(map, 'utf8'), '- `lib/plug.js:8`: `buildPlugin` packages the skills\n');
});

test('fix gives a file reference the colon before the code it points at, past a label', () => {
  // the line already holds a label colon, so the fix wrote a comma or a
  // semicolon and the map healer lost the name after the reference
  const file = tmpFile('notes.md', [
    '**Write path:** `commands/autopilot.js:25` \u2014 `PHASE_TIMEOUT = 600000` (10 min per phase)',
    '- Real data contract verified: `services/credits.py:35` \u2014 `AUDIT_SOURCES` has 4 sources.',
    '- `people/`    \u2014 `notes.md` per person',
    '**Write path:** `the plan` \u2014 `step one` first',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES, { write: false });
  assert.deepEqual(changes.map((c) => c.after), [
    '**Write path:** `commands/autopilot.js:25`: `PHASE_TIMEOUT = 600000` (10 min per phase)',
    '- Real data contract verified: `services/credits.py:35`: `AUDIT_SOURCES` has 4 sources.',
    '- `people/`      `notes.md` per person',
    '**Write path:** `the plan`, `step one` first',
  ]);
});

test('fix joins a short subject and a verb that ends its clause with a semicolon', () => {
  // "the brain stays" is a whole clause with nothing after the verb; the
  // fix used to splice it on with a comma. "no code changes" names a thing.
  const file = tmpFile('clause-end.md', [
    'Swap the model \u2014 the brain stays.',
    'Right now, every session vanishes \u2014 no reusable artifact remains.',
    'Rollback: N/A \u2014 no code changes; revert if needed.',
    'Pick the tool \u2014 the one that works.',
  ].join('\n\n'));
  const { changes } = applyFixes([file], RULES, { write: false });
  assert.deepEqual(changes.map((c) => c.after), [
    'Swap the model; the brain stays.',
    'Right now, every session vanishes; no reusable artifact remains.',
    'Rollback: N/A, no code changes; revert if needed.',
    'Pick the tool, the one that works.',
  ]);
});

test('fix joins a clause whose helper is in capitals like one in lowercase', () => {
  // "IS" in capitals is stress on the same verb; the fix used to read it as
  // a strange word and splice the clause on with a comma
  const file = tmpFile('caps-helper.md', [
    'Form labels are unnecessary \u2014 the placeholder IS the label.',
    'Hypothesis verified \u2014 circuit breaker DOES write its summary.',
    'Not a widget \u2014 the weather IS the screen.',
  ].join('\n\n'));
  const { changes } = applyFixes([file], RULES, { write: false });
  assert.deepEqual(changes.map((c) => c.after), [
    'Form labels are unnecessary; the placeholder IS the label.',
    'Hypothesis verified; circuit breaker DOES write its summary.',
    'Not a widget: the weather IS the screen.',
  ]);
});

test('fix stacks no comma on a quoted question when the sentence goes on', () => {
  // the question mark already does the comma's job: 'asked "why not build
  // it?" and the answer' read '?", and'. A new clause keeps its comma, since
  // without one 'ask "anything else?" bring up the bid' runs on.
  const file = tmpFile('asked.md', [
    'They asked "why not build in-house?" \u2014 and the answer landed.',
    'The message is no longer "what would you like to do?" \u2014 is it:',
    'The standard is "would you sign this?" \u2014 yes.',
    'Never ask "anything else?" \u2014 bring up the next bid.',
  ].join('\n\n'));
  const { changes } = applyFixes([file], RULES, { write: false });
  assert.deepEqual(changes.map((c) => c.after), [
    'They asked "why not build in-house?" and the answer landed.',
    'The message is no longer "what would you like to do?" is it:',
    'The standard is "would you sign this?" yes.',
    'Never ask "anything else?", bring up the next bid.',
  ]);
});

test('fix closes the first half of a "when" or "if" sentence with a comma', () => {
  // a sentence that opens with "when" or "if" and has no comma yet is only
  // its first half; the fix used to cut it with a semicolon. A comma already
  // there, even inside a quote, closed that half, so the clause still joins.
  const file = tmpFile('opening-half.md', [
    'When Sushanth asks "how is the pipeline?" \u2014 you answer with numbers.',
    'If an animation does not do at least one \u2014 remove it.',
    'If a loop needs "external proof," it must ask the owner \u2014 it may not pick one.',
  ].join('\n\n'));
  const { changes } = applyFixes([file], RULES, { write: false });
  assert.deepEqual(changes.map((c) => c.after), [
    'When Sushanth asks "how is the pipeline?", you answer with numbers.',
    'If an animation does not do at least one, remove it.',
    'If a loop needs "external proof," it must ask the owner; it may not pick one.',
  ]);
});

test('fix gives a dash before "(a)" or "(1)" a colon, since a list follows', () => {
  // a run of lettered or numbered items is a list; the fix used to write
  // "caught 2 issues, (a) raw delta too weak"
  const file = tmpFile('enumerated.md', [
    '**Plan review:** caught 2 real issues \u2014 (a) raw delta too weak, (b) one seed only.',
    'Self-audit \u2014 (1) no fake numbers, (2) no skipped tests.',
  ].join('\n\n'));
  const { changes } = applyFixes([file], RULES, { write: false });
  assert.deepEqual(changes.map((c) => c.after), [
    '**Plan review:** caught 2 real issues: (a) raw delta too weak, (b) one seed only.',
    'Self-audit: (1) no fake numbers, (2) no skipped tests.',
  ]);
});

test('fix turns a dash that touches an arrowhead into the arrow\'s shaft', () => {
  // a dash right before ">" or after "<" draws an arrow; the fix split it
  // into "updated RN: > HUC" and a table cell "29: >29"
  const file = tmpFile('arrows.md', [
    'Updated RN \u2014> HUC on 1/2 (Seed \u2014> Series C).',
    '| 29\u2014>29 | 5\u2014>8 |',
    'Sync runs both ways: app <\u2014\u2014> server.',
  ].join('\n\n'));
  const { changes } = applyFixes([file], RULES, { write: false });
  assert.deepEqual(changes.map((c) => c.after), [
    'Updated RN -> HUC on 1/2 (Seed -> Series C).',
    '| 29->29 | 5->8 |',
    'Sync runs both ways: app <--> server.',
  ]);
});

test('fix keeps dashes pressed together between two boxes as the joining line', () => {
  // the line between two boxes collapsed into a comma: "[a], [b]"
  const file = tmpFile('box-line.md', [
    '    [a] \u2014\u2014\u2014 [b]',
    '    (start)\u2014\u2014(end)',
    'He said \u2014\u2014 nothing at all.',
  ].join('\n\n'));
  const { changes } = applyFixes([file], RULES, { write: false });
  assert.deepEqual(changes.map((c) => c.after), [
    '    [a] --- [b]',
    '    (start)--(end)',
    'He said, nothing at all.',
  ]);
});

test('fix keeps pressed dashes on a line indented like code as a drawn line', () => {
  // plain-word steps paired up as an aside: "plan (do) review"
  const file = tmpFile('indent-line.md', [
    '    plan \u2014\u2014\u2014 do \u2014\u2014\u2014 review',
    '     \u2014\u2014 [b]',
    '    one dash \u2014 here.',
  ].join('\n\n'));
  const { changes } = applyFixes([file], RULES, { write: false });
  assert.deepEqual(changes.map((c) => c.after), [
    '    plan --- do --- review',
    '     -- [b]',
    '    one dash, here.',
  ]);
});

test('fix keeps a journal heading that ends in a time readable for its hour', () => {
  // analytics reads the hour after a dash or a spaced hyphen at the end of a
  // heading; the fix wrote "### Watch: 19:05", which hides it, and glued
  // "### Tick 14 \u2014 21:25" into the range "Tick 14-21:25"
  const file = tmpFile('journal.md', [
    '### Tick 14 \u2014 21:25',
    '### Watch \u2014 19:05',
    '## Brainstorm Session \u2014 09:30:12',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES, { write: false });
  assert.deepEqual(changes.map((c) => c.after), ['### Tick 14 - 21:25', '### Watch - 19:05', '## Brainstorm Session - 09:30:12']);
  const hour = /^#{2,4} .*(?:\u2014|--| - )\s*(\d{2}):\d{2}(?::\d{2})?\s*$/;
  assert.deepEqual(changes.map((c) => hour.exec(c.after)?.[1]), ['21', '19', '09']);
});

test('fix keeps a dated lesson readable to the lesson tools', () => {
  // the lesson readers take a dash or a hyphen between slug, verdict and text;
  // the fix used to write "slug**: pass, The ..." or "slug** (pass) The ...",
  // which read back with no verdict or with a stray comma in the text
  const { parseLessons } = require('../lib/memory-view');
  const file = tmpFile('lessons.md', [
    '- **[2026-05-11] history-not-review** \u2014 pass \u2014 The dispatcher should not route to review.',
    '- **[2026-05-09] member-must-not-fallback** \u2014 fail \u2014 `brain activate` must stop \u2014 not guess.',
    '- **[2026-02-10] auth-duplication** \u2014 Auth logic exists in two places.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '- **[2026-05-11] history-not-review** - pass - The dispatcher should not route to review.',
    '- **[2026-05-09] member-must-not-fallback** - fail - `brain activate` must stop, not guess.',
    '- **[2026-02-10] auth-duplication** - Auth logic exists in two places.',
  ]);
  assert.deepEqual(parseLessons(fs.readFileSync(file, 'utf8')).map((l) => [l.id, l.status, l.text]), [
    ['history-not-review', 'pass', 'The dispatcher should not route to review.'],
    ['member-must-not-fallback', 'fail', '`brain activate` must stop, not guess.'],
    ['auth-duplication', '', 'Auth logic exists in two places.'],
  ]);
});

test('fix keeps the comma when "that" opens a clause inside the noun after a dash', () => {
  const file = tmpFile('that.md', [
    'Not a tool that stores your work \u2014 a computer that finishes it.',
    'Not a scanner that runs after the fact \u2014 a guard that blocks attacks.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'Not a tool that stores your work, a computer that finishes it.',
    'Not a scanner that runs after the fact, a guard that blocks attacks.',
  ]);
});

test('fix reads a word in "ed" as part of a noun and a helper at a line wrap as a verb', () => {
  // from planning notes, where "closed entries" read as a subject and a verb
  const file = tmpFile('wrap.md', [
    '| Other backlog \u2014 closed entries within | 35/186 closed |',
    'security company is the bigger market \u2014 deferred blocks to resume after',
    // a helper that ends a wrapped line leaves the clause open below
    'Nothing is broken \u2014 one request flag is',
    'set wrong in the config.',
    // a phrase that ends in "have" or "runs" is no open clause
    '| P3 | Minor cleanup, dead code, logging \u2014 nice to have |',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '| Other backlog, closed entries within | 35/186 closed |',
    'security company is the bigger market, deferred blocks to resume after',
    'Nothing is broken; one request flag is',
    '| P3 | Minor cleanup, dead code, logging, nice to have |',
  ]);
});

test('fix gives a field with a short value a comma instead of a second colon', () => {
  // from tick receipts, which came out "risk: none: verification only"
  const file = tmpFile('fields.md', [
    '- risk: none \u2014 verification only, nothing changed',
    '- sweep 2026-08-19T02:37:52Z: 16 green, 1 red \u2014 RED: code-health',
    '- state: nothing changed \u2014 the gate stays closed',
    // a longer value is a sentence its dash explains, and a plain label keeps its colon
    '- iMessage truth: the scheduled bridge never worked once \u2014 10,146 permission errors',
    '- Pattern recognition \u2014 detect mirroring rewards',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '- risk: none, verification only, nothing changed',
    '- sweep 2026-08-19T02:37:52Z: 16 green, 1 red, RED: code-health',
    '- state: nothing changed; the gate stays closed',
    '- iMessage truth: the scheduled bridge never worked once: 10,146 permission errors',
    '- Pattern recognition: detect mirroring rewards',
  ]);
});

test('fix reads a bold verdict as a clause, so a clause after it takes a semicolon', () => {
  // from build receipts, which came out "Result: **FAIL**, the repository has"
  const file = tmpFile('verdicts.md', [
    '- Result: **FAIL** \u2014 the repository has a generic context-packet surface',
    'Surface verdict: **PASS** \u2014 default status now fits the budget',
    // a fragment after the verdict only explains it, so it keeps its comma
    '- iPhone: **offline** \u2014 on-device validation deferred',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '- Result: **FAIL**; the repository has a generic context-packet surface',
    'Surface verdict: **PASS**; default status now fits the budget',
    '- iPhone: **offline**, on-device validation deferred',
  ]);
});

test('fix reads two subjects joined by "and" before a helper as a clause', () => {
  // from build notes, which came out "had no guard, render.py and render_reel.py are coupled"
  const file = tmpFile('and.md', [
    'Bottleneck: the reel regression had no guard \u2014 render.py and render_reel.py are coupled',
    '- Result: **FAIL** \u2014 the phone audit and control contract are absent',
    // "how" opens a phrase that explains the noun, so it keeps its comma
    'Humans are building a philosophy of work \u2014 how companies and agents should run together.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'Bottleneck: the reel regression had no guard; render.py and render_reel.py are coupled',
    '- Result: **FAIL**; the phone audit and control contract are absent',
    'Humans are building a philosophy of work, how companies and agents should run together.',
  ]);
});

test('fix reads "only" before a subject and its verb as a clause', () => {
  // from build notes, which came out "Tested 6 contact pages, only Austin exposed an email"
  const file = tmpFile('only.md', [
    'Tested 6 contact pages \u2014 only Austin exposed an email',
    '- Result: **FAIL** \u2014 only the build packet exists. No runner yet.',
    // with no verb, "only" narrows what came before, so these keep their comma
    '- LinkedIn Sales Nav \u2014 only if outbound live',
    'No private keys are stored in the database \u2014 only the wallet index and public address.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'Tested 6 contact pages; only Austin exposed an email',
    '- Result: **FAIL**; only the build packet exists. No runner yet.',
    '- LinkedIn Sales Nav: only if outbound live',
    'No private keys are stored in the database, only the wallet index and public address.',
  ]);
});

test('fix reads a short subject and a verb that reports a run as a clause', () => {
  // from build receipts, which came out "**FAIL**, context-package smoke suite passed (29 tests)"
  const file = tmpFile('status.md', [
    '- Result: **FAIL** \u2014 context-package smoke suite passed (29 tests), and dental did not',
    'Woke up clean \u2014 morning protocol held',
    // a count is a tally, and an adverb, an "ing" word or a list of states is no subject
    '- **result:** pass \u2014 3613 passed, 2 pre-existing failures',
    'The ledger mystery is closed \u2014 never deleted, never merged',
    'Cleanup done \u2014 verifying nothing broke.',
    'The report is unclear \u2014 show landed, failed, or waiting status',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '- Result: **FAIL**; context-package smoke suite passed (29 tests), and dental did not',
    'Woke up clean; morning protocol held',
    '- **result:** pass: 3613 passed, 2 pre-existing failures',
    'The ledger mystery is closed, never deleted, never merged',
    'Cleanup done, verifying nothing broke.',
    'The report is unclear: show landed, failed, or waiting status',
  ]);
});

test('fix gives a heading with a time in it a colon, but not one that is only a time', () => {
  // from tick logs, which came out "### Tick 4 (03:05-03:15 PDT); E1 activity rollup landed"
  const file = tmpFile('timed.md', [
    '### Tick 4 (03:05-03:15 PDT) \u2014 E1 activity rollup landed',
    '## 11:44 \u00b7 interface-dev tick \u2014 OBL-1931 shipped',
    // a colon after a bare time reads as seconds, and a heading never holds two
    '## 08:25 \u2014 orb evidence-pack run',
    '### 01:00 learn #11 \u2014 Self-Healing Metrics: How to measure it',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '### Tick 4 (03:05-03:15 PDT): E1 activity rollup landed',
    '## 11:44 \u00b7 interface-dev tick: OBL-1931 shipped',
    '## 08:25, orb evidence-pack run',
    '### 01:00 learn #11, Self-Healing Metrics: How to measure it',
  ]);
});

test('fix keeps the comma in a heading whose subtitle has its own colon', () => {
  // from daily logs, which came out "## 2026-02-21: Day 0: Agent Initialized"
  const file = tmpFile('twocolons.md', [
    '## 2026-02-21 \u2014 Day 0: Agent Initialized',
    '### 8. Nick Verity \u2014 SCORE: 8/10',
    // a colon with no space after it is part of a word, so this one still takes a colon
    '### health-loop tick 1 \u2014 design:review',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '## 2026-02-21, Day 0: Agent Initialized',
    '### 8. Nick Verity, SCORE: 8/10',
    '### health-loop tick 1: design:review',
  ]);
});

test('fix keeps the comma in a bold heading whose subtitle has its own colon', () => {
  // from design notes, which came out "**Server: Tier 1: WebRTC remote**"
  const file = tmpFile('boldtwo.md', [
    '**Server \u2014 Tier 1: WebRTC remote**',
    '**RC1 \u2014 Output budget: 1600 tokens per model round.**',
    '**Audit Gaps \u2014 Build Plan**',
  ].join('\n\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '**Server, Tier 1: WebRTC remote**',
    '**RC1, Output budget: 1600 tokens per model round.**',
    '**Audit Gaps: Build Plan**',
  ]);
});

test('fix gives a list after a one-word verdict a comma, not a second colon', () => {
  // from tick receipts, which came out "risk: none: read-only verification, no credits spent"
  const file = tmpFile('verdictlist.md', [
    '- risk: none \u2014 read-only verification, no credits spent, no task state mutated.',
    '  R2: PASS \u2014 file exists, content matches, op_log entry present',
    // any other value may be what the list spells out, so it keeps its colon
    '**What it protects:** All Postgres data \u2014 user conversations, agent configurations, schedules',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '- risk: none, read-only verification, no credits spent, no task state mutated.',
    '  R2: PASS, file exists, content matches, op_log entry present',
    '**What it protects:** All Postgres data: user conversations, agent configurations, schedules',
  ]);
});

test('fix starts the next sentence after a stop that sits before a dash', () => {
  // from the terrace repo, which came out "fine with try? the cost"
  const file = tmpFile('stop.md', [
    'Photo loading is fine with try? \u2014 the cost of handling the error exceeds the value.',
    'The build passed. \u2014 the log is clean.',
    'the build passed. \u2014 the log is clean.',
    'We kept the rest, etc. \u2014 the gate holds.',
    'It trails off... \u2014 the rest waits.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'Photo loading is fine with try? The cost of handling the error exceeds the value.',
    'The build passed. The log is clean.',
    'the build passed. the log is clean.',
    'We kept the rest, etc., the gate holds.',
    'It trails off... the rest waits.',
  ]);
});

test('fix joins a full clause and an order after a dash with a semicolon', () => {
  // from the five-repo sweep, where the comma made a splice
  const file = tmpFile('order.md', [
    'Pruning the worktree deletes proof \u2014 copy receipts out first.',
    'If it can\'t, the horizon is too far \u2014 pick a closer one.',
    'The field should hide while the user is searching \u2014 don\'t compete with their intent.',
    'Last updated: the store page (version 1.5) \u2014 copy drafted for 1.6.',
    '**Reply in thread (IMPORTANT \u2014 use this for all replies):**',
    'description: "AI Engine Optimization \u2014 write content that gets cited"',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'Pruning the worktree deletes proof; copy receipts out first.',
    'If it can\'t, the horizon is too far; pick a closer one.',
    'The field should hide while the user is searching; don\'t compete with their intent.',
    'Last updated: the store page (version 1.5), copy drafted for 1.6.',
    '**Reply in thread (IMPORTANT, use this for all replies):**',
    'description: "AI Engine Optimization, write content that gets cited"',
  ]);
});

test('fix keeps two numbers apart when they count down, since a range counts up', () => {
  // from the sfhq map, which came out "line 56-5 tabs"
  const file = tmpFile('down.md', [
    '- **MainTabView** \u2014 line 56 \u2014 5 tabs: Board, Guides',
    'We ran it 1990 \u2014 95 and it held.',
    '- pages 10 \u2014 20 cover setup',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '- **MainTabView**: line 56, 5 tabs: Board, Guides',
    'We ran it 1990-95 and it held.',
    '- pages 10-20 cover setup',
  ]);
});

test('fix starts the next sentence with a capital after a quote that ends its own', () => {
  // from the terrace runbook, which came out 'automatically." transactions stay'
  const file = tmpFile('quote-stop.md', [
    'The banner says "It will retry automatically." \u2014 transactions stay unfinished.',
    'It reads "Day 1. The start." \u2014 which is more shareable.',
    'the banner says "it will retry." \u2014 transactions stay unfinished.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'The banner says "It will retry automatically." Transactions stay unfinished.',
    'It reads "Day 1. The start." which is more shareable.',
    'the banner says "it will retry." transactions stay unfinished.',
  ]);
});

test('fix gives an order a colon after two words that name a thing', () => {
  // from atris-library, which came out "progressive disclosure; start simple"
  const file = tmpFile('named-order.md', [
    '**Interaction:** progressive disclosure \u2014 start simple, reveal complexity.',
    '*(none yet \u2014 add when you discover surprising failures)*',
    'Pruning the worktree deletes proof \u2014 copy receipts out first.',
    '- Piping it to head kills it before the',
    '  app-out write \u2014 run it to completion.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '**Interaction:** progressive disclosure: start simple, reveal complexity.',
    '*(none yet: add when you discover surprising failures)*',
    'Pruning the worktree deletes proof; copy receipts out first.',
    '  app-out write; run it to completion.',
  ]);
});

test('fix gives a clause a colon after a quoted term it explains', () => {
  // from atris-library, which came out '"Democratic dictatorship"; everyone
  // has a voice'. A quote inside a longer sentence keeps its semicolon.
  const file = tmpFile('quoted-term.md', [
    'Startups. "Democratic dictatorship" \u2014 everyone has a voice, the founder decides.',
    '\u201cFounder mode\u201d \u2014 it means you stay in the details.',
    'We named it "the gate" \u2014 it runs before every commit.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'Startups. "Democratic dictatorship": everyone has a voice, the founder decides.',
    '\u201cFounder mode\u201d: it means you stay in the details.',
    'We named it "the gate"; it runs before every commit.',
  ]);
});

test('fix gives a greeting a comma, on its own line or before the message', () => {
  // from dream-gtm's ready-to-send emails, which came out "Hey Mark." and
  // "Hey [Name]; I run an AI company"
  const file = tmpFile('greeting.md', [
    'Hey Mark \u2014',
    '',
    'Hey [Name] \u2014 I run an AI company that builds scheduling agents.',
    'Hi Tim, Amy \u2014 quick question.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'Hey Mark,',
    'Hey [Name], I run an AI company that builds scheduling agents.',
    'Hi Tim, Amy, quick question.',
  ]);
});

test('fix joins a second sentence led by "our" with a semicolon', () => {
  // from dream-gtm's outreach openers, which came out "Saw your recent post on
  // falls after rehab, our scheduling AI ensures reliable care"
  const file = tmpFile('possessive.md', [
    'Saw your recent post on falls after rehab \u2014 our scheduling AI ensures reliable care.',
    'Congrats on 16 years serving Pinellas \u2014 our AI tool could save you hours.',
    'We shipped the tool \u2014 our best work so far.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'Saw your recent post on falls after rehab; our scheduling AI ensures reliable care.',
    'Congrats on 16 years serving Pinellas; our AI tool could save you hours.',
    'We shipped the tool, our best work so far.',
  ]);
});

test('fix joins a direct question after a full clause with a semicolon', () => {
  // from dream-gtm's outreach openers, which came out "congrats on the Forbes
  // top 5 ranking, how do you handle growing demand?"
  const file = tmpFile('question.md', [
    'Congrats on the Forbes top 5 ranking \u2014 how do you handle growing demand?',
    'As an alum in your community, congrats on the ranking \u2014 what is next?',
    'I have never seen that scale. I have to ask \u2014 how do you manage all five?',
    'If you had those 20 hours back every week \u2014 where would they go?',
    'With island clients on Hilton Head, Folly Beach \u2014 does drive time matter?',
    'We keep two lists \u2014 what ships and what waits.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'Congrats on the Forbes top 5 ranking; how do you handle growing demand?',
    'As an alum in your community, congrats on the ranking; what is next?',
    'I have never seen that scale. I have to ask: how do you manage all five?',
    'If you had those 20 hours back every week, where would they go?',
    'With island clients on Hilton Head, Folly Beach, does drive time matter?',
    'We keep two lists, what ships and what waits.',
  ]);
});

test('fix joins "let\'s" after a full clause with a semicolon, like an order', () => {
  // from dream-gtm's outreach openers, which came out "Congrats on the 2023
  // Top Performer Award, let's discuss easing staffing pains"
  const file = tmpFile('lets.md', [
    'Congrats on the 2023 Top Performer Award \u2014 let\'s discuss easing staffing pains.',
    'Your mother\'s journey inspired your business \u2014 let us connect this week.',
    'Next steps \u2014 let\'s pick a day.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'Congrats on the 2023 Top Performer Award; let\'s discuss easing staffing pains.',
    'Your mother\'s journey inspired your business; let us connect this week.',
    'Next steps: let\'s pick a day.',
  ]);
});

test('fix gives a name that opens a quote a comma, like a greeting', () => {
  // from dream-gtm's personalization lines, which came out "Brian: covering
  // the Triad" after a bold label and "George, Nick; covering all of Milwaukee"
  const file = tmpFile('name-address.md', [
    '- **Personalization:** "Brian \u2014 covering the entire Triad is a 9-city operation."',
    '- **Personalization:** "George, Nick \u2014 covering all of Milwaukee County is a serious operation."',
    '- **Personalization:** "Dr. Tully-Coe \u2014 a PhD running an agency tells me you measure."',
    '- **Personalization:** "18 hours \u2014 how much of that is Sunday nights?"',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '- **Personalization:** "Brian, covering the entire Triad is a 9-city operation."',
    '- **Personalization:** "George, Nick, covering all of Milwaukee County is a serious operation."',
    '- **Personalization:** "Dr. Tully-Coe, a PhD running an agency tells me you measure."',
    '- **Personalization:** "18 hours: how much of that is Sunday nights?"',
  ]);
});

test('fix keeps the comma between two orders and joins a new order after a clause', () => {
  // from popshare and atrisos-web: "found across 5 repos, consolidate to one
  // place" is a splice, but two orders side by side are one sentence
  const file = tmpFile('paired-orders.md', [
    'Duplicate commands found across 5 repos \u2014 consolidate to one folder.',
    'They are the first thing a cleanup deletes \u2014 pin them.',
    '**Task:** Kill the process group at phase timeout \u2014 spawn the phase detached.',
    'don\'t cram everything into tight spacing \u2014 use dramatic gaps.',
    'Built `calendar-probe` \u2014 fork of relay-probe.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'Duplicate commands found across 5 repos; consolidate to one folder.',
    'They are the first thing a cleanup deletes; pin them.',
    '**Task:** Kill the process group at phase timeout, spawn the phase detached.',
    'don\'t cram everything into tight spacing, use dramatic gaps.',
    'Built `calendar-probe`, fork of relay-probe.',
  ]);
});

test('fix gives a run of "ing" phrases after a dash a colon, like a list', () => {
  // from hugolearn: "extracting what was learned" read as a subject and its
  // verb, so the list after the dash got a semicolon
  const file = tmpFile('ing-list.md', [
    'Sessions build on each other \u2014 extracting what was learned, understanding the progression, and intelligently suggesting the next topic.',
    'The gate held \u2014 nothing in the queue moved, everything stayed, and nothing broke.',
    'Ship the fix \u2014 testing it twice, then merging.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'Sessions build on each other: extracting what was learned, understanding the progression, and intelligently suggesting the next topic.',
    'The gate held; nothing in the queue moved, everything stayed, and nothing broke.',
    'Ship the fix, testing it twice, then merging.',
  ]);
});

test('fix puts a comma after an aside that closes an opening "if" or "when" clause', () => {
  // from hugolearn and dream-gtm: the closing dash also stood in for the comma
  // before the main clause, so "big enough (like X) that thing" lost it
  const file = tmpFile('opening-aside.md', [
    'I think that if the cluster is big enough \u2014 like continent-sized \u2014 that thing could be powerful.',
    'When customers feel part of something \u2014 a movement, a tribe \u2014 they stop comparing on price.',
    'Swarlo is the shared board \u2014 claims and locks \u2014 that lets agents share a repo.',
    'If it fails, the gate \u2014 the strict one \u2014 still holds.',
    'If the ideas turn out right \u2014 the ones we discussed \u2014 then we have something.',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'I think that if the cluster is big enough (like continent-sized), that thing could be powerful.',
    'When customers feel part of something (a movement, a tribe), they stop comparing on price.',
    'Swarlo is the shared board (claims and locks) that lets agents share a repo.',
    'If it fails, the gate (the strict one) still holds.',
    'If the ideas turn out right (the ones we discussed), then we have something.',
  ]);
});

test('a shorter or other-mark fence inside an example block stays code', () => {
  // a shorter fence inside a longer one is part of the example, so it never
  // ends the block and lets the fixer edit the example's code
  const D = String.fromCharCode(0x2014);
  const B = '`'.repeat(3);
  const file = tmpFile('nested-fence.md', [
    '`' + B + 'md',
    B + 'js',
    `run(); // pause ${D} then go`,
    B,
    `Keep the example ${D} it is literal.`,
    '`' + B,
    `The fixer leaves code alone ${D} it only edits prose.`,
    // a fence of the other mark is part of the example too, either way round
    '~~~md',
    B,
    `wait ${D} then ship`,
    B,
    '~~~',
    B + 'md',
    '~~~',
    `wait ${D} then ship`,
    '~~~',
    B,
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => [c.line, c.after]), [
    [7, 'The fixer leaves code alone; it only edits prose.'],
  ]);
  assert.deepEqual(scanFile(file).map((f) => f.line), [], 'the fixed file has nothing left to flag');
});

test('text indented under a list item is prose, not indented code', () => {
  // from terrace and the alpha-judge member file: nested bullets and wrapped
  // list text sit four or more spaces in, but they follow a list item, not a
  // blank line, so the fixer still edits them
  const D = String.fromCharCode(0x2014);
  const file = tmpFile('list-indent.md', [
    '*   **Response**: `SubscriptionStatus`',
    `    *   \`billing_conflict: bool\` ${D} \`true\` when both are active`,
    '   - innovation lane: true gaps get one paragraph each,',
    `     what it would cost ${D} presented to the operator.`,
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => [c.line, c.after]), [
    [2, '    *   `billing_conflict: bool`: `true` when both are active'],
    [4, '     what it would cost, presented to the operator.'],
  ], 'the fix keeps the indent');
});

test('fix gives a quote that opens a block or a list item a colon after its dash', () => {
  // from terrace: a quoted error or question opening the line is a term the
  // words after it explain; a quote on a wrapped line is mid-sentence
  const D = String.fromCharCode(0x2014);
  const file = tmpFile('quoted-opener.md', [
    `"Where does the byte actually stop?" ${D} traces the path before the theory.`,
    '',
    `- **Root cause:** "workspace personal doesn't exist" ${D} iOS tells the model its cwd.`,
    '',
    'Activity said "drop a pin" while its button said',
    `"Find people" ${D} now one voice.`,
    '',
    `"Go now" ${D} and she left.`,
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '"Where does the byte actually stop?": traces the path before the theory.',
    '- **Root cause:** "workspace personal doesn\'t exist": iOS tells the model its cwd.',
    '"Find people", now one voice.',
    '"Go now", and she left.',
  ]);
});

test('the fix diff script counts dashed lines and moves none against the same fixer', () => {
  const { spawnSync } = require('node:child_process');
  // a dashed line inside a fenced block is code the fix never touches, so it is not counted
  const dir = path.dirname(tmpFile('corpus.md', ['The build passed \u2014 the log is clean.', 'No dash here.', '```', 'people/   \u2014 one page', '```'].join('\n')));
  const script = path.join(__dirname, '..', 'scripts', 'slop-fix-diff.js');
  const r = spawnSync(process.execPath, [script, '--base', 'HEAD', dir], { encoding: 'utf8', cwd: path.join(__dirname, '..') });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^1 dashed line in 1 file; \d+ moved against HEAD$/m);
  assert.equal(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status, 2);
});

test('the fix diff script feeds whole paragraphs with --paragraphs', () => {
  const { spawnSync } = require('node:child_process');
  // a wrapped line that opens with a dash is fixed against the line above,
  // so it only shows up when both lines go in together; fenced code never does
  const dir = path.dirname(tmpFile('paragraphs.md', [
    'Run the specific checks below',
    '\u2014 these are the reward function.',
    '',
    'No dash in this one.',
    '```',
    'people/   \u2014 one page',
    '```',
  ].join('\n')));
  const script = path.join(__dirname, '..', 'scripts', 'slop-fix-diff.js');
  const r = spawnSync(process.execPath, [script, '--paragraphs', '--base', 'HEAD', dir], { encoding: 'utf8', cwd: path.join(__dirname, '..') });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^1 dashed paragraph in 1 file; \d+ moved against HEAD$/m);
});
