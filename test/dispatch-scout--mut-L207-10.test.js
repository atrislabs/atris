'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (!process.env.PATH) {
  process.env.PATH = '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin';
}

const {
  SCOUT_PACK_SCHEMA,
  buildVerifiedScoutPack,
  checkoutCommit,
} = require('../lib/dispatch-scout');

const TASK = {
  display_id: 'CLI-1273',
  status: 'open',
  title: 'Fix alpha and beta dispatch context. Done: both entry points are covered. Check: git diff --check.',
};

function runGit(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: root,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com',
    },
  });
  assert.equal(result.status, 0, `${args.join(' ')} failed: ${result.stderr}`);
  return String(result.stdout || '').trim();
}

function makeFixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-scout-fixture-'));
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  const alphaExcerpt = [
    'function alphaEntry() {',
    "  return 'alpha dispatch context';",
    '}',
  ].join('\n');
  const alphaSource = ["'use strict';", ...Array.from({ length: 20 }, () => ''), alphaExcerpt, ''].join('\n');
  const betaExcerpt = [
    'function betaEntry() {',
    "  return 'beta dispatch context';",
    '}',
  ].join('\n');
  const mapLines = [
    '# fixture map',
    '- `lib/alpha.js:2` alphaEntry is the alpha dispatch context entry point.',
    '- `lib/beta.js:1` betaEntry is the beta dispatch context entry point.',
    '',
  ];
  fs.writeFileSync(path.join(root, 'atris', 'MAP.md'), mapLines.join('\n'));
  fs.writeFileSync(path.join(root, 'lib', 'alpha.js'), alphaSource);
  fs.writeFileSync(path.join(root, 'lib', 'beta.js'), `${betaExcerpt}\n`);
  runGit(root, ['init', '-q']);
  runGit(root, ['config', 'user.name', 'Fixture']);
  runGit(root, ['config', 'user.email', 'fixture@example.com']);
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '-qm', 'fixture']);
  return {
    root,
    commit: checkoutCommit(root),
    alphaExcerpt,
    alphaLine: alphaSource.split('\n').findIndex((line) => line === 'function alphaEntry() {') + 1,
    betaExcerpt,
  };
}

test('buildVerifiedScoutPack parses JSON embedded in surrounding text', async () => {
  const fixture = makeFixtureRepo();
  try {
    const rawPack = {
      schema: SCOUT_PACK_SCHEMA,
      task_id: TASK.display_id,
      checkout_commit: fixture.commit,
      hits: [
        {
          path: 'lib/alpha.js',
          line: fixture.alphaLine,
          excerpt: fixture.alphaExcerpt,
          why: 'This is the alpha entry point named by the task.',
        },
        {
          path: 'lib/beta.js',
          line: 1,
          excerpt: fixture.betaExcerpt,
          why: 'This is the beta entry point named by the task.',
        },
      ],
      map_gotchas: [],
      not_checked: [],
    };
    const stdout = `Here is the verified pack:\n${JSON.stringify(rawPack)}\nHope this helps!`;
    const pack = await buildVerifiedScoutPack({
      task: TASK,
      worktreePath: fixture.root,
      ask: async () => ({ ok: true, stdout }),
    });
    assert.ok(pack !== null, 'pack should not be null when JSON is embedded in surrounding text');
    assert.equal(pack.hits.length, 2);
    assert.equal(pack.checkout_commit, fixture.commit);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
