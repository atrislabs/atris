const fs = require('fs');
const path = require('path');

/**
 * Detect contradictions in lessons.md and lessons.json.
 *
 * Returns array of contradictions:
 * - P1: same slug, opposite outcome at later date
 * - P2: lesson applies_to file no longer exists, skipping [resolved]/observed/attempted>=3
 *
 * @param {string} cwd - workspace root
 * @returns {Array} array of {type, slug, evidence, remediation}
 */
function detectLessonContradictions(cwd) {
  const lessonsMdPath = path.join(cwd, 'atris', 'lessons.md');
  const lessonsJsonPath = path.join(cwd, 'atris', 'lessons.json');

  const contradictions = [];

  // Parse lessons.md
  const lessonsMdContent = fs.existsSync(lessonsMdPath)
    ? fs.readFileSync(lessonsMdPath, 'utf8')
    : '';

  // Format: - **[YYYY-MM-DD] slug** — pass|fail — prose
  const lessonRegex = /^-\s+\*\*\[(\d{4}-\d{2}-\d{2})\]\s+([a-z0-9-]+)\*\*\s*—\s*(pass|fail)\s*—\s*(\[resolved\])?\s*(.+)$/m;
  const lines = lessonsMdContent.split('\n');

  const lessonsBySlug = new Map(); // slug -> [{ date, outcome, lineNum, resolved }]

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(lessonRegex);
    if (!match) continue;

    const [, date, slug, outcome, resolved, prose] = match;
    if (!lessonsBySlug.has(slug)) {
      lessonsBySlug.set(slug, []);
    }
    lessonsBySlug.get(slug).push({
      date,
      outcome,
      lineNum: i + 1,
      resolved: !!resolved,
      prose: prose.trim(),
    });
  }

  // P1: same slug with opposite outcomes at later dates
  for (const [slug, entries] of lessonsBySlug) {
    // Sort by date
    const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));

    for (let i = 0; i < sorted.length - 1; i++) {
      const curr = sorted[i];
      const next = sorted[i + 1];

      // Skip if either is [resolved]
      if (curr.resolved || next.resolved) continue;

      // Opposite outcomes?
      if (curr.outcome !== next.outcome) {
        contradictions.push({
          type: 'P1_opposite_outcomes',
          slug,
          evidence: `${curr.outcome} on line ${curr.lineNum} (${curr.date}), then ${next.outcome} on later entry (${next.date})`,
        });
      }
    }
  }

  // P2: applies_to files that no longer exist
  if (fs.existsSync(lessonsJsonPath)) {
    let lessonsJson = {};
    try {
      lessonsJson = JSON.parse(fs.readFileSync(lessonsJsonPath, 'utf8'));
    } catch {
      // invalid JSON, skip
    }

    for (const [slug, entry] of Object.entries(lessonsJson)) {
      if (!entry.applies_to || !Array.isArray(entry.applies_to)) continue;

      // Skip if [resolved], observed, or attempted >= 3
      const status = entry.status || '';
      if (status === 'resolved' || status === 'observed') continue;

      const attempts = entry.attempts || 0;
      if (attempts >= 3) continue;

      // Check if files exist
      for (const filePath of entry.applies_to) {
        const fullPath = path.isAbsolute(filePath)
          ? filePath
          : path.join(cwd, filePath);

        if (!fs.existsSync(fullPath)) {
          contradictions.push({
            type: 'P2_missing_file',
            slug,
            evidence: `applies_to file no longer exists: ${filePath}`,
          });
        }
      }
    }
  }

  return contradictions;
}

module.exports = {
  detectLessonContradictions,
};
