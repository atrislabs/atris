// Deck build history — every build appends one line to a JSONL ledger so an
// operator can answer "which presentation did this spec become, and when?".
// Rebuilds reuse the same presentation id under --update; this ledger is how
// you track iterations of a spec over time.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_HISTORY_PATH = path.join(os.homedir(), '.atris', 'deck-history.jsonl');

// Short, stable content hash of a spec — same spec -> same hash, so you can
// tell a no-op rebuild from a real change.
function specHash(spec) {
  return crypto.createHash('sha256').update(JSON.stringify(spec || {})).digest('hex').slice(0, 12);
}

function recordBuild({ spec, specPath = null, presentationId, url = null, mode = 'create', at = null }, historyPath = DEFAULT_HISTORY_PATH) {
  const entry = {
    at: at || new Date().toISOString(),
    presentationId: presentationId || null,
    url: url || (presentationId ? `https://docs.google.com/presentation/d/${presentationId}/edit` : null),
    specPath: specPath || null,
    specHash: specHash(spec),
    theme: (spec && spec.theme) || null,
    slideCount: (spec && spec.slides ? spec.slides.length : 0),
    mode,
  };
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.appendFileSync(historyPath, `${JSON.stringify(entry)}\n`);
  return entry;
}

function readHistory(historyPath = DEFAULT_HISTORY_PATH) {
  if (!fs.existsSync(historyPath)) return [];
  return fs
    .readFileSync(historyPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

// Filter the ledger by a spec path (exact or basename suffix), a 12-char hash,
// or a presentation id. No filter returns the whole ledger.
function historyFor(query, historyPath = DEFAULT_HISTORY_PATH) {
  const all = readHistory(historyPath);
  if (!query) return all;
  return all.filter((e) => (
    e.specPath === query
    || (e.specPath && e.specPath.endsWith(query))
    || e.specHash === query
    || e.presentationId === query
  ));
}

module.exports = {
  DEFAULT_HISTORY_PATH,
  specHash,
  recordBuild,
  readHistory,
  historyFor,
};
