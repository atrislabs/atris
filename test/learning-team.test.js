require('./helpers/clean-temp');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const learn = require('../lib/learning-team');
const { validateAgentReadableWikiPages, ensureWikiScaffold } = require('../lib/wiki');

const NOW = new Date('2026-11-08T18:00:00Z');

const ATOM = `<?xml version="1.0"?><feed>
<entry><id>http://arxiv.org/abs/2611.00001v1</id><published>2026-11-05T10:00:00Z</published>
<title>Guarding Agent Tools
 Against Injection</title><summary>We study agent security when tools read &amp; act on outside text.</summary></entry>
<entry><id>http://arxiv.org/abs/2601.00002v1</id><published>2026-01-02T10:00:00Z</published>
<title>Old agent security paper</title><summary>Too old for the window.</summary></entry>
<entry><id>not-a-paper</id><published>2026-11-05T10:00:00Z</published><title>Bad id</title><summary>x</summary></entry>
</feed>`;

const NEWS = { hits: [
  { objectID: '11', title: 'Agent security incident write-up', url: 'https://example.com/incident', points: 120, created_at: '2026-11-01T00:00:00Z', story_text: '' },
  { objectID: '12', title: 'Ask: agent security tips', url: null, points: 3, created_at: '2026-11-02T00:00:00Z', story_text: '<p>How do you sandbox <i>agents</i>?</p>' },
  { objectID: '13', title: 'Cooking pasta', url: 'https://example.com/pasta', points: 900, created_at: '2026-11-02T00:00:00Z' },
] };

const REPOS = { items: [
  { full_name: 'acme/agent-guard', html_url: 'https://github.com/acme/agent-guard', description: 'Policy checks for agent security', stargazers_count: 500, created_at: '2026-10-20T00:00:00Z', topics: ['security'] },
] };

function fakeFetch(url) {
  if (url.includes('arxiv')) return Promise.resolve({ ok: true, status: 200, text: ATOM });
  if (url.includes('algolia')) return Promise.resolve({ ok: true, status: 200, text: JSON.stringify(NEWS) });
  if (url.includes('github')) return Promise.resolve({ ok: true, status: 200, text: JSON.stringify(REPOS) });
  return Promise.resolve({ ok: false, status: 404, text: '' });
}

function engineAnswer(extra = {}) {
  return JSON.stringify({ notes: [
    { slug: 'gate-tools', title: 'Gate every tool call', rule: 'Check each tool call against an allow list \u2014 block the rest', open_when: 'you give an agent a tool that changes things.', points: ['S1 shows injection reaches tools (S1)'], example: 'A summary agent cannot call pay.', sources: ['S1', 'S9'], links: ['plant-faults'] },
    { slug: 'plant-faults', title: 'Plant faults in tests', rule: 'Test agents on planted bad inputs, and record what they do.', open_when: 'you set up an agent review', points: ['S2 describes a real incident (S2)'], example: 'A forged invoice in the test inbox.', sources: ['S2'], links: ['nope'] },
    { slug: 'scope-first', title: 'Scope first', rule: 'Write the allowed targets down first.', open_when: 'you start a scanning agent', points: [], example: '', sources: ['S3'], links: [] },
    { slug: 'no-source', title: 'Floating idea', rule: 'This cites nothing real.', sources: ['S42'] },
    ...(extra.more || []),
  ] });
}

test('arxiv atom parses entries, decodes text and skips non-paper ids', () => {
  const items = learn.parseArxivAtom(ATOM);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    kind: 'paper', title: 'Guarding Agent Tools Against Injection', url: 'https://arxiv.org/abs/2611.00001v1',
    date: '2026-11-05', summary: 'We study agent security when tools read & act on outside text.', popularity: 0,
  });
});

test('news hits fall back to the discussion link and strip html', () => {
  const items = learn.parseNewsHits(NEWS);
  assert.equal(items[1].url, 'https://news.ycombinator.com/item?id=12');
  assert.equal(items[1].summary, 'How do you sandbox agents ?');
  assert.equal(items[0].popularity, 120);
  assert.equal(learn.parseGithubRepos(REPOS)[0].summary, 'Policy checks for agent security. topics: security');
});

test('videos without upload dates get no date', () => {
  const rows = learn.parseVideoRows([{ title: 'Talk', channel: 'c', views: '1,200', url: 'https://youtu.be/abcdefghijk', upload_date: 'NA' }, { title: 'T2', url: 'https://youtu.be/abcdefghijl', upload_date: '20261101' }]);
  assert.equal(rows[0].date, '');
  assert.equal(rows[0].popularity, 1200);
  assert.equal(rows[1].date, '2026-11-01');
});

test('ranking keeps on-topic sources inside the window, drops repeats and alternates kinds', () => {
  const items = [
    ...learn.parseArxivAtom(ATOM),
    ...learn.parseNewsHits(NEWS),
    ...learn.parseGithubRepos(REPOS),
    { kind: 'paper', title: 'Guarding agent tools against injection', url: 'https://arxiv.org/abs/2611.99999', date: '2026-11-05', summary: 'agent security dup title' },
    { kind: 'video', title: 'agent security undated', url: 'https://youtu.be/x', date: '', summary: '' },
  ];
  const ranked = learn.rankSources(items, 'AI agent security', { days: 30, now: NOW });
  // The best kind leads each round: post, paper and repo. The second post comes last.
  assert.deepEqual(ranked.map((s) => s.url), [
    'https://example.com/incident',
    'https://arxiv.org/abs/2611.00001v1',
    'https://github.com/acme/agent-guard',
    'https://news.ycombinator.com/item?id=12',
  ]);
  assert.deepEqual(ranked.map((s) => s.id), ['S1', 'S2', 'S3', 'S4']);
  assert.ok(ranked.every((s) => typeof s.score === 'number'));
  assert.equal(learn.rankSources(items, 'AI agent security', { days: 30, now: NOW, max: 2 }).length, 2);
});

test('search links ask each source for recent items on the topic words', () => {
  const urls = learn.sourceUrls('AI agent security', { days: 30, perSource: 4, now: NOW });
  assert.equal(urls.paper, 'https://export.arxiv.org/api/query?search_query=all:agent+AND+all:security&sortBy=submittedDate&sortOrder=descending&max_results=12');
  assert.equal(urls.post, `https://hn.algolia.com/api/v1/search?query=AI%20agent%20security&tags=story&numericFilters=created_at_i>${Math.floor((NOW.getTime() - 30 * 86400000) / 1000)}&hitsPerPage=12`);
  assert.match(urls.repo, /q=agent%20security%20in%3Aname%2Cdescription%2Ctopics%20created%3A%3E2026-08-10&sort=stars/);
  assert.equal(learn.localDay(new Date(2026, 10, 8, 23, 30)), '2026-11-08');
});

test('topic words drop short and filler words', () => {
  assert.deepEqual(learn.topicWords('AI agent security for the latest tools'), ['agent', 'security', 'tools']);
  assert.equal(learn.topicSlug('AI Agent Security!'), 'ai-agent-security');
});

test('plain prose removes long dashes and commas before joining words', () => {
  assert.equal(learn.plainProse('Check calls \u2014 block the rest'), 'Check calls, block the rest');
  assert.equal(learn.plainProse('Test inputs, and record, which is fine, but slow'), 'Test inputs and record which is fine but slow');
});

test('engine answers are read from fenced or bare json', () => {
  assert.deepEqual(learn.extractJson('here:\n```json\n{"notes":[]}\n```'), { notes: [] });
  assert.deepEqual(learn.extractJson('noise {"a":1} tail'), { a: 1 });
  assert.equal(learn.extractJson('no json here'), null);
});

test('note checks drop unknown sources and links and fill a missing link', () => {
  const sources = [{ id: 'S1' }, { id: 'S2' }, { id: 'S3' }];
  const res = learn.validateNotes(JSON.parse(engineAnswer()), sources);
  assert.equal(res.ok, true);
  assert.deepEqual(res.notes.map((n) => n.slug), ['gate-tools', 'plant-faults', 'scope-first']);
  assert.deepEqual(res.notes[0].sources, ['S1']);
  assert.equal(res.notes[0].rule, 'Check each tool call against an allow list, block the rest.');
  assert.equal(res.notes[1].rule, 'Test agents on planted bad inputs and record what they do.');
  assert.deepEqual(res.notes[1].links, ['scope-first']);
  assert.deepEqual(res.notes[2].links, ['gate-tools']);
  assert.equal(res.notes[0].openWhen, 'you give an agent a tool that changes things');
  assert.ok(res.problems.some((p) => p.includes('Floating idea')));
});

test('note checks fail below three notes and cap at five', () => {
  const sources = [{ id: 'S1' }];
  const two = { notes: [{ title: 'A', rule: 'a', sources: ['S1'] }, { title: 'B', rule: 'b', sources: ['S1'] }] };
  assert.equal(learn.validateNotes(two, sources).ok, false);
  const seven = { notes: 'ABCDEFG'.split('').map((t) => ({ title: t, rule: t, sources: ['S1'] })) };
  const res = learn.validateNotes(seven, sources);
  assert.equal(res.ok, true);
  assert.equal(res.notes.length, 5);
  assert.equal(learn.validateNotes(null, sources).ok, false);
});

test('index update adds one learning line and replaces it on rerun', () => {
  const start = '# Atris Wiki Index\n\n## Concepts\n\n- keep me\n';
  const once = learn.updateIndexText(start, { slug: 'agent-security', line: '- first (briefs/agent-security.md)' });
  assert.match(once, /## Concepts\n\n- keep me\n\n## Learning\n\n- first \(briefs\/agent-security\.md\)\n$/);
  const twice = learn.updateIndexText(once, { slug: 'agent-security', line: '- second (briefs/agent-security.md)' });
  assert.equal(twice.match(/briefs\/agent-security\.md/g).length, 1);
  assert.ok(twice.includes('- second'));
  const other = learn.updateIndexText(twice, { slug: 'pricing', line: '- pricing (briefs/pricing.md)' });
  assert.match(other, /- second \(briefs\/agent-security\.md\)\n- pricing \(briefs\/pricing\.md\)/);
  assert.match(learn.updateIndexText('', { slug: 's', line: '- x (briefs/s.md)' }), /^# Atris Wiki Index/);
});

test('paid api keys never reach the engine', () => {
  const env = learn.paidKeyFreeEnv({ ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k', PATH: '/bin' });
  assert.deepEqual(env, { PATH: '/bin' });
});

test('args need a topic and sane numbers', () => {
  assert.throws(() => learn.parseLearnArgs([]), /give a topic/);
  assert.throws(() => learn.parseLearnArgs(['x', '--days', '0']), /--days/);
  assert.throws(() => learn.parseLearnArgs(['x', '--bogus']), /unknown flag/);
  const opts = learn.parseLearnArgs(['agent', 'security', '--into', '/tmp/w', '--no-video']);
  assert.equal(opts.topic, 'agent security');
  assert.equal(opts.into, '/tmp/w');
  assert.equal(opts.video, false);
});

function quietOutput() {
  const lines = [];
  return { lines, log: (l) => lines.push(String(l)), error: (l) => lines.push(`ERR ${l}`) };
}

test('a full run writes linked notes that pass the wiki contract and keeps earlier notes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-run-'));
  ensureWikiScaffold(root);
  let prompt = '';
  const deps = {
    cwd: root,
    now: NOW,
    output: quietOutput(),
    fetchText: fakeFetch,
    videoSearch: () => ({ ok: true, rows: [{ title: 'agent security talk', url: 'https://youtu.be/abcdefghijk', upload_date: 'NA' }] }),
    distill: async (p) => { prompt = p; return { ok: true, stdout: engineAnswer() }; },
  };
  const res = await learn.runLearn(['AI agent security'], deps);
  assert.equal(res.ok, true);
  assert.equal(res.notes, 3);
  assert.equal(res.credits, 0);
  assert.ok(res.misses.some((m) => m.kind === 'video' && /no upload dates/.test(m.reason)));
  assert.match(prompt, /\[S3\] repo, 2026-10-20: acme\/agent-guard\nurl: https:\/\/github\.com\/acme\/agent-guard/);
  assert.match(prompt, /\[S1\] post, 2026-11-01: Agent security incident write-up\nurl: https:\/\/example\.com\/incident\ntext: \(title only\)/);
  assert.match(prompt, /Use only these/);

  const wiki = path.join(root, 'atris', 'wiki');
  const note = fs.readFileSync(path.join(wiki, 'concepts', 'ai-agent-security', 'gate-tools.md'), 'utf8');
  assert.match(note, /^sources:\n {2}- https:\/\/example\.com\/incident$/m);
  assert.match(note, /- S1\. \[Agent security incident write-up\]\(https:\/\/example\.com\/incident\) \(\[discussion\]\(https:\/\/news\.ycombinator\.com\/item\?id=11\)\), post, 2026-11-01/);
  assert.match(note, /Back to \[AI agent security\]\(\.\.\/\.\.\/briefs\/ai-agent-security\.md\)/);
  assert.match(note, /\[Plant faults in tests\]\(plant-faults\.md\): open when you set up an agent review/);
  assert.ok(!/\u2014/.test(note));
  const brief = fs.readFileSync(path.join(wiki, 'briefs', 'ai-agent-security.md'), 'utf8');
  assert.match(brief, /Open when you give an agent a tool that changes things: \[Gate every tool call\]\(\.\.\/concepts\/ai-agent-security\/gate-tools\.md\)/);
  assert.match(brief, /## Could not read/);
  const index = fs.readFileSync(path.join(wiki, 'index.md'), 'utf8');
  assert.match(index, /## Learning\n\n- AI agent security \(2026-11-08\): Check each tool call/);
  assert.match(fs.readFileSync(path.join(wiki, 'log.md'), 'utf8'), /LEARN AI agent security: 3 notes from 4 sources/);

  const contract = validateAgentReadableWikiPages(root);
  assert.deepEqual(contract.findings, []);

  // A later run with different notes keeps the old ones listed in the brief.
  const later = JSON.stringify({ notes: [
    { slug: 'one', title: 'One', rule: 'One.', sources: ['S1'] },
    { slug: 'two', title: 'Two', rule: 'Two.', sources: ['S2'] },
    { slug: 'three', title: 'Three', rule: 'Three.', sources: ['S3'] },
  ] });
  const res2 = await learn.runLearn(['AI agent security'], { ...deps, distill: async () => ({ ok: true, stdout: later }) });
  assert.equal(res2.earlier, 3);
  const brief2 = fs.readFileSync(path.join(wiki, 'briefs', 'ai-agent-security.md'), 'utf8');
  assert.match(brief2, /## Earlier notes\n\n- Check each tool call against an allow list, block the rest\. \[Gate every tool call\]/);
  assert.equal(fs.readFileSync(path.join(wiki, 'index.md'), 'utf8').match(/briefs\/ai-agent-security\.md/g).length, 1);
});

test('nothing is written when the engine answer fails the checks', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-fail-'));
  const out = quietOutput();
  const res = await learn.runLearn(['AI agent security', '--no-video'], {
    cwd: root, now: NOW, output: out, fetchText: fakeFetch,
    distill: async () => ({ ok: true, stdout: '{"notes":[{"title":"x","rule":"y","sources":["S99"]}]}' }),
  });
  assert.equal(res.ok, false);
  assert.equal(fs.existsSync(path.join(root, 'atris', 'wiki', 'index.md')), false);
  assert.ok(out.lines.some((l) => l.includes('nothing was written')));
});

test('dry run and too few sources write nothing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-dry-'));
  const dry = await learn.runLearn(['AI agent security', '--dry-run', '--no-video'], { cwd: root, now: NOW, output: quietOutput(), fetchText: fakeFetch });
  assert.equal(dry.ok, true);
  assert.equal(dry.sources.length, 4);
  assert.equal(fs.existsSync(path.join(root, 'atris')), false);
  const none = await learn.runLearn(['AI agent security', '--no-video'], { cwd: root, now: NOW, output: quietOutput(), fetchText: async () => ({ ok: false, status: 503, text: '' }) });
  assert.equal(none.ok, false);
  assert.equal(none.reason, 'too few sources');
  assert.equal(none.misses.length, 3);
});

test('saved sources replay without the network', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-replay-'));
  await learn.runLearn(['AI agent security', '--dry-run', '--no-video', '--save-sources', 'saved.json'], { cwd: root, now: NOW, output: quietOutput(), fetchText: fakeFetch });
  fs.writeFileSync(path.join(root, 'answer.json'), engineAnswer());
  const res = await learn.runLearn(['AI agent security', '--sources', 'saved.json', '--notes', 'answer.json'], {
    cwd: root, now: NOW, output: quietOutput(), fetchText: () => { throw new Error('network used'); },
  });
  assert.equal(res.ok, true);
  assert.equal(res.notes, 3);
});
