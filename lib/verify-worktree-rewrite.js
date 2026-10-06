'use strict';

// Member agents build in temporary copies of the repo
// (<arena>/.agent-worktrees/<project>/<name>, older ones under
// <arena>/agent-work-trees/...) and record their proof check pointed at that
// copy: "cd <arena>/.agent-worktrees/<project>/x && node scripts/t.mjs".
// The landing gate only runs checks relative to the main checkout, so it
// refused 201 of 218 finished items in project-obelisk every hour. Rewrite
// such a check relative to the main checkout so the landing pass reruns it
// there, and say in plain words when it cannot (the file it runs only exists
// on the agent's branch).

const fs = require('fs');
const path = require('path');

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function arenaDirFor(root) {
  let cursor = root;
  while (cursor && cursor !== path.dirname(cursor)) {
    if (path.basename(cursor) === 'arena') return cursor;
    cursor = path.dirname(cursor);
  }
  return path.dirname(root);
}

function copyRootPattern(root) {
  const arena = escapeRegex(arenaDirFor(root));
  const project = escapeRegex(path.basename(root));
  const name = '[A-Za-z0-9._-]+';
  return `(?:${[
    `${arena}/\\.agent-worktrees/${project}/${name}`,
    `${arena}/agent-work-trees/${project}/${name}`,
    `\\.\\./\\.agent-worktrees/${project}/${name}`,
    escapeRegex(root),
  ].join('|')})(?![A-Za-z0-9._-])`;
}

function stripQuotes(token) {
  return token.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
}

// Returns { command, rewritten, from }. `rewritten` is true only when the
// command named an agent copy (or the main checkout by absolute path) and
// now runs relative to the main checkout. A command that still names an
// agent copy after the rewrite is returned untouched with rewritten:false.
function rewriteWorktreeVerify(command, workspaceRoot) {
  const original = String(command || '').trim();
  const unchanged = { command: original, rewritten: false, from: null };
  if (!original || !workspaceRoot) return unchanged;
  const root = path.resolve(workspaceRoot);
  const anyRoot = copyRootPattern(root);
  if (!new RegExp(anyRoot).test(original)) return unchanged;

  let cmd = original;
  // ( cd X && cmd )  ->  cd X && cmd
  const paren = /^\((.*)\)$/s.exec(cmd);
  if (paren) cmd = paren[1].trim();
  // cd '<copy>[/sub]' && rest  ->  [cd sub && ]rest
  const cd = new RegExp(`^cd\\s+(['"]?)${anyRoot}(/[^'"\\s]*)?\\1\\s+&&\\s+(.+)$`, 's').exec(cmd);
  if (cd) {
    const sub = (cd[2] || '').replace(/^\/+|\/+$/g, '');
    cmd = sub ? `cd ${sub} && ${cd[3]}` : cd[3];
  }
  // npm --prefix <copy> run x  ->  npm run x
  cmd = cmd.replace(new RegExp(`\\bnpm\\s+--prefix\\s+(['"]?)${anyRoot}/?\\1\\s+`, 'g'), 'npm ');
  // '<copy>/a/b' -> a/b ; bare '<copy>' -> .
  cmd = cmd.replace(new RegExp(`(['"]?)${anyRoot}/([^'"\\s]+)\\1`, 'g'), (_m, _q, rest) => rest);
  cmd = cmd.replace(new RegExp(`(['"]?)${anyRoot}/?\\1(?=\\s|$)`, 'g'), '.');
  // Only plain path quoting is stripped; quoted text with spaces stays put.
  cmd = cmd.split(/(\s+)/).map((part) => (/^\s+$/.test(part) ? part : stripQuotes(part))).join('').trim();
  if (new RegExp(anyRoot).test(cmd) || /\.agent-worktrees|agent-work-trees/.test(cmd)) return unchanged;
  return { command: cmd, rewritten: true, from: original };
}

// Files a parsed check step reads by relative path: its folder, the script
// it runs, the file it tests. Used to tell "this check cannot run on main
// because its file only exists on the agent's branch" from a real failure.
function stepReferencedPaths(step) {
  const argv = Array.isArray(step?.argv) ? step.argv : [];
  const paths = [];
  if (step?.cwd) paths.push({ path: step.cwd, kind: 'dir' });
  const [bin, first, second] = argv;
  const looksLikePath = (token) => Boolean(token) && !String(token).startsWith('-') && /[/.]/.test(String(token));
  if (bin === 'node' && first === '--check' && looksLikePath(second)) paths.push({ path: second, kind: 'file' });
  else if (bin === 'node' && first === '--test') {
    for (const token of argv.slice(2)) {
      if (looksLikePath(token) && !String(token).includes('*') && /\.[cm]?[jt]s$/.test(token)) paths.push({ path: token, kind: 'file' });
    }
  } else if (bin === 'node' && looksLikePath(first)) paths.push({ path: first, kind: 'file' });
  if ((bin === 'python' || bin === 'python3' || /venv\/bin\/python3?$/.test(String(bin || ''))) && looksLikePath(first) && first !== '-m') {
    paths.push({ path: first, kind: 'file' });
  }
  if (bin === 'test' && (first === '-f' || first === '-s') && looksLikePath(second)) paths.push({ path: second, kind: 'file' });
  return paths;
}

// First referenced path missing from the main checkout, or null.
function missingOnMain(steps, workspaceRoot) {
  const root = path.resolve(workspaceRoot || process.cwd());
  for (const step of steps || []) {
    const base = step?.cwd ? path.resolve(root, step.cwd) : root;
    for (const ref of stepReferencedPaths(step)) {
      const target = ref.kind === 'dir' ? path.resolve(root, ref.path) : path.resolve(base, ref.path);
      if (!fs.existsSync(target)) {
        return path.relative(root, target) || ref.path;
      }
    }
  }
  return null;
}

module.exports = { rewriteWorktreeVerify, missingOnMain, stepReferencedPaths };
