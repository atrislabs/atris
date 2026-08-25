'use strict';

/**
 * atris teach — local cases under ./atris/teach only.
 *
 *   atris teach                 list cases in atris/teach
 *   atris teach <id>            show one case file
 *   atris teach --help          usage
 *
 * Does not call the backend or dump account-global state.
 */

const fs = require('fs');
const path = require('path');

const TEACH_DIR = path.join('atris', 'teach');

function usage() {
  console.log('atris teach — local cases under ./atris/teach');
  console.log('');
  console.log('  atris teach              list case files in atris/teach');
  console.log('  atris teach <id>         show atris/teach/<id>.md (or .json)');
  console.log('  atris teach --help       this help');
  console.log('');
  console.log('Teach only reads ./atris/teach. It does not call the backend.');
}

function teachRoot(cwd = process.cwd()) {
  return path.join(path.resolve(cwd), TEACH_DIR);
}

function listCaseFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((name) => /\.(md|json)$/i.test(name))
    .sort((a, b) => a.localeCompare(b));
}

function resolveCaseFile(root, id) {
  const slug = String(id || '').replace(/\.(md|json)$/i, '');
  for (const ext of ['.md', '.json']) {
    const candidate = path.join(root, `${slug}${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function teach(subcommand, ...args) {
  const cwd = process.cwd();
  if (!subcommand || subcommand === 'list') {
    const root = teachRoot(cwd);
    if (!fs.existsSync(root)) {
      console.log('no atris/teach folder here. add cases under ./atris/teach.');
      return 0;
    }
    const files = listCaseFiles(root);
    if (!files.length) {
      console.log('atris/teach is empty.');
      return 0;
    }
    console.log(`cases in ${TEACH_DIR}:`);
    for (const name of files) console.log(`  ${name.replace(/\.(md|json)$/i, '')}`);
    return 0;
  }

  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    usage();
    return 0;
  }

  if (subcommand === 'add' || subcommand === 'run' || subcommand === 'guards'
    || subcommand === 'mine' || subcommand === 'drafts' || subcommand === 'fix'
    || subcommand === 'scaffold') {
    console.error('atris teach only reads ./atris/teach. backend teach verbs are disabled.');
    console.error('add a case file under atris/teach/<id>.md and run: atris teach <id>');
    return 2;
  }

  const root = teachRoot(cwd);
  const file = resolveCaseFile(root, subcommand);
  if (!file) {
    console.error(`no case "${subcommand}" in ${TEACH_DIR}`);
    return 1;
  }
  const extra = args.join(' ').trim();
  if (extra && extra !== '--raw') {
    console.error(`unknown teach option: ${extra}`);
    return 2;
  }
  const body = fs.readFileSync(file, 'utf8');
  process.stdout.write(body.endsWith('\n') ? body : `${body}\n`);
  return 0;
}

module.exports = teach;
