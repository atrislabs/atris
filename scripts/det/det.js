#!/usr/bin/env node
// det/det.js — one entrypoint for the deterministic task scripts. A cheap model
// runs `node det.js` to see the whole catalog, then `node det.js <script> <mode>`
// to route its stdin through the right one. No need to know the file layout.
//
//   node det.js                      # print the catalog (task -> script -> modes)
//   node det.js --json               # same, machine-readable
//   node det.js extract urls < f     # route stdin through extract.js in urls mode
//   node det.js json csv < arr.json  # route stdin through json.js in csv mode
//
// The catalog is derived from the scripts themselves (their exported MODES /
// EXTRACTORS), so it can never drift from what actually runs.

'use strict';

const extract = require('./extract');
const json = require('./json');
const text = require('./text');
const hash = require('./hash');
const date = require('./date');

// git-facing scripts: they read the repo, not stdin, so they aren't routable
// through det.js. Listed here only so the front door surfaces all the tools —
// a cheap model running `det.js` sees these too and knows to run them directly.
const GIT_SCRIPTS = [
  {
    name: 'commit-msg',
    ask: 'draft a Conventional-Commits message from the staged diff',
    usage: 'git add -A && node scripts/det/commit-msg.js',
  },
  {
    name: 'changelog',
    ask: 'group commits since a ref/tag into a changelog',
    usage: 'node scripts/det/changelog.js [ref]',
  },
  {
    name: 'pr-description',
    ask: 'draft a PR title + area summary + test-plan from the branch diff',
    usage: 'node scripts/det/pr-description.js [base]',
  },
];

// script -> { ask, modes, run(mode, input) -> {text}|{error} }
const CATALOG = {
  extract: {
    ask: 'pull links / emails / code / numbers out of text',
    modes: Object.keys(extract.EXTRACTORS),
    run: (mode, input) => {
      const items = extract.extract(mode, input);
      return items === null ? { error: `unknown mode: ${mode}` } : { text: items.join('\n') };
    },
  },
  json: {
    ask: 'reformat / validate / flatten JSON (incl. JSON->CSV)',
    modes: json.MODES,
    run: json.run,
  },
  text: {
    ask: 'dedupe / sort / count / slugify / trim lines',
    modes: text.MODES,
    run: text.run,
  },
  hash: {
    ask: 'base64 / hex encode-decode, sha256 / sha1 / md5',
    modes: hash.MODES,
    run: hash.run,
  },
  date: {
    ask: 'epoch <-> ISO, weekday (all UTC)',
    modes: date.MODES,
    run: date.run,
  },
};

function catalogText() {
  const rows = Object.entries(CATALOG).map(
    ([name, s]) => `  ${name.padEnd(9)} ${s.modes.join(' ')}\n    ${s.ask}`
  );
  const gitRows = GIT_SCRIPTS.map((g) => `  ${g.name.padEnd(15)} ${g.usage}\n    ${g.ask}`);
  return (
    'deterministic task scripts — run: node det.js <script> <mode> < input\n\n' +
    rows.join('\n\n') +
    '\n\ngit-facing (read the repo, run the script directly; not via det.js):\n\n' +
    gitRows.join('\n\n') +
    '\n'
  );
}

function catalogJson() {
  const out = {};
  for (const [name, s] of Object.entries(CATALOG)) out[name] = { ask: s.ask, modes: s.modes };
  const git = {};
  for (const g of GIT_SCRIPTS) git[g.name] = { ask: g.ask, usage: g.usage };
  return JSON.stringify({ ...out, git }, null, 2);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    if (process.stdin.isTTY) resolve('');
  });
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--json');
  const wantJson = process.argv.includes('--json');
  const [script, mode] = args;

  if (!script) {
    process.stdout.write((wantJson ? catalogJson() : catalogText()) + '\n');
    return;
  }
  const git = GIT_SCRIPTS.find((g) => g.name === script);
  if (git) {
    process.stdout.write(`${git.name} reads the repo, not stdin — run it directly:\n  ${git.usage}\n`);
    return;
  }
  const entry = CATALOG[script];
  if (!entry) {
    process.stderr.write(`unknown script: ${script}\nscripts: ${Object.keys(CATALOG).join(' | ')}\n`);
    process.exit(2);
  }
  if (!mode || !entry.modes.includes(mode)) {
    process.stderr.write(`unknown mode: ${mode || '(none)'}\nmodes: ${entry.modes.join(' | ')}\n`);
    process.exit(2);
  }
  const input = await readStdin();
  const res = entry.run(mode, input);
  if (res.error) {
    process.stderr.write(res.error + '\n');
    process.exit(2);
  }
  if (res.text.length) process.stdout.write(res.text + '\n');
}

if (require.main === module) {
  main();
}

module.exports = { CATALOG, catalogJson, catalogText, GIT_SCRIPTS };
