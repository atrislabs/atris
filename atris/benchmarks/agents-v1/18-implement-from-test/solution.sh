set -eu
cat > leaders.js <<'JS'
'use strict';

function topScores(entries, limit = 3) {
  return [...entries]
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, limit)
    .map((entry) => entry.name);
}

module.exports = { topScores };
JS
