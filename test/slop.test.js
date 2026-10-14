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
  ].join('\n');
  const file = tmpFile('kinds.md', body);
  const { changes } = applyFixes([file], RULES, { write: false });
  assert.deepEqual(changes.map((c) => c.kind), [
    'parentheses', 'colon', 'comma', 'period', 'hyphen', 'parentheses + comma', 'dropped', 'comma',
  ]);
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { detect([file, '--dry-run']); } finally { console.log = orig; }
  const out = lines.join('\n');
  assert.match(out, /by kind: comma 2, parentheses 1, colon 1, period 1, hyphen 1, parentheses \+ comma 1, dropped 1/);
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
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'It works (mostly) fine.',
    'Pick one ((a) or (b)) then go.',
    'The tool (which we built) now ships.',
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
    '- **Done.** shipped',
    '- **Name**: what it does',
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
    'Run `atris slop detect`, it reports the tells.',
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
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '# Audit Gaps: Build Plan',
    '### Track A: `atris-cli`',
    '## What this is, and is not',
    '## Status: COMPLETE, both classes exhausted',
    'A plain line, not a heading',
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
    'It held. **What now?** we ship.',
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
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'Fast research sweep: arxiv, semantic scholar, github, web.',
    'Not just broken refs: ghost names, stale lessons, and dead code. Then stop.',
    'How execution flows: dev server startup, request lifecycle, build pipeline',
    'Works with Docs, Sheets, Slides, creates a full copy.',
    'It held, and we ran, tested, shipped.',
    'We tried, one, two, three times it failed here today and then.',
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
    'Plan 2 (and the gate) held up.',
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
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '- Retries (up to 3) happen automatically.',
    'Version 1.2 (released March 2026) adds rollback.',
    '- **Build**: run it, then ship.',
    '- Retries: up to 3. Then, it stops.',
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
  // from this repo's feature notes, policies, and the endgame skill
  const file = tmpFile('quote-end.md', [
    'He said "the gap is wiring." \u2014 PERSONA.md exists.',
    '"Connect them looking backward." \u2014 Steve Jobs',
    'Ask "what did we miss?" \u2014 Then read the calls.',
    'They think "who made this?" \u2014 that is the goal.',
    '- "What did we miss?" \u2014 summarizes calls',
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    'He said "the gap is wiring." PERSONA.md exists.',
    '"Connect them looking backward." Steve Jobs',
    'Ask "what did we miss?" Then read the calls.',
    'They think "who made this?", that is the goal.',
    '- "What did we miss?": summarizes calls',
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
  ].join('\n'));
  const { changes } = applyFixes([file], RULES);
  assert.deepEqual(changes.map((c) => c.after), [
    '**Source A: arxiv API**',
    '> **Source B: Semantic Scholar API**',
    '**Ship it, and say so**',
    '**Reply in thread (IMPORTANT, use this for all replies):**',
    'This is **a bold, phrase** in a line.',
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
    'It said "stop." (then it went) and left.',
    'Doubt (a failing check, a bad lesson) is a map.',
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
