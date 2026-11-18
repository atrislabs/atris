'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { changedFiles, cover, requirers } = require('./ci-quick-check');
const shards = require('./ci-test-shard');

const GUARDS = ['test/repo-hygiene.test.js', 'test/model-name-ratchet.test.js'];
const SOURCES = /^(?:commands|lib|scripts|utils)\/.+\.[cm]?js$/;
const PHONE = /^(?:lib\/(?:gm(?:-|\.)|headless-chrome\.)|commands\/gm(?:-|\.)|scripts\/(?:gm-|orb-walk(?:-|\.)))/;
const SHARED = /^(?:bin\/|\.github\/|test\/(?:helpers\/|fixtures\/|ci-|fast-tests\.txt)|scripts\/(?:ci-|pre-commit|publish-|release)|utils\/(?:auth|api|config|owner-identity)\.|lib\/(?:task-db|workspace-root|workspace-safety|state-home|git-spawn|tool-path|runtime-bootstrap|runner-command|account-bound)\.)/;
const SENSITIVE = /(?:^|[/-])(?:auth|oauth|permission|permissions|security|secret|secrets|credential|credentials|billing|payment|payments|wallet|token|tokens|encryption|signing|api-key)(?:[-/.]|$)/;
const DOCS = /^(?:(?:README|GETTING_STARTED|ROADMAP|FOR_AGENTS)\.md|docs\/.+\.md|atris\/(?:MAP\.md|refs\/.+\.md|features\/.+\/(?:idea|build|validate)\.md))$/i;
// These command modules dispatch many unrelated features and import each
// other. Entering one from a feature selects tests of the command itself.
// Changes to a dispatcher run the entire suite, including its API consumers.
const DISPATCHERS = new Set(['commands/mission.js', 'commands/task.js', 'commands/member.js', 'commands/gm.js']);
const TEST = /(?:[._-]test|^test-[^/]+)\.[cm]?[jt]s$/;

const full = reason => ({ full: true, reason, files: [] });

function plan(root, changedPaths) {
  const files = [...new Set(changedPaths)].sort();
  const candidates = new Set(shards.discover(root));
  if (GUARDS.some(file => !candidates.has(file))) return full('a permanent test is missing');
  const picked = new Set(GUARDS);
  const sources = [];
  const changedTests = [];
  for (const file of files) {
    if (DOCS.test(file)) continue;
    if (SHARED.test(file) || SENSITIVE.test(file) || DISPATCHERS.has(file)) return full(`shared infrastructure or a sensitive file changed: ${file}`);
    if (candidates.has(file) && TEST.test(path.basename(file))) {
      picked.add(file);
      changedTests.push(file);
      continue;
    }
    if (!SOURCES.test(file) || !fs.existsSync(path.join(root, file))) return full(`no focused coverage rule for ${file}`);
    sources.push(file);
  }

  if (sources.length || changedTests.length) {
    // An integration test may import a test helper that imports a command.
    // Preserve these paths. A command calling back into the CLI dispatcher
    // connects nearly every feature; that route is covered by command-specific
    // black-box tests below. Changing the dispatcher itself selects everything.
    const graph = requirers(root, candidates);
    for (const [file, callers] of graph) {
      for (const caller of callers) {
        if (caller.startsWith('bin/') || (DISPATCHERS.has(file) && !candidates.has(caller))) callers.delete(caller);
      }
      if (!callers.size) graph.delete(file);
    }
    // Unlike the quick screen, never truncate the nearest ring to fit a budget.
    const covering = new Map(cover(root, [...sources, ...changedTests], candidates, {
      graph, cap: Infinity, milliseconds: Infinity,
    }).map(entry => [entry.source, entry.tests]));
    for (const test of changedTests) {
      for (const consumer of covering.get(test) || []) picked.add(consumer);
    }
    const suites = [...candidates].filter(file => TEST.test(path.basename(file)));
    const texts = new Map();
    for (const file of sources) {
      const owned = new Set(covering.get(file));
      const stem = path.basename(file, path.extname(file));
      const invocation = file.startsWith('commands/') ? literalCommand(stem) : null;
      const phone = PHONE.test(file);
      for (const suite of suites) {
        const name = path.basename(suite).replace(/\.test\.[cm]?[jt]s$/, '');
        if (name === stem || name.startsWith(stem + '-') || (phone && (/^gm-phone(?:$|-)/.test(name) || name === 'orb-walk'))) {
          owned.add(suite);
          continue;
        }
        // A subprocess or a source-text assertion leaves no require edge.
        // Test files often spell the command as a literal argument or as a
        // shell invocation, or use a slash path in a source-file assertion.
        if (!texts.has(suite)) texts.set(suite, fs.readFileSync(path.join(root, suite), 'utf8'));
        const source = texts.get(suite);
        if (source.includes(file) || invocation?.test(source)) owned.add(suite);
      }
      if (!owned.size) return full(`no owning test found for ${file}`);
      for (const test of owned) picked.add(test);
    }
  }
  return {
    full: false,
    reason: sources.length ? `changed tests and suites covering ${sources.join(', ')}`
      : picked.size > GUARDS.length ? 'changed tests and permanent checks' : 'documentation or an empty change; permanent checks',
    files: [...picked].sort(),
  };
}

function literalCommand(command) {
  // Subprocesses leave no import edges. Match actual invocation shapes and
  // shell commands, avoiding unrelated UI data arrays like ['member', 'role'].
  const name = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:\\b(?:[\\w$]*(?:cli|atris|invoke|command)[\\w$]*|run)\\s*\\(\\s*\\[\\s*|\\b[\\w$]*(?:bin|cli|atris|entry)[\\w$]*\\s*,\\s*)['"]${name}['"]|\\batris[ \\t]+${name}(?![\\w-])`, 'i');
}

function runFiles(files, root) {
  if (!Array.isArray(files) || !files.length || files.some(file => typeof file !== 'string' ||
      !file || file.startsWith('-') || path.isAbsolute(file) || file.split(/[\\/]/).includes('..') ||
      !fs.statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile())) {
    console.error('the assigned test files are missing or invalid.');
    return 1;
  }
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.ATRIS_TEST_SPLIT;
  const run = spawnSync(process.execPath, ['--test', '--', ...files], { cwd: root, stdio: 'inherit', env });
  if (run.error) console.error(run.error.message);
  return run.status ?? 1;
}

function main(args, root = path.resolve(__dirname, '..')) {
  const [action, base, group] = args;
  const match = /^(\d+)\/(\d+)$/.exec(group || '');
  const index = Number(match?.[1]), count = Number(match?.[2]);
  if (args.length !== 3 || action !== 'run' || !base || !match || index < 1 || index > count || count > 1024) {
    console.error('use run BASE I/N, for example run HEAD^1 1/8.');
    return 1;
  }
  try {
    const result = plan(root, changedFiles(root, base));
    console.log(`${result.full ? 'full suite' : 'focused tests'}: ${result.reason}.`);
    if (result.full) return shards.main([group], root);
    const files = shards.assign(result.files, count)[index - 1].files;
    console.log(`group ${group} runs ${files.length} of ${result.files.length} selected test files.`);
    return files.length ? runFiles(files, root) : 0;
  } catch (err) {
    console.error(err.message);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { plan, main, runFiles };
