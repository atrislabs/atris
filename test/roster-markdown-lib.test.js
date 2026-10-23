'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  ROSTER_NOTE,
  ROSTER_MARKDOWN_TEMPLATE,
  scanRosterMarkdown,
  jobSections,
  replaceJobSection,
  rewriteRosterValues,
  joinLines,
} = require('../lib/roster-markdown');

test('scan sorts lines into jobs, workers, team, notes, and comments', () => {
  const scan = scanRosterMarkdown([
    '# roster',
    '',
    '> a note for me',
    '<!-- skip me',
    'still skip -->',
    'build: opus 5.5',
    'just words',
    '- a bullet note',
    '-x',
    '',
    '## small build',
    '- haiku',
    '- codex, effort: medium',
    'a free note stays',
    '',
    '## team',
    'researcher: search',
    '- judge: opus 5.5',
    '- lone bullet no colon',
    '',
  ].join('\n'));

  assert.equal(scan.newline, '\n');
  assert.deepEqual(scan.headings.map((h) => [h.title, h.level, h.section]), [
    ['roster', 1, 'jobs'],
    ['small build', 2, 'job'],
    ['team', 2, 'team'],
  ]);

  const entries = scan.entries.map((e) => ({
    line: e.lineNumber, section: e.section, name: e.name, value: e.value, dashed: e.dashed, malformed: e.malformed,
  }));
  assert.deepEqual(entries, [
    { line: 6, section: 'jobs', name: 'build', value: 'opus 5.5', dashed: false, malformed: false },
    { line: 7, section: 'jobs', name: '', value: '', dashed: false, malformed: true },
    { line: 12, section: 'job', name: '', value: 'haiku', dashed: true, malformed: false },
    { line: 13, section: 'job', name: '', value: 'codex, effort: medium', dashed: true, malformed: false },
    { line: 17, section: 'team', name: 'researcher', value: 'search', dashed: false, malformed: false },
    { line: 18, section: 'team', name: 'judge', value: 'opus 5.5', dashed: true, malformed: false },
  ]);

  const workers = scan.entries.filter((e) => e.section === 'job');
  assert.equal(workers[0].heading, 'small build');
  assert.equal(workers[0].headingIndex, scan.headings[1].index);
});

test('scan detects CRLF and reports headings and entries the same way', () => {
  const scan = scanRosterMarkdown('# roster\r\nbuild: codex\r\n');
  assert.equal(scan.newline, '\r\n');
  assert.deepEqual(scan.lines, ['# roster', 'build: codex', '']);
  assert.equal(scan.entries.length, 1);
  assert.equal(scan.entries[0].name, 'build');
  assert.equal(scan.entries[0].value, 'codex');
});

test('jobSections returns each job heading with its workers and end index', () => {
  const scan = scanRosterMarkdown([
    '# roster',
    'build: codex',
    '',
    '## review',
    '- claude code',
    '- haiku',
    '',
    '## team',
    'j: search',
  ].join('\n'));
  const sections = jobSections(scan);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].heading.title, 'review');
  assert.equal(sections[0].end, scan.headings.find((h) => h.title === 'team').index);
  assert.deepEqual(sections[0].workers.map((w) => w.value), ['claude code', 'haiku']);
});

test('replaceJobSection swaps only the matched job worker lines', () => {
  const out = replaceJobSection([
    '# roster',
    '',
    '## build',
    '- claude code, model: opus 5.5',
    '- codex',
    '',
    '## team',
    '- researcher: search',
    '',
  ].join('\n'), { matches: (t) => t === 'build', heading: '## build', lines: ['- cursor'] });
  assert.equal(out, [
    '# roster',
    '',
    '## build',
    '- cursor',
    '',
    '## team',
    '- researcher: search',
    '',
  ].join('\n'));
});

test('replaceJobSection adds a new job before the team and removes a job cleanly', () => {
  const base = [
    '# roster',
    '',
    '## build',
    '- cursor',
    '',
    '## review',
    '- codex',
    '',
    '## team',
    '- j: search',
    '',
  ].join('\n');

  const added = replaceJobSection(base, { matches: (t) => t === 'search', heading: '## search', lines: ['- haiku'] });
  assert.equal(added, [
    '# roster',
    '',
    '## build',
    '- cursor',
    '',
    '## review',
    '- codex',
    '',
    '## search',
    '- haiku',
    '',
    '## team',
    '- j: search',
    '',
  ].join('\n'));

  const removed = replaceJobSection(base, { matches: (t) => t === 'build', lines: null });
  assert.equal(removed, [
    '# roster',
    '',
    '## review',
    '- codex',
    '',
    '## team',
    '- j: search',
    '',
  ].join('\n'));
});

test('replaceJobSection on empty text starts from the template and renames keeping a trailing note', () => {
  const blank = replaceJobSection('   ', { matches: () => false, heading: '## build', lines: ['- codex'] });
  assert.equal(blank, `# roster\n\n${ROSTER_NOTE}\n\n## build\n- codex\n`);
  assert.equal(blank.startsWith(ROSTER_MARKDOWN_TEMPLATE.join('\n')), true);

  const renamed = replaceJobSection([
    '# roster',
    '',
    '## build <!-- from last week -->',
    '- cursor',
    '',
  ].join('\n'), { matches: (t) => t.startsWith('build'), heading: '## build (renamed)', lines: ['- codex'] });
  assert.equal(renamed, [
    '# roster',
    '',
    '## build (renamed) <!-- from last week -->',
    '- codex',
    '',
  ].join('\n'));
});

test('rewriteRosterValues rewrites chosen entries in place and keeps indent', () => {
  const out = rewriteRosterValues([
    '# roster',
    '  build: opus 5.5',
    '',
    '## build',
    '  - claude code',
    '- codex',
    '',
  ].join('\n'), (entry) => {
    if (entry.name === 'build') return 'build: codex';
    if (entry.section === 'job' && entry.value === 'codex') return '- haiku';
    return undefined;
  });
  assert.equal(out, [
    '# roster',
    '  build: codex',
    '',
    '## build',
    '  - claude code',
    '- haiku',
    '',
  ].join('\n'));
});

test('joinLines always ends the text with the chosen newline', () => {
  assert.equal(joinLines(['a', 'b'], '\n'), 'a\nb\n');
  assert.equal(joinLines(['a', ''], '\n'), 'a\n');
  assert.equal(joinLines(['a', 'b'], '\r\n'), 'a\r\nb\r\n');
});
