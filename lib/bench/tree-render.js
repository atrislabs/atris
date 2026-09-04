'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { computeTreeHash } = require('../tree-hash');

const POINTER_BODY = [
  'Read atris.md at the workspace root first and follow it.',
  'Skills live under atris/skills, team briefs under atris/team.',
];

function writePointerIfAbsent(workspaceDir, filename) {
  const destination = path.join(workspaceDir, filename);
  if (fs.existsSync(destination)) return;
  fs.writeFileSync(destination, [`# ${filename}`, ...POINTER_BODY, ''].join('\n'), 'utf8');
}

function renderTreeInto(workspaceDir, treeRoot) {
  const workspace = path.resolve(workspaceDir);
  const root = path.resolve(treeRoot);
  const tree = computeTreeHash(root);
  fs.mkdirSync(workspace, { recursive: true });

  for (const entry of tree.manifest) {
    const source = path.join(root, ...entry.path.split('/'));
    const destination = path.join(workspace, ...entry.path.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }

  writePointerIfAbsent(workspace, 'CLAUDE.md');
  writePointerIfAbsent(workspace, 'AGENTS.md');
  return { tree_hash: tree.hash, files: tree.files };
}

function candidateError(source) {
  return new Error(`candidate source not found: ${source}`);
}

function materializeCandidate(source, repoRoot) {
  const candidate = String(source || '').trim();
  const directPath = path.resolve(candidate || '.');
  try {
    if (candidate && fs.statSync(directPath).isDirectory()) return directPath;
  } catch {
    // A non-directory source may still name a git ref.
  }

  if (!candidate || candidate.startsWith('-')) throw candidateError(source);
  const root = path.resolve(repoRoot || process.cwd());
  const archive = spawnSync('git', ['archive', '--format=tar', candidate], {
    cwd: root,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (archive.error || archive.status !== 0) throw candidateError(source);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-bench-candidate-'));
  const extract = spawnSync('tar', ['-x', '-C', tempDir], {
    cwd: root,
    input: archive.stdout,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  if (extract.error || extract.status !== 0) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw candidateError(source);
  }
  return tempDir;
}

module.exports = {
  materializeCandidate,
  renderTreeInto,
};
