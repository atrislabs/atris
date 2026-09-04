'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TREE_HASH_SCHEMA = 'atris.tree_hash.v1';
const FIXED_FILES = [
  'atris.md',
  'atris/CLAUDE.md',
  'atris/atris.md',
];

function optionalChildren(root, parent, filename) {
  const directory = path.join(root, ...parent.split('/'));
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return [];
    throw error;
  }
  return entries.map((entry) => `${parent}/${entry.name}/${filename}`);
}

function optionalBytes(root, relativePath) {
  try {
    return fs.readFileSync(path.join(root, ...relativePath.split('/')));
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
    throw error;
  }
}

function computeTreeHash(root = process.cwd()) {
  const workspaceRoot = path.resolve(root);
  const stat = fs.statSync(workspaceRoot);
  if (!stat.isDirectory()) throw new Error(`tree hash root is not a directory: ${workspaceRoot}`);
  fs.accessSync(workspaceRoot, fs.constants.R_OK);

  const paths = [
    ...FIXED_FILES,
    ...optionalChildren(workspaceRoot, 'atris/skills', 'SKILL.md'),
    ...optionalChildren(workspaceRoot, 'atris/team', 'MEMBER.md'),
  ].sort();
  const manifest = [];
  for (const relativePath of paths) {
    const bytes = optionalBytes(workspaceRoot, relativePath);
    if (bytes === null) continue;
    manifest.push({
      path: relativePath,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    });
  }
  const hash = crypto.createHash('sha256')
    .update(manifest.map((file) => `${file.path}\0${file.sha256}\n`).join(''))
    .digest('hex');
  return {
    schema: TREE_HASH_SCHEMA,
    hash,
    short: hash.slice(0, 12),
    files: manifest.length,
    manifest,
  };
}

function treeHashFor(root) {
  try {
    return computeTreeHash(root).hash;
  } catch {
    return null;
  }
}

module.exports = {
  TREE_HASH_SCHEMA,
  computeTreeHash,
  treeHashFor,
};
