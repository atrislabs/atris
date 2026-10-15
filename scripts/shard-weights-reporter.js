// node --test reporter that writes test/shard-weights.json: milliseconds per
// test file, rounded to 100ms so small swings do not churn the file.
// Used by scripts/ci-shard.js; see the refresh command there.
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

module.exports = async function* weights(source) {
  const perFile = {};
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    if (event.data.nesting !== 0 || !event.data.file) continue;
    const file = path.relative(ROOT, event.data.file).split(path.sep).join('/');
    perFile[file] = (perFile[file] || 0) + (event.data.details.duration_ms || 0);
  }
  const sorted = {};
  for (const file of Object.keys(perFile).sort()) sorted[file] = Math.max(100, Math.round(perFile[file] / 100) * 100);
  yield JSON.stringify(sorted, null, 2) + '\n';
};
