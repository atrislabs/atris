const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { policyLessonsForFiles } = require('../lib/policy-lessons');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-policy-files-test-'));
  const prevHome = process.env.HOME;
  process.env.HOME = dir;

  const savedAtrisEnv = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      savedAtrisEnv[key] = process.env[key];
      delete process.env[key];
    }
  }

  try {
    return fn(dir);
  } finally {
    if (prevHome !== undefined) {
      process.env.HOME = prevHome;
    } else {
      delete process.env.HOME;
    }
    for (const [key, val] of Object.entries(savedAtrisEnv)) {
      process.env[key] = val;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('policyLessonsForFiles matches candidate files against mined and typed lessons', () => {
  withTempDir((dir) => {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'atris', 'lessons.json'),
      JSON.stringify({
        _schema: 'atris.typed_lessons.v1',
        'typed-lesson-1': {
          applies_to: ['lib/policy-lessons.js'],
          detector: 'node --test test/policy-lessons.test.js',
          text: 'Preserve policy lessons format',
          status: 'resolved',
        },
      }),
      'utf8',
    );

    const mined = {
      lessons: [
        {
          id: 'mined-lesson-1',
          applies_to: ['commands/autopilot.js'],
          detector: 'node bin/atris.js test',
          lesson: 'Ensure autopilot handles errors',
          status: 'open',
        },
        {
          id: 'mined-unrelated',
          applies_to: ['docs/readme.md'],
          lesson: 'Unrelated documentation rule',
        },
      ],
    };

    const matches = policyLessonsForFiles(
      ['lib/policy-lessons.js', 'commands/autopilot.js'],
      mined,
      dir,
    );

    assert.strictEqual(matches.length, 2);

    assert.deepStrictEqual(matches[0], {
      id: 'typed-lesson-1',
      detector: 'node --test test/policy-lessons.test.js',
      lesson: 'Preserve policy lessons format',
      status: 'resolved',
      source: 'typed_lessons',
      matched_path: 'lib/policy-lessons.js',
    });

    assert.deepStrictEqual(matches[1], {
      id: 'mined-lesson-1',
      detector: 'node bin/atris.js test',
      lesson: 'Ensure autopilot handles errors',
      status: 'open',
      source: 'mined_policy',
      matched_path: 'commands/autopilot.js',
    });
  });
});

test('policyLessonsForFiles handles path normalization, prefix overlap, and deduplication precedence', () => {
  withTempDir((dir) => {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'atris', 'lessons.json'),
      JSON.stringify({
        'duplicate-id': {
          applies_to: ['./src/server.js'],
          detector: 'npm test',
          lesson: 'Typed version should win over mined version',
          status: 'verified',
        },
        'dir-scope-lesson': {
          paths: ['lib/helpers'],
          text: 'Helpers folder lesson using paths fallback',
        },
      }),
      'utf8',
    );

    const mined = {
      lessons: [
        {
          id: 'duplicate-id',
          applies_to: ['src/server.js'],
          detector: 'cargo test',
          lesson: 'Mined version should be ignored',
          status: 'ignored',
        },
        {
          id: 'overlap-dir-candidate',
          applies_to: ['lib/nested/deep/module.js'],
          lesson: 'Candidate is directory containing lesson file',
        },
      ],
    };

    // 1. Single string input with Windows-style slashes, leading ./, and case-insensitivity
    const singleMatch = policyLessonsForFiles('.\\SRC\\server.js', mined, dir);
    assert.strictEqual(singleMatch.length, 1);
    assert.strictEqual(singleMatch[0].id, 'duplicate-id');
    assert.strictEqual(singleMatch[0].source, 'typed_lessons');
    assert.strictEqual(singleMatch[0].lesson, 'Typed version should win over mined version');
    assert.strictEqual(singleMatch[0].matched_path, 'src/server.js');

    // 2. Candidate path inside directory scope declared with 'paths' fallback
    const dirScopeMatches = policyLessonsForFiles('lib/helpers/parser.js', mined, dir);
    assert.strictEqual(dirScopeMatches.length, 1);
    assert.strictEqual(dirScopeMatches[0].id, 'dir-scope-lesson');
    assert.strictEqual(dirScopeMatches[0].matched_path, 'lib/helpers');
    assert.strictEqual(dirScopeMatches[0].detector, '');

    // 3. Candidate path is directory prefix of declared lesson path
    const candidateDirMatches = policyLessonsForFiles(['lib/nested/deep'], mined, dir);
    assert.strictEqual(candidateDirMatches.length, 1);
    assert.strictEqual(candidateDirMatches[0].id, 'overlap-dir-candidate');
    assert.strictEqual(candidateDirMatches[0].matched_path, 'lib/nested/deep/module.js');
  });
});

test('policyLessonsForFiles returns empty list on empty inputs, malformed files, or non-matching paths', () => {
  withTempDir((dir) => {
    // 1. Empty or whitespace-only files input
    assert.deepStrictEqual(policyLessonsForFiles([], null, dir), []);
    assert.deepStrictEqual(policyLessonsForFiles('', null, dir), []);
    assert.deepStrictEqual(policyLessonsForFiles(['', '   '], null, dir), []);
    assert.deepStrictEqual(policyLessonsForFiles(null, null, dir), []);

    // 2. No matching paths between candidate and lessons
    const mined = {
      lessons: [
        {
          id: 'lesson-a',
          applies_to: ['src/unrelated.js'],
          lesson: 'No match here',
        },
        {
          id: 'repo-wide-lesson',
          lesson: 'Global lesson without applies_to or paths is skipped',
        },
      ],
    };
    assert.deepStrictEqual(policyLessonsForFiles(['test/sample.test.js'], mined, dir), []);

    // 3. Malformed JSON in typed lessons file does not crash
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'lessons.json'), '{invalid json', 'utf8');

    const emptyOnMalformed = policyLessonsForFiles(['test/sample.test.js'], null, dir);
    assert.deepStrictEqual(emptyOnMalformed, []);

    const minedMatchesSafely = policyLessonsForFiles(['src/unrelated.js'], mined, dir);
    assert.strictEqual(minedMatchesSafely.length, 1);
    assert.strictEqual(minedMatchesSafely[0].id, 'lesson-a');
    assert.strictEqual(minedMatchesSafely[0].source, 'mined_policy');
  });
});
