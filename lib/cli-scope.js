'use strict';

const path = require('path');

function parseScopeFlag(args = []) {
  const list = Array.isArray(args) ? args : [];
  const global = list.includes('--global') || list.includes('-g');
  return {
    kind: global ? 'global' : 'workspace',
    global,
    args: list.filter((arg) => arg !== '--global' && arg !== '-g'),
  };
}

function pathUnderRoot(candidate, root) {
  if (!candidate || !root) return false;
  const resolvedCandidate = path.resolve(String(candidate));
  const resolvedRoot = path.resolve(String(root));
  return resolvedCandidate === resolvedRoot
    || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

module.exports = {
  parseScopeFlag,
  pathUnderRoot,
};
