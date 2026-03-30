const fs = require('fs');
const path = require('path');

const TYPES = ['pattern', 'pitfall', 'preference', 'architecture', 'tool'];
const SOURCES = ['observed', 'user-stated', 'inferred', 'review'];

function getLearningsPath() {
  return path.join(process.cwd(), 'atris', 'learnings.jsonl');
}

function ensureLearningsFile() {
  const filePath = getLearningsPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '');
  }
  return filePath;
}

/**
 * Confidence decay: observed/inferred lose 1 point per 30 days.
 * User-stated preferences never decay.
 */
function effectiveConfidence(entry) {
  let conf = entry.confidence || 5;
  if (entry.source === 'observed' || entry.source === 'inferred') {
    const days = Math.floor((Date.now() - new Date(entry.ts).getTime()) / 86400000);
    conf = Math.max(0, conf - Math.floor(days / 30));
  }
  return conf;
}

/**
 * Read all learnings, dedup (latest per key+type wins), apply decay.
 */
function loadLearnings() {
  const filePath = getLearningsPath();
  if (!fs.existsSync(filePath)) return [];

  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
  const entries = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (!entry.key || !entry.type) continue;
      entry._effectiveConfidence = effectiveConfidence(entry);
      entries.push(entry);
    } catch {
      // skip corrupted lines
    }
  }

  // Dedup: latest per key+type wins
  const seen = new Map();
  for (const entry of entries) {
    const dk = `${entry.key}|${entry.type}`;
    const existing = seen.get(dk);
    if (!existing || new Date(entry.ts) > new Date(existing.ts)) {
      seen.set(dk, entry);
    }
  }

  return Array.from(seen.values())
    .sort((a, b) => {
      if (b._effectiveConfidence !== a._effectiveConfidence) {
        return b._effectiveConfidence - a._effectiveConfidence;
      }
      return new Date(b.ts).getTime() - new Date(a.ts).getTime();
    });
}

/**
 * Add a learning entry. Append-only.
 */
function addLearning({ type, key, insight, confidence, source, files }) {
  if (!TYPES.includes(type)) {
    throw new Error(`Invalid type: ${type}. Must be one of: ${TYPES.join(', ')}`);
  }
  if (!SOURCES.includes(source)) {
    throw new Error(`Invalid source: ${source}. Must be one of: ${SOURCES.join(', ')}`);
  }
  if (confidence < 1 || confidence > 10) {
    throw new Error('Confidence must be 1-10');
  }
  if (!key || !insight) {
    throw new Error('Key and insight are required');
  }

  const filePath = ensureLearningsFile();
  const entry = {
    ts: new Date().toISOString(),
    type,
    key: key.toLowerCase().replace(/\s+/g, '-'),
    insight,
    confidence,
    source,
    files: files || [],
  };

  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
  return entry;
}

/**
 * Search learnings by keyword.
 */
function searchLearnings(query, limit = 20) {
  const all = loadLearnings();
  if (!query) return all.slice(0, limit);

  const q = query.toLowerCase();
  return all
    .filter(e =>
      (e.key || '').toLowerCase().includes(q) ||
      (e.insight || '').toLowerCase().includes(q) ||
      (e.files || []).some(f => f.toLowerCase().includes(q))
    )
    .slice(0, limit);
}

/**
 * Prune: find stale (deleted files) and contradictions (same key, different insight).
 */
function findPruneTargets() {
  const all = loadLearnings();
  const stale = [];
  const contradictions = [];

  // Stale: referenced files no longer exist
  for (const entry of all) {
    if (entry.files && entry.files.length > 0) {
      const missing = entry.files.filter(f => !fs.existsSync(path.join(process.cwd(), f)));
      if (missing.length > 0) {
        stale.push({ entry, missingFiles: missing });
      }
    }
  }

  // Contradictions: same key, different type entries with conflicting insights
  const byKey = new Map();
  for (const entry of all) {
    const existing = byKey.get(entry.key);
    if (existing && existing.type === entry.type && existing.insight !== entry.insight) {
      contradictions.push({ a: existing, b: entry });
    }
    byKey.set(entry.key, entry);
  }

  return { stale, contradictions };
}

/**
 * Remove a learning by key+type (appends a tombstone with confidence 0).
 */
function removeLearning(key, type) {
  const filePath = ensureLearningsFile();
  const entry = {
    ts: new Date().toISOString(),
    type,
    key,
    insight: '[REMOVED]',
    confidence: 0,
    source: 'user-stated',
    files: [],
  };
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
}

/**
 * Get stats about learnings.
 */
function getStats() {
  const all = loadLearnings();
  const active = all.filter(e => e._effectiveConfidence > 0 && e.insight !== '[REMOVED]');
  const byType = {};
  const bySource = {};
  let totalConf = 0;

  for (const e of active) {
    byType[e.type] = (byType[e.type] || 0) + 1;
    bySource[e.source] = (bySource[e.source] || 0) + 1;
    totalConf += e._effectiveConfidence;
  }

  return {
    total: active.length,
    byType,
    bySource,
    avgConfidence: active.length > 0 ? (totalConf / active.length).toFixed(1) : 0,
    high: active.filter(e => e._effectiveConfidence >= 7).length,
    medium: active.filter(e => e._effectiveConfidence >= 4 && e._effectiveConfidence < 7).length,
    low: active.filter(e => e._effectiveConfidence > 0 && e._effectiveConfidence < 4).length,
  };
}

/**
 * Export learnings as markdown.
 */
function exportMarkdown() {
  const all = loadLearnings().filter(e => e._effectiveConfidence > 0 && e.insight !== '[REMOVED]');
  const byType = {};

  for (const e of all) {
    if (!byType[e.type]) byType[e.type] = [];
    byType[e.type].push(e);
  }

  const lines = ['## Project Learnings', ''];
  for (const [type, entries] of Object.entries(byType)) {
    lines.push(`### ${type.charAt(0).toUpperCase() + type.slice(1)}s`);
    for (const e of entries) {
      const files = e.files?.length ? ` (${e.files.join(', ')})` : '';
      lines.push(`- **${e.key}** [${e._effectiveConfidence}/10]: ${e.insight}${files}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = {
  TYPES,
  SOURCES,
  getLearningsPath,
  ensureLearningsFile,
  effectiveConfidence,
  loadLearnings,
  addLearning,
  searchLearnings,
  findPruneTargets,
  removeLearning,
  getStats,
  exportMarkdown,
};
