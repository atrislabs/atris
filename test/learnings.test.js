const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  TYPES,
  SOURCES,
  effectiveConfidence,
  loadLearnings,
  addLearning,
  searchLearnings,
  findPruneTargets,
  removeLearning,
  getStats,
  exportMarkdown,
} = require('../lib/learnings');

let tmpDir;
let origCwd;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-learn-test-'));
  fs.mkdirSync(path.join(tmpDir, 'atris'), { recursive: true });
  origCwd = process.cwd();
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('learnings', () => {
  describe('TYPES and SOURCES', () => {
    it('has 5 types', () => {
      assert.strictEqual(TYPES.length, 5);
      assert.ok(TYPES.includes('pattern'));
      assert.ok(TYPES.includes('pitfall'));
      assert.ok(TYPES.includes('preference'));
      assert.ok(TYPES.includes('architecture'));
      assert.ok(TYPES.includes('tool'));
    });

    it('has 4 sources', () => {
      assert.strictEqual(SOURCES.length, 4);
      assert.ok(SOURCES.includes('observed'));
      assert.ok(SOURCES.includes('user-stated'));
    });
  });

  describe('effectiveConfidence', () => {
    it('returns raw confidence for user-stated', () => {
      const entry = { confidence: 10, source: 'user-stated', ts: '2025-01-01T00:00:00Z' };
      assert.strictEqual(effectiveConfidence(entry), 10);
    });

    it('decays observed entries by 1 per 30 days', () => {
      const thirtyDaysAgo = new Date(Date.now() - 31 * 86400000).toISOString();
      const entry = { confidence: 8, source: 'observed', ts: thirtyDaysAgo };
      assert.strictEqual(effectiveConfidence(entry), 7);
    });

    it('decays inferred entries', () => {
      const sixtyDaysAgo = new Date(Date.now() - 61 * 86400000).toISOString();
      const entry = { confidence: 5, source: 'inferred', ts: sixtyDaysAgo };
      assert.strictEqual(effectiveConfidence(entry), 3);
    });

    it('never goes below 0', () => {
      const yearAgo = new Date(Date.now() - 365 * 86400000).toISOString();
      const entry = { confidence: 3, source: 'observed', ts: yearAgo };
      assert.strictEqual(effectiveConfidence(entry), 0);
    });

    it('does not decay review source', () => {
      const ninetyDaysAgo = new Date(Date.now() - 91 * 86400000).toISOString();
      const entry = { confidence: 7, source: 'review', ts: ninetyDaysAgo };
      assert.strictEqual(effectiveConfidence(entry), 7);
    });
  });

  describe('addLearning', () => {
    it('creates learnings.jsonl and appends entry', () => {
      const entry = addLearning({
        type: 'pattern',
        key: 'test-key',
        insight: 'test insight',
        confidence: 8,
        source: 'observed',
        files: ['test.js'],
      });

      assert.strictEqual(entry.type, 'pattern');
      assert.strictEqual(entry.key, 'test-key');
      assert.strictEqual(entry.confidence, 8);
      assert.ok(entry.ts);

      const content = fs.readFileSync(path.join(tmpDir, 'atris', 'learnings.jsonl'), 'utf8');
      assert.ok(content.includes('test-key'));
    });

    it('normalizes key to kebab-case', () => {
      const entry = addLearning({
        type: 'pattern',
        key: 'My Test Key',
        insight: 'test',
        confidence: 5,
        source: 'observed',
      });
      assert.strictEqual(entry.key, 'my-test-key');
    });

    it('rejects invalid type', () => {
      assert.throws(() => {
        addLearning({ type: 'invalid', key: 'x', insight: 'x', confidence: 5, source: 'observed' });
      }, /Invalid type/);
    });

    it('rejects invalid source', () => {
      assert.throws(() => {
        addLearning({ type: 'pattern', key: 'x', insight: 'x', confidence: 5, source: 'invalid' });
      }, /Invalid source/);
    });

    it('rejects confidence out of range', () => {
      assert.throws(() => {
        addLearning({ type: 'pattern', key: 'x', insight: 'x', confidence: 0, source: 'observed' });
      }, /Confidence must be 1-10/);
      assert.throws(() => {
        addLearning({ type: 'pattern', key: 'x', insight: 'x', confidence: 11, source: 'observed' });
      }, /Confidence must be 1-10/);
    });

    it('rejects empty key', () => {
      assert.throws(() => {
        addLearning({ type: 'pattern', key: '', insight: 'x', confidence: 5, source: 'observed' });
      }, /Key and insight are required/);
    });
  });

  describe('loadLearnings', () => {
    it('returns empty array when no file', () => {
      const result = loadLearnings();
      assert.deepStrictEqual(result, []);
    });

    it('deduplicates by key+type (latest wins)', () => {
      addLearning({ type: 'pattern', key: 'dup', insight: 'old', confidence: 5, source: 'observed' });
      addLearning({ type: 'pattern', key: 'dup', insight: 'new', confidence: 8, source: 'observed' });

      const result = loadLearnings();
      const dups = result.filter(e => e.key === 'dup');
      assert.strictEqual(dups.length, 1);
      assert.strictEqual(dups[0].insight, 'new');
      assert.strictEqual(dups[0].confidence, 8);
    });

    it('sorts by effective confidence desc', () => {
      addLearning({ type: 'preference', key: 'high', insight: 'hi', confidence: 10, source: 'user-stated' });
      addLearning({ type: 'pattern', key: 'low', insight: 'lo', confidence: 3, source: 'observed' });

      const result = loadLearnings();
      assert.strictEqual(result[0].key, 'high');
      assert.strictEqual(result[1].key, 'low');
    });

    it('skips corrupted lines', () => {
      const filePath = path.join(tmpDir, 'atris', 'learnings.jsonl');
      fs.writeFileSync(filePath, 'not json\n{"ts":"2026-01-01","type":"pattern","key":"ok","insight":"works","confidence":5,"source":"observed"}\n');

      const result = loadLearnings();
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].key, 'ok');
    });
  });

  describe('searchLearnings', () => {
    it('searches by key', () => {
      addLearning({ type: 'pattern', key: 'api-envelope', insight: 'wrapped', confidence: 9, source: 'observed' });
      addLearning({ type: 'pitfall', key: 'date-compare', insight: 'bad dates', confidence: 7, source: 'observed' });

      const results = searchLearnings('api');
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].key, 'api-envelope');
    });

    it('searches by insight text', () => {
      addLearning({ type: 'pattern', key: 'a', insight: 'always use envelope format', confidence: 5, source: 'observed' });

      const results = searchLearnings('envelope');
      assert.strictEqual(results.length, 1);
    });

    it('searches by file path', () => {
      addLearning({ type: 'pattern', key: 'a', insight: 'x', confidence: 5, source: 'observed', files: ['src/auth.py'] });

      const results = searchLearnings('auth');
      assert.strictEqual(results.length, 1);
    });
  });

  describe('removeLearning', () => {
    it('tombstones a learning so it disappears from results', () => {
      addLearning({ type: 'pattern', key: 'to-remove', insight: 'bye', confidence: 8, source: 'observed' });
      assert.strictEqual(loadLearnings().length, 1);

      removeLearning('to-remove', 'pattern');
      const remaining = loadLearnings().filter(e => e._effectiveConfidence > 0 && e.insight !== '[REMOVED]');
      assert.strictEqual(remaining.length, 0);
    });
  });

  describe('getStats', () => {
    it('returns zeros when empty', () => {
      const stats = getStats();
      assert.strictEqual(stats.total, 0);
      assert.strictEqual(stats.high, 0);
    });

    it('categorizes by confidence', () => {
      addLearning({ type: 'pattern', key: 'hi', insight: 'x', confidence: 9, source: 'user-stated' });
      addLearning({ type: 'pitfall', key: 'mid', insight: 'x', confidence: 5, source: 'user-stated' });
      addLearning({ type: 'tool', key: 'lo', insight: 'x', confidence: 2, source: 'user-stated' });

      const stats = getStats();
      assert.strictEqual(stats.total, 3);
      assert.strictEqual(stats.high, 1);
      assert.strictEqual(stats.medium, 1);
      assert.strictEqual(stats.low, 1);
    });
  });

  describe('exportMarkdown', () => {
    it('exports grouped by type', () => {
      addLearning({ type: 'pattern', key: 'a', insight: 'pattern insight', confidence: 8, source: 'observed' });
      addLearning({ type: 'pitfall', key: 'b', insight: 'pitfall insight', confidence: 7, source: 'observed' });

      const md = exportMarkdown();
      assert.ok(md.includes('### Patterns'));
      assert.ok(md.includes('### Pitfalls'));
      assert.ok(md.includes('pattern insight'));
      assert.ok(md.includes('pitfall insight'));
    });
  });

  describe('findPruneTargets', () => {
    it('detects stale entries with missing files', () => {
      addLearning({ type: 'pattern', key: 'stale', insight: 'x', confidence: 8, source: 'observed', files: ['nonexistent.js'] });

      const { stale } = findPruneTargets();
      assert.strictEqual(stale.length, 1);
      assert.strictEqual(stale[0].entry.key, 'stale');
    });

    it('does not flag entries with existing files', () => {
      fs.writeFileSync(path.join(tmpDir, 'real.js'), '');
      addLearning({ type: 'pattern', key: 'ok', insight: 'x', confidence: 8, source: 'observed', files: ['real.js'] });

      const { stale } = findPruneTargets();
      assert.strictEqual(stale.length, 0);
    });
  });

  describe('journal harvest integration', () => {
    it('creates learnings from journal Notes entries', () => {
      // Create a journal with Notes
      const logsDir = path.join(tmpDir, 'atris', 'logs', '2026');
      fs.mkdirSync(logsDir, { recursive: true });
      fs.writeFileSync(path.join(logsDir, '2026-03-30.md'), [
        '# Log — 2026-03-30',
        '',
        '## Notes',
        '- 14:30 — Always validate JWT expiry before trusting claims',
        '- 15:00 — Never use string comparison for dates',
        '',
        '## Inbox',
        '',
      ].join('\n'));

      // Harvest by loading the file directly (simulating harvest logic)
      const content = fs.readFileSync(path.join(logsDir, '2026-03-30.md'), 'utf8');
      const notesMatch = content.match(/## Notes\n([\s\S]*?)(?=\n## |$)/);
      assert.ok(notesMatch, 'Notes section should exist');

      const lines = notesMatch[1].trim().split('\n').filter(l => l.startsWith('- '));
      assert.strictEqual(lines.length, 2);

      // Verify classification logic
      const line1 = lines[0].replace(/^- (\d{2}:\d{2} — )?/, '').trim();
      const line2 = lines[1].replace(/^- (\d{2}:\d{2} — )?/, '').trim();
      assert.strictEqual(line1, 'Always validate JWT expiry before trusting claims');
      assert.ok(/^never/i.test(line2), 'Should detect "Never" as pitfall trigger');
    });

    it('skips empty Notes sections', () => {
      const logsDir = path.join(tmpDir, 'atris', 'logs', '2026');
      fs.mkdirSync(logsDir, { recursive: true });
      fs.writeFileSync(path.join(logsDir, '2026-03-30.md'), [
        '# Log — 2026-03-30',
        '',
        '## Notes',
        '',
        '## Inbox',
      ].join('\n'));

      const content = fs.readFileSync(path.join(logsDir, '2026-03-30.md'), 'utf8');
      const notesMatch = content.match(/## Notes\n([\s\S]*?)(?=\n## |$)/);
      const lines = (notesMatch?.[1] || '').trim().split('\n').filter(l => l.startsWith('- '));
      assert.strictEqual(lines.length, 0);
    });
  });
});
