'use strict';

function topScores(entries, limit = 3) {
  return entries.slice(0, limit).map((entry) => entry.name);
}

module.exports = { topScores };
