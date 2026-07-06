const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseLessons, loadLessonMetadata } = require('../commands/autopilot');

const repoRoot = path.join(__dirname, '..');

const MECHANIZED_LESSONS = [
  'outbound-artifacts-must-render-before-send',
  'verify-not-runnable',
  'verify-not-falsifiable',
  'play-test-env-leak',
  'features-gitignored-by-default',
  'judge-never-patches',
  'work-must-land-or-it-never-happened',
  'private-data-follows-the-files-array',
  'ship-add-all-sweeps-regenerated-files',
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeTempFile(root, name, content) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function directFeaturePackageEntries(pkg) {
  return (pkg.files || [])
    .map((entry) => String(entry || '').trim())
    .filter((entry) => /^atris\/features\/[^/]+\/$/.test(entry))
    .filter((entry) => !entry.includes('/_templates/'));
}

function featurePackageAllowlistProblems(root) {
  const pkg = readJson(path.join(root, 'package.json'));
  const gitignore = fs.existsSync(path.join(root, '.gitignore'))
    ? fs.readFileSync(path.join(root, '.gitignore'), 'utf8')
    : '';
  return directFeaturePackageEntries(pkg).filter((entry) => {
    const allFiles = `${entry}**`;
    return !gitignore.split(/\r?\n/).some((line) => {
      const trimmed = line.trim();
      return trimmed === `!${entry}` || trimmed === `!${allFiles}`;
    });
  });
}

function packagePrivacyProblems(root) {
  const pkg = readJson(path.join(root, 'package.json'));
  const npmignore = fs.existsSync(path.join(root, '.npmignore'))
    ? fs.readFileSync(path.join(root, '.npmignore'), 'utf8')
    : '';
  const gitignore = fs.existsSync(path.join(root, '.gitignore'))
    ? fs.readFileSync(path.join(root, '.gitignore'), 'utf8')
    : '';
  const files = (pkg.files || []).map((entry) => String(entry || '').trim());
  const packagedPrivateRoots = files.filter((entry) => (
    entry === 'private/' || entry === 'decks/private/' || entry.startsWith('.atris/')
  ));
  const missingIgnores = ['private/', 'decks/private/'].filter((entry) => (
    !gitignore.split(/\r?\n/).map((line) => line.trim()).includes(entry)
    || !npmignore.split(/\r?\n/).map((line) => line.trim()).includes(entry)
  ));
  return { packagedPrivateRoots, missingIgnores };
}

test('lessons ledger has zero unresolved lessons', () => {
  const lessons = parseLessons(repoRoot);
  const unresolved = lessons.filter((lesson) => {
    if (lesson.verdict !== 'fail') return false;
    if (lesson.resolvedTag) return false;
    return lesson.meta?.status !== 'resolved';
  });
  assert.deepEqual(unresolved.map((lesson) => lesson.id), []);

  const metadata = loadLessonMetadata(repoRoot);
  const unresolvedMeta = Object.entries(metadata)
    .filter(([id]) => id !== '_schema')
    .filter(([, meta]) => ['open', 'attempted', 'observed'].includes(meta?.status));
  assert.deepEqual(unresolvedMeta.map(([id]) => id), []);
});

test('mechanized lessons have resolved sidecar pointers', () => {
  const metadata = loadLessonMetadata(repoRoot);
  const lessons = new Map(parseLessons(repoRoot).map((lesson) => [lesson.id, lesson]));
  for (const id of MECHANIZED_LESSONS) {
    assert.equal(metadata[id]?.status, 'resolved', `${id} should be resolved`);
    assert.match(String(metadata[id]?.mechanism || ''), /\b(commands|scripts|test|bin|lib)\//);
    assert.equal(lessons.get(id)?.verdict, 'pass', `${id} should be a pass lesson`);
  }
});

test('lessons markdown is shorter after burn-down', () => {
  const lines = fs.readFileSync(path.join(repoRoot, 'atris', 'lessons.md'), 'utf8').split(/\r?\n/);
  assert.ok(lines.length < 299, `expected fewer than 299 lines, got ${lines.length}`);
});

test('feature package detector fires on missing gitignore allowlist and stays quiet when allowlisted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-feature-'));
  try {
    writeTempFile(dir, 'package.json', JSON.stringify({ files: ['atris/features/new-public/'] }));
    writeTempFile(dir, '.gitignore', 'atris/features/*\n');
    assert.deepEqual(featurePackageAllowlistProblems(dir), ['atris/features/new-public/']);

    writeTempFile(dir, '.gitignore', [
      'atris/features/*',
      '!atris/features/new-public/',
      '!atris/features/new-public/**',
      '',
    ].join('\n'));
    assert.deepEqual(featurePackageAllowlistProblems(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('current public feature package entries are gitignore-allowlisted', () => {
  assert.deepEqual(featurePackageAllowlistProblems(repoRoot), []);
});

test('private package detector fires on public private roots and stays quiet when ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-private-'));
  try {
    writeTempFile(dir, 'package.json', JSON.stringify({ files: ['private/', 'commands/'] }));
    writeTempFile(dir, '.gitignore', '');
    writeTempFile(dir, '.npmignore', '');
    assert.deepEqual(packagePrivacyProblems(dir), {
      packagedPrivateRoots: ['private/'],
      missingIgnores: ['private/', 'decks/private/'],
    });

    writeTempFile(dir, 'package.json', JSON.stringify({ files: ['commands/', 'decks/'] }));
    writeTempFile(dir, '.gitignore', 'private/\ndecks/private/\n');
    writeTempFile(dir, '.npmignore', 'private/\ndecks/private/\n');
    assert.deepEqual(packagePrivacyProblems(dir), { packagedPrivateRoots: [], missingIgnores: [] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('current package privacy roots stay private', () => {
  assert.deepEqual(packagePrivacyProblems(repoRoot), { packagedPrivateRoots: [], missingIgnores: [] });
});
