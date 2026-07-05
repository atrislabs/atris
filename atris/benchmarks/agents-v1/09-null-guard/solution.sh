set -eu
cat > scan.js <<'JS'
'use strict';

function extractHeadings(text) {
  return text.split('\n').filter((line) => line.startsWith('#'));
}

function lastHeadingLevel(text) {
  const headings = extractHeadings(text);
  if (headings.length === 0) return null;
  const last = headings[headings.length - 1];
  return last.match(/^#+/)[0].length;
}

module.exports = { extractHeadings, lastHeadingLevel };
JS
