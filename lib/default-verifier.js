'use strict';

const fs = require('fs');
const path = require('path');

function resolveDefaultVerifier(root = process.cwd()) {
  const repoRoot = path.resolve(root);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    if (pkg.scripts && pkg.scripts.test) return 'npm test';
  } catch {}
  try {
    if (fs.statSync(path.join(repoRoot, 'test')).isDirectory()) return 'node --test';
  } catch {}
  return 'git diff --check';
}

module.exports = { resolveDefaultVerifier };
