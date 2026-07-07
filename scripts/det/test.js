#!/usr/bin/env node
// det/test.js — self-test for the deterministic task scripts.
// Zero deps, exits non-zero on any failure so CI and agents can trust the lib.
'use strict';

const assert = require('assert');
const extractModule = require('./extract');
const { extract } = extractModule;
const jsonModule = require('./json');
const { run } = jsonModule;
const text = require('./text');
const hash = require('./hash');
const date = require('./date');
const commitMsg = require('./commit-msg');
const changelog = require('./changelog');
const prDesc = require('./pr-description');
const { CATALOG, catalogJson, catalogText, GIT_SCRIPTS } = require('./det');

let passed = 0;
function check(name, actual, expected) {
  assert.deepStrictEqual(actual, expected, name);
  passed += 1;
}

// urls: strip trailing punctuation, dedupe, keep order
check(
  'urls',
  extract('urls', 'see https://a.com/x. and http://b.io, then https://a.com/x again'),
  ['https://a.com/x', 'http://b.io']
);

check('emails', extract('emails', 'a@b.com and c@d.co and a@b.com'), ['a@b.com', 'c@d.co']);

check(
  'code',
  extract('code', 'text\n```js\nconst x = 1;\n```\nmore\n```\nplain\n```'),
  ['const x = 1;', 'plain']
);

check('numbers', extract('numbers', 'got 1,234 items at 9.5 each, -3 lost'), ['1,234', '9.5', '-3']);

check('ipv4', extract('ipv4', 'from 192.168.0.1 not 999.1.1.1'), ['192.168.0.1']);

check('hashtags', extract('hashtags', 'ship #atris and #det #atris'), ['#atris', '#det']);

// unknown kind -> null
check('unknown', extract('nope', 'x'), null);

// empty input -> empty list
check('empty', extract('urls', ''), []);

// --- json.js ---
check('json.pretty', run('pretty', '{"a":1}'), { text: '{\n  "a": 1\n}' });
check('json.min', run('min', '{ "a" : 1 }'), { text: '{"a":1}' });
check('json.validate.ok', run('validate', '[1,2,3]'), { text: 'valid' });
check('json.validate.bad', run('validate', '{bad}').error !== undefined, true);
check('json.keys', run('keys', '{"a":1,"b":2}'), { text: 'a\nb' });
// csv: header from first-seen key order, proper RFC-4180 quoting of commas/quotes
check(
  'json.csv',
  run('csv', '[{"name":"a, b","n":1},{"name":"c\\"d","n":2}]'),
  { text: 'name,n\n"a, b",1\n"c""d",2' }
);
check('json.csv.notArray', run('csv', '{"a":1}').error !== undefined, true);
check('json.badMode', run('nope', '{}').error !== undefined, true);

// --- text.js ---
check('text.dedupe', text.run('dedupe', 'a\nb\na\nc'), { text: 'a\nb\nc' });
check('text.sort', text.run('sort', 'c\na\nb'), { text: 'a\nb\nc' });
check('text.rsort', text.run('rsort', 'a\nc\nb'), { text: 'c\nb\na' });
check('text.count', text.run('count', 'a b\nc'), { text: 'lines\t2\nwords\t3\nchars\t5' });
check('text.slug', text.slugify('Hello, World! 2026'), 'hello-world-2026');
check('text.slug.accents', text.slugify('Café Déjà Vu'), 'cafe-deja-vu');
check('text.trim', text.run('trim', 'a  \n\n  \nb'), { text: 'a\nb' });
check('text.empty', text.run('dedupe', ''), { text: '' });
check('text.badMode', text.run('nope', 'x').error !== undefined, true);

// --- hash.js ---
check('hash.b64', hash.run('b64', 'hi'), { text: 'aGk=' });
check('hash.b64.roundtrip', hash.run('b64d', hash.run('b64', 'hello').text), { text: 'hello' });
check('hash.sha256', hash.run('sha256', 'hi'), {
  text: '8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4',
});
check('hash.md5', hash.run('md5', 'hi'), { text: '49f68a5c8493ec2c0bf489821c21fc3b' });
check('hash.hex.roundtrip', hash.run('hexdec', hash.run('hexenc', 'yo').text), { text: 'yo' });
check('hash.newlineStripped', hash.run('b64', 'hi\n'), { text: 'aGk=' }); // echo == printf
check('hash.hexdec.bad', hash.run('hexdec', 'xyz').error !== undefined, true);
check('hash.badMode', hash.run('nope', 'x').error !== undefined, true);

// --- date.js ---
check('date.iso.sec', date.run('iso', '1700000000'), { text: '2023-11-14T22:13:20.000Z' });
check('date.iso.ms', date.run('iso', '1700000000000'), { text: '2023-11-14T22:13:20.000Z' });
check('date.epoch', date.run('epoch', '2026-07-07'), { text: '1783382400' });
check('date.epochms', date.run('epochms', '2026-07-07'), { text: '1783382400000' });
check('date.weekday', date.run('weekday', '2026-07-07'), { text: 'Tuesday' });
check('date.epoch0', date.run('iso', '0'), { text: '1970-01-01T00:00:00.000Z' });
check('date.utcPinned', date.run('epoch', '2026-07-07T00:00:00'), { text: '1783382400' }); // no zone -> UTC
check('date.bad', date.run('iso', 'not-a-date').error !== undefined, true);
check('date.badMode', date.run('nope', '0').error !== undefined, true);

// --- commit-msg.js (git-facing) ---
// type from paths: all under scripts/ -> chore, scope = deepest common dir
{
  const d = commitMsg.draft([
    { path: 'scripts/det/date.js', status: 'A', added: 90, deleted: 0 },
    { path: 'scripts/det/test.js', status: 'M', added: 11, deleted: 1 },
  ]);
  // names the lead (added) file, not an anonymous "update 2 files" count
  check('commit.subject', d.subject, 'chore(det): add date.js (+1 more)');
  check('commit.totals', d.totals, { added: 101, deleted: 1 });
  check('commit.body.stat', /2 files changed, \+101\/-1$/.test(d.body), true);
}
// lead file = biggest churn when nothing is added; tie broken by path
check(
  'commit.lead.churn',
  commitMsg.draft([
    { path: 'lib/a.js', status: 'M', added: 2, deleted: 1 },
    { path: 'lib/b.js', status: 'M', added: 40, deleted: 5 },
  ]).subject,
  'fix(lib): update b.js (+1 more)'
);
// added file wins over a higher-churn modified file
check(
  'commit.lead.added',
  commitMsg.leadFile([
    { path: 'lib/big.js', status: 'M', added: 99, deleted: 0 },
    { path: 'lib/new.js', status: 'A', added: 3, deleted: 0 },
  ]).path,
  'lib/new.js'
);
check(
  'commit.docs',
  commitMsg.draft([{ path: 'README.md', status: 'M', added: 3, deleted: 0 }]).subject,
  'docs: update README.md'
);
check(
  'commit.test',
  commitMsg.draft([{ path: 'test/foo.test.js', status: 'A', added: 5, deleted: 0 }]).subject,
  'test: add foo.test.js'
);
check(
  'commit.feat',
  commitMsg.draft([{ path: 'lib/parser.js', status: 'A', added: 40, deleted: 0 }]).subject,
  'feat(lib): add parser.js'
);
check(
  'commit.fix',
  commitMsg.draft([{ path: 'lib/parser.js', status: 'M', added: 2, deleted: 2 }]).subject,
  'fix(lib): update parser.js'
);
check('commit.scope.root', commitMsg.commonDirScope(['package.json']), '');
check('commit.empty', commitMsg.draft([]).error !== undefined, true);

// --- changelog.js (git-facing) ---
// header grammar: type(scope)!: subject -> parsed fields, breaking flagged
check('changelog.parse', changelog.parseSubject('feat(cli): add reel'), {
  type: 'feat',
  scope: 'cli',
  breaking: false,
  subject: 'add reel',
});
check('changelog.parse.bang', changelog.parseSubject('feat!: drop v1').breaking, true);
// unknown type -> "other" bucket, whole line kept (nothing dropped)
check('changelog.parse.unknown', changelog.parseSubject('wip: poke').type, 'other');
check('changelog.parse.freeform', changelog.parseSubject('just a note').subject, 'just a note');
{
  const r = changelog.build([
    { hash: 'a1', subject: 'feat(cli): add reel' },
    { hash: 'b2', subject: 'fix(det): guard empty range' },
    { hash: 'c3', subject: 'feat: add card' },
    { hash: 'd4', subject: 'chore!: bump major' },
  ]);
  // sections come back in SECTIONS order: feat before fix before chore
  check('changelog.order', r.sections.map((s) => s.type), ['feat', 'fix', 'chore']);
  check('changelog.counts', r.counts, { feat: 2, fix: 1, chore: 1 });
  check('changelog.breaking', r.breaking.length, 1);
  check('changelog.total', r.total, 4);
  // rendered markdown groups under human headings, breaking first
  const md = changelog.render(r);
  check('changelog.render.breaking', /^### ⚠ BREAKING CHANGES/.test(md), true);
  check('changelog.render.feat', md.includes('### Features'), true);
  check('changelog.render.item', md.includes('- add reel (cli) [a1]'), true);
}
check('changelog.empty', changelog.render(changelog.build([])), 'No changes.');
check('changelog.badInput', changelog.build('nope').error !== undefined, true);

// --- pr-description.js (git-facing) ---
// single commit -> title is that subject verbatim
check(
  'pr.title.one',
  prDesc.pickTitle([{ subject: 'feat(cli): add reel' }], [{ path: 'commands/reel.js', status: 'A' }]),
  'feat(cli): add reel'
);
// many commits -> dominant type + lead file (feat wins the tie by SECTIONS order)
check(
  'pr.title.many',
  prDesc.pickTitle(
    [{ subject: 'feat: a' }, { subject: 'fix: b' }, { subject: 'feat: c' }],
    [
      { path: 'lib/new.js', status: 'A', added: 3, deleted: 0 },
      { path: 'lib/old.js', status: 'M', added: 1, deleted: 1 },
    ]
  ),
  'feat: new.js (+1 more)'
);
// summary bullets: one per top-level area, first-seen order, with counts + churn
check(
  'pr.summary.areas',
  prDesc.areaBullets([
    { path: 'scripts/det/a.js', status: 'A', added: 10, deleted: 0 },
    { path: 'scripts/det/b.js', status: 'M', added: 2, deleted: 1 },
    { path: 'test/x.test.js', status: 'A', added: 5, deleted: 0 },
  ]),
  ['- **scripts** — 1 added, 1 changed (+12/-1)', '- **test** — 1 added (+5/-0)']
);
// test plan lists touched test files, then a check per non-test area
check(
  'pr.testplan',
  prDesc.testPlan([
    { path: 'scripts/det/a.js', status: 'M' },
    { path: 'scripts/det/test.js', status: 'M' },
  ]),
  [
    '- [ ] Run the touched tests:',
    '  - `scripts/det/test.js`',
    '- [ ] Exercise **scripts** and confirm no regression',
  ]
);
// no test files -> generic fallback line
check('pr.testplan.none', prDesc.testPlan([{ path: 'README.md', status: 'M' }]), [
  '- [ ] Exercise **.** and confirm no regression',
]);
{
  const r = prDesc.build({
    commits: [{ hash: 'a1', subject: 'feat(det): add pr-description.js' }],
    files: [{ path: 'scripts/det/pr-description.js', status: 'A', added: 100, deleted: 0 }],
  });
  const md = prDesc.render(r);
  check('pr.render.title', /^# feat\(det\): add pr-description\.js/.test(md), true);
  check('pr.render.summary', md.includes('## Summary'), true);
  check('pr.render.testplan', md.includes('## Test plan'), true);
  check('pr.render.stat', md.includes('1 commit, 1 file, +100/-0'), true);
}
check('pr.empty', prDesc.build({ commits: [], files: [] }).error !== undefined, true);

// --- det.js dispatcher ---
check('det.catalog', Object.keys(CATALOG).sort(), ['date', 'extract', 'hash', 'json', 'text']);
check('det.date.route', CATALOG.date.run('weekday', '2026-07-07'), { text: 'Tuesday' });
check('det.date.modes', CATALOG.date.modes, date.MODES);
check('det.hash.route', CATALOG.hash.run('b64', 'hi'), { text: 'aGk=' });
check('det.hash.modes', CATALOG.hash.modes, hash.MODES);
// every catalog entry advertises modes and routes to a working run()
check('det.extract.route', CATALOG.extract.run('emails', 'x a@b.com'), { text: 'a@b.com' });
check('det.json.route', CATALOG.json.run('min', '{ "a": 1 }'), { text: '{"a":1}' });
check('det.text.route', CATALOG.text.run('dedupe', 'a\na'), { text: 'a' });
check('det.badMode', CATALOG.extract.run('nope', 'x').error !== undefined, true);
// catalog modes must equal what each script actually exports (no drift)
check('det.extract.modes', CATALOG.extract.modes, Object.keys(extractModule.EXTRACTORS));
check('det.json.modes', CATALOG.json.modes, jsonModule.MODES);
check('det.text.modes', CATALOG.text.modes, text.MODES);
// git-facing scripts surface at the front door so all 8 tools are discoverable
check('det.git.names', GIT_SCRIPTS.map((g) => g.name), ['commit-msg', 'changelog', 'pr-description']);
check('det.git.text', catalogText().includes('git-facing') && catalogText().includes('pr-description'), true);
check('det.git.json', JSON.parse(catalogJson()).git['commit-msg'].usage.includes('commit-msg.js'), true);
// stdin catalog stays separate from the git list (routing must not mix them)
check('det.git.notRoutable', CATALOG['commit-msg'], undefined);

console.log(`ok — ${passed} checks passed`);
