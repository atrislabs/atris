const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

// --- direct import for isLessonResolved (no mocking needed) ---
const { isLessonResolved } = require('../commands/autopilot.js');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-lesson-gate-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// L1c-1: isLessonResolved — 3 cases
// ---------------------------------------------------------------------------
describe('isLessonResolved', () => {
  it('returns true when lesson refs a nonexistent file', () => {
    // Lesson references `ghost/missing.js:42` which does not exist in tmpDir
    const lesson = '- **[2026-04-10] ghost-missing-bug** — pass — The `ghost/missing.js:42` had a bad export.';
    const result = isLessonResolved(lesson, tmpDir);
    assert.strictEqual(result, true, 'should be resolved when referenced file does not exist');
  });

  it('returns false when lesson refs existing file with matching keyword', () => {
    // Create the file with a keyword that matches the slug
    const dir = path.join(tmpDir, 'src');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'handler.js');
    // slug: "inbox-parser-broken" → keywords: inbox, parser, broken
    fs.writeFileSync(filePath, 'function inboxParser() { /* broken logic */ }\n');

    const lesson = '- **[2026-04-10] inbox-parser-broken** — fail — The `src/handler.js:1` inbox parser was broken.';
    const result = isLessonResolved(lesson, tmpDir);
    assert.strictEqual(result, false, 'should not be resolved when keyword still found in referenced file');
  });

  it('returns false when lesson has no file refs', () => {
    // Lesson text with no backtick-quoted file paths
    const lesson = '- **[2026-04-10] general-advice** — pass — Always check twice before shipping.';
    const result = isLessonResolved(lesson, tmpDir);
    assert.strictEqual(result, false, 'should return false when no file refs to check');
  });
});

// ---------------------------------------------------------------------------
// L1c-2: proposeCandidateHorizons filter path — resolved lessons get skipped
// ---------------------------------------------------------------------------
describe('proposeCandidateHorizons filter path', () => {
  let proposeCandidateHorizons;
  let origExecSync;

  before(() => {
    // Monkey-patch child_process.execSync BEFORE re-requiring autopilot
    // so the destructured binding inside autopilot captures the mock.
    origExecSync = cp.execSync;

    cp.execSync = function mockedExecSync(cmd, opts) {
      const cmdStr = typeof cmd === 'string' ? cmd : '';
      // Intercept claude -p calls → return a JSON candidate array
      if (cmdStr.includes('claude -p') || cmdStr.includes('claude  -p')) {
        // Return a single candidate whose title/rationale matches the resolved lesson slug
        return JSON.stringify([
          { title: 'fix ghost-missing-bug export', confidence: 0.9, rationale: 'ghost missing bug still broken' },
          { title: 'fix ghost-missing-bug export v2', confidence: 0.8, rationale: 'ghost missing rewrite' },
          { title: 'fix ghost-missing-bug cleanup', confidence: 0.7, rationale: 'ghost missing final cleanup' }
        ]);
      }
      // Intercept git log → return empty
      if (cmdStr.includes('git log')) {
        return Buffer.from('abc123 fake commit\n');
      }
      // Fall through for anything else
      return origExecSync.call(this, cmd, opts);
    };

    // Clear the cached module so re-require picks up the patched execSync
    const modPath = require.resolve('../commands/autopilot.js');
    delete require.cache[modPath];
    const freshMod = require('../commands/autopilot.js');
    proposeCandidateHorizons = freshMod.proposeCandidateHorizons;
  });

  after(() => {
    // Restore original execSync
    cp.execSync = origExecSync;
  });

  it('throws when all candidates match a resolved lesson', async () => {
    // Set up temp workspace with atris/lessons.md containing a resolved-pattern lesson
    // The lesson refs `ghost/missing.js` which does NOT exist → isLessonResolved returns true
    const atrisDir = path.join(tmpDir, 'atris');
    fs.mkdirSync(atrisDir, { recursive: true });

    // Create lessons.md with one lesson that references a nonexistent file
    const lessonsContent = [
      '# lessons.md',
      '',
      '- **[2026-04-10] ghost-missing-bug** — pass — The `ghost/missing.js:42` had a bad export.',
    ].join('\n');
    fs.writeFileSync(path.join(atrisDir, 'lessons.md'), lessonsContent);

    // Create today's journal so getIdleTickCount doesn't crash
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const logsDir = path.join(atrisDir, 'logs', String(yyyy));
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, `${yyyy}-${mm}-${dd}.md`), [
      `# Log — ${yyyy}-${mm}-${dd}`,
      '',
      '## Notes',
      '',
      '## Inbox',
      '',
    ].join('\n'));

    // All 3 candidates match the resolved lesson slug → should throw
    await assert.rejects(
      () => proposeCandidateHorizons(tmpDir),
      (err) => {
        assert.ok(
          err.message.includes('all candidates were from resolved lessons'),
          `expected "all candidates were from resolved lessons", got: ${err.message}`
        );
        return true;
      }
    );

    // Verify [resolved] tag was written to lessons.md
    const updatedLessons = fs.readFileSync(path.join(atrisDir, 'lessons.md'), 'utf8');
    assert.ok(
      updatedLessons.includes('[resolved]'),
      'lessons.md should contain [resolved] tag after filtering'
    );
  });
});
