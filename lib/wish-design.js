'use strict';

const fs = require('fs');
const path = require('path');

const DESIGN_BRIEF_PATHS = [
  path.join('atris', 'skills', 'design', 'SKILL.md'),
  path.join('atris', 'policies', 'atris-design.md'),
  path.join('.atris', 'theme.json'),
];

const FRONTEND_WISH_RE = /\b(ui|page|design|frontend|component|style|theme|landing|dashboard|layout|css|button|font|color|hero|nav|cards?)\b/i;
const NEGATIVE_COLLOCATION_RE = /\b(?:code\s+style|page\s+size|button\s+up)\b/i;
const BACKEND_CONTEXT_RE = /\b(?:api|json|endpoint|terminal|log|logs|deploy|release|script|build|pipeline|step|compress|minify|server|cache|config|webhook|payloads?|secrets?)\b/i;
const PATH_CONTEXT_RE = /(?:^|\s)(?:lib|bin|scripts)\/|\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.\/-]+\b/;
const WEAK_FRONTEND_RE = /\b(?:page|design|style|theme|screen|button|font|color|landing)\b/i;
const WEAK_ASSET_SURFACE_RE = /\b(?:cards?|images?)\b/i;
const VISUAL_PERCEPTION_RE = /\b(?:cramped|spacing|padding|whitespace|dense|crowded|looks?\s+like|looks|boring|bland|ugly|prettier|pretty|beautiful|gorgeous|plain|breathing\s+room|washes?\s+out)\b/i;
const UI_SURFACE_RE = /\b(?:bar|headers?|footers?|toolbar|sidebar|modal|dropdown|tooltip|screen|website|site|mobile|viewport|cards?|charts?)\b/i;
const SOLID_UI_SURFACE_RE = /\b(?:bar|headers?|footers?|toolbar|sidebar|modal|dropdown|tooltip|website|site|mobile|viewport|cards?|charts?)\b/i;
const STATE_COLLOCATION_RE = /\b(?:empty|loading|error)\s+state\b/i;
const STRONG_FRONTEND_RE = /\b(?:ui|frontend|component|dashboard|layout|css|hero|nav)\b/i;
const FOLD_COLLOCATION_RE = /\b(?:above\s+the\s+fold|below\s+the\s+fold|the\s+fold|fold)\b/i;
const MODE_COLLOCATION_RE = /\bdark\s+mode\b/i;

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
  const raw = String(text || '');
  if (!raw.trim()) return false;
  if (NEGATIVE_COLLOCATION_RE.test(raw)) return false;
  if (/\blanding\b(?!\s+page\b)/i.test(raw)) return false;

  const weakMatches = raw.match(new RegExp(WEAK_FRONTEND_RE.source, 'gi')) || [];
  const visualPositive = VISUAL_PERCEPTION_RE.test(raw) || FOLD_COLLOCATION_RE.test(raw) || MODE_COLLOCATION_RE.test(raw);
  const backendContext = BACKEND_CONTEXT_RE.test(raw) || PATH_CONTEXT_RE.test(raw);
  if (backendContext
    && WEAK_ASSET_SURFACE_RE.test(raw)
    && !STRONG_FRONTEND_RE.test(raw)
    && !visualPositive
    && !STATE_COLLOCATION_RE.test(raw)
    && !/\blanding\s+page\b/i.test(raw)) {
    return false;
  }
  const weakOnly = weakMatches.length > 0
    && !STRONG_FRONTEND_RE.test(raw)
    && !visualPositive
    && !UI_SURFACE_RE.test(raw)
    && !STATE_COLLOCATION_RE.test(raw)
    && !/\blanding\s+page\b/i.test(raw);
  if (weakOnly && backendContext) return false;
  const backendWeakOnly = weakMatches.length > 0
    && backendContext
    && !STRONG_FRONTEND_RE.test(raw)
    && !visualPositive
    && !SOLID_UI_SURFACE_RE.test(raw)
    && !STATE_COLLOCATION_RE.test(raw)
    && !/\blanding\s+page\b/i.test(raw);
  if (backendWeakOnly) return false;

  return STATE_COLLOCATION_RE.test(raw)
    || visualPositive
    || UI_SURFACE_RE.test(raw)
    || FOLD_COLLOCATION_RE.test(raw)
    || MODE_COLLOCATION_RE.test(raw)
    || /\blanding\s+page\b/i.test(raw)
    || STRONG_FRONTEND_RE.test(raw)
    || FRONTEND_WISH_RE.test(raw);
}

module.exports = {
  detectDesignContext,
  isFrontendWish,
};
