#!/usr/bin/env node
'use strict';

// Pre-commit gate for the exact failure that broke master on 2026-07-02:
// one agent committed commands/mission.js destructuring { hasAgentJargon }
// from ./autoland while the export sat uncommitted in another agent's
// working tree. Destructuring a missing export is SILENT (undefined, no
// throw), so syntax checks and require smokes both pass — the crash waits
// for the first user. This script materializes the STAGED tree, requires
// every staged js module, and verifies each destructured require name
// exists on the resolved module.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function sh(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${res.stderr || res.stdout}`);
  return res.stdout;
}

function stagedJsFiles(repoRoot) {
  const out = sh('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], { cwd: repoRoot });
  return out.split('\n').map((l) => l.trim())
    .filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
    // Benchmark fixtures are test data, not modules: some are broken by
    // design (syntax-triage, broken-imports) so agents can be scored on
    // repairing them. Loading them here would block committing the pack.
    .filter((f) => !f.startsWith('atris/benchmarks/'));
}

// Drop block comments and full-line // comments so documentation examples of
// the destructure pattern are never treated as real imports.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');
}

// `const { a, b: c } = require('./x')` -> [{ names: ['a','b'], spec: './x' }]
function destructuredRequires(source) {
  const found = [];
  const re = /const\s*\{([^}]+)\}\s*=\s*require\(\s*(['"])([^'"]+)\2\s*\)/g;
  let m;
  while ((m = re.exec(stripComments(source))) !== null) {
    const names = m[1]
      .split(',')
      .map((part) => part.split(':')[0].trim())
      .filter((n) => n && !n.startsWith('...'));
    found.push({ names, spec: m[3] });
  }
  return found;
}

function main() {
  const repoRoot = sh('git', ['rev-parse', '--show-toplevel']).trim();
  const files = stagedJsFiles(repoRoot);
  if (!files.length) return 0;

  // Materialize the staged tree so checks see what the COMMIT will contain,
  // not whatever half-edited state the working tree is in.
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-precommit-'));
  try {
    sh('git', ['checkout-index', '-a', `--prefix=${stage}${path.sep}`], { cwd: repoRoot });
    // Staged modules may require real dependencies; resolve them against the
    // repo's installed node_modules, not the empty temp tree.
    const repoModules = path.join(repoRoot, 'node_modules');
    if (fs.existsSync(repoModules) && !fs.existsSync(path.join(stage, 'node_modules'))) {
      fs.symlinkSync(repoModules, path.join(stage, 'node_modules'), 'dir');
    }
    const problems = [];
    for (const file of files) {
      const abs = path.join(stage, file);
      if (!fs.existsSync(abs)) continue;
      // bin/ and scripts/ are entrypoints that execute on require; check their
      // imports statically but do not load them.
      const entrypoint = file.startsWith('bin/') || file.startsWith('scripts/');
      if (!entrypoint) {
        try {
          require(abs);
        } catch (err) {
          problems.push(`${file}: fails to load — ${err.message.split('\n')[0]}`);
          continue;
        }
      }
      const source = fs.readFileSync(abs, 'utf8');
      for (const { names, spec } of destructuredRequires(source)) {
        if (!spec.startsWith('.')) continue;
        let dep;
        try {
          dep = require(require.resolve(spec, { paths: [path.dirname(abs)] }));
        } catch {
          continue; // load failure of the dep is reported when the dep itself is staged
        }
        for (const name of names) {
          if (dep && typeof dep === 'object' && !(name in dep)) {
            problems.push(`${file}: destructures { ${name} } from '${spec}' but the module does not export it`);
          }
        }
      }
    }
    if (problems.length) {
      console.error('pre-commit load check failed:');
      for (const p of problems) console.error(`  - ${p}`);
      console.error('These break at runtime for anyone who installs this commit. Stage the missing half or fix the import.');
      return 1;
    }
    return 0;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

if (require.main === module) process.exit(main());
