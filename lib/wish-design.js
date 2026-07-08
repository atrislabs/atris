'use strict';

const fs = require('fs');
const path = require('path');

const DESIGN_BRIEF_PATHS = [
  path.join('atris', 'skills', 'design', 'SKILL.md'),
  path.join('atris', 'policies', 'atris-design.md'),
  path.join('.atris', 'theme.json'),
];

const FRONTEND_WISH_RE = /\b(ui|page|design|frontend|component|style|theme|landing|dashboard|layout|css|button|font|color|hero|nav)\b/i;

function toPosixPath(value) {
  return String(value || '').split(path.sep).join('/');
}

function readPackageJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function detectDesignContext(workspaceRoot = process.cwd()) {
  const root = path.resolve(workspaceRoot || process.cwd());
  const briefPaths = [];

  for (const relativePath of DESIGN_BRIEF_PATHS) {
    if (fs.existsSync(path.join(root, relativePath))) briefPaths.push(toPosixPath(relativePath));
  }

  const packagePath = path.join(root, 'package.json');
  let auditCommand = null;
  if (fs.existsSync(packagePath)) {
    const manifest = readPackageJson(packagePath);
    const scripts = manifest && typeof manifest === 'object' ? manifest.scripts : null;
    if (scripts && Object.prototype.hasOwnProperty.call(scripts, 'audit:design')) {
      briefPaths.push('package.json');
      auditCommand = 'npm run audit:design';
    }
  }

  return {
    hasDesign: briefPaths.length > 0,
    briefPaths,
    auditCommand,
  };
}

function isFrontendWish(text) {
  return FRONTEND_WISH_RE.test(String(text || ''));
}

module.exports = {
  detectDesignContext,
  isFrontendWish,
};
