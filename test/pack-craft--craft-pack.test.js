'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { craftPack } = require('../commands/pack-craft');

function makeTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function clearAtrisEnv() {
  const saved = new Map();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  }
  return saved;
}

function isolateHome(home, fn) {
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  const savedAtris = clearAtrisEnv();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return fn();
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedProfile;
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_') && !savedAtris.has(key)) delete process.env[key];
    }
    for (const [key, value] of savedAtris) process.env[key] = value;
  }
}

function capture(fn) {
  const logs = [];
  const errors = [];
  const log = console.log;
  const errorLog = console.error;
  console.log = (...args) => logs.push(args.map((part) => String(part)).join(' '));
  console.error = (...args) => errors.push(args.map((part) => String(part)).join(' '));
  try {
    return { value: fn(), logs, errors, thrown: null };
  } catch (thrown) {
    return { value: undefined, logs, errors, thrown };
  } finally {
    console.log = log;
    console.error = errorLog;
  }
}

function bootText(topic) {
  return [
    '# research pack boot',
    '',
    `you are filling a research pack on ${topic}.`,
    '',
    'method:',
    '- gather sources',
    '- write wiki-style pages under wiki/ (one concept per file, sources cited inline as plain urls)',
    '- keep atris/now.md updated with what is done and what is next (next = researchable questions, not tasks)',
    '- never fabricate citations',
    '- prefer primary sources; a secondary source is fine when the primary is unreachable, but say so inline next to the citation',
    '- add a not-affiliated disclaimer in README.md if the topic is a person or company',
    '',
    'when the pack answers its topic well, bump pack.json to 0.1.0 and it is ready to publish with:',
    '',
    '    atris pack publish --push',
    '',
  ].join('\n');
}

function readmeText(topic, title) {
  return [
    `# ${title}`,
    '',
    `research pack on ${topic}.`,
    '',
    'run your agent in this folder.',
    '',
  ].join('\n');
}

function nowText(topic) {
  return `nothing gathered yet. start with the 3 most load-bearing questions about ${topic}.\n`;
}

function wikiText() {
  return [
    '# wiki index',
    '',
    'pages: none yet',
    '',
  ].join('\n');
}

function assertPack(target, topic, slug, title, author, extra = []) {
  const manifest = {
    name: slug,
    slug,
    title,
    description: `research pack on ${topic}, in progress`,
    author,
    tags: [],
    version: '0.0.1',
    versions: [],
  };
  assert.strictEqual(
    fs.readFileSync(path.join(target, 'pack.json'), 'utf8'),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  assert.strictEqual(fs.readFileSync(path.join(target, 'atris', 'atris.md'), 'utf8'), bootText(topic));
  assert.strictEqual(fs.readFileSync(path.join(target, 'atris', 'now.md'), 'utf8'), nowText(topic));
  assert.strictEqual(fs.readFileSync(path.join(target, 'README.md'), 'utf8'), readmeText(topic, title));
  assert.strictEqual(fs.readFileSync(path.join(target, 'wiki', 'index.md'), 'utf8'), wikiText());
  assert.deepStrictEqual(
    fs.readdirSync(target).sort(),
    ['README.md', 'atris', 'pack.json', 'wiki', ...extra].sort()
  );
  assert.deepStrictEqual(fs.readdirSync(path.join(target, 'atris')).sort(), ['atris.md', 'now.md']);
  assert.deepStrictEqual(fs.readdirSync(path.join(target, 'wiki')).sort(), ['index.md']);
}

describe('craftPack', { concurrency: false }, () => {
  test('a normal topic writes the research pack and prints the next command', () => {
    const home = makeTemp('atris-craft-pack-home-');
    const cwd = makeTemp('atris-craft-pack-cwd-');
    try {
      const args = ['Ada Lovelace', '--dir', 'notes'];
      const snapshot = args.slice();
      const result = isolateHome(home, () => capture(() => craftPack(args, cwd)));

      assert.strictEqual(result.value, 0);
      assert.strictEqual(result.thrown, null);
      assert.deepStrictEqual(result.errors, []);
      assert.deepStrictEqual(result.logs, [
        'created ada-lovelace -> notes',
        'cd notes && claude',
      ]);
      assert.deepStrictEqual(args, snapshot);
      assert.deepStrictEqual(fs.readdirSync(home), []);
      assertPack(
        path.join(cwd, 'notes'),
        'Ada Lovelace',
        'ada-lovelace',
        'Ada Lovelace',
        'unknown author'
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('odd names, a saved author, and --force still write a usable pack', () => {
    const home = makeTemp('atris-craft-pack-home-');
    const cwd = makeTemp('atris-craft-pack-cwd-');
    try {
      fs.mkdirSync(path.join(home, '.atris'), { recursive: true });
      fs.writeFileSync(
        path.join(home, '.atris', 'credentials.json'),
        JSON.stringify({ email: '  researcher@example.com  ' })
      );

      const helpArgs = ['Help'];
      const helped = isolateHome(home, () => capture(() => craftPack(helpArgs, cwd)));
      assert.strictEqual(helped.value, 0);
      assert.strictEqual(helped.thrown, null);
      assert.deepStrictEqual(helped.logs, [
        'created help -> help',
        'cd help && claude',
      ]);
      assert.deepStrictEqual(helpArgs, ['Help']);
      assertPack(path.join(cwd, 'help'), 'Help', 'help', 'Help', 'researcher@example.com');

      const quotedArgs = ['!!!', '--dir=O\'Brien Pack'];
      const quoted = isolateHome(home, () => capture(() => craftPack(quotedArgs, cwd)));
      assert.strictEqual(quoted.value, 0);
      assert.deepStrictEqual(quoted.logs, [
        "created atris-pack -> O'Brien Pack",
        "cd 'O'\\''Brien Pack' && claude",
      ]);
      assert.deepStrictEqual(quotedArgs, ['!!!', '--dir=O\'Brien Pack']);
      assertPack(
        path.join(cwd, "O'Brien Pack"),
        '!!!',
        'atris-pack',
        'Atris Pack',
        'researcher@example.com'
      );

      const forcedDir = path.join(cwd, 'redo-pack');
      fs.mkdirSync(forcedDir);
      fs.writeFileSync(path.join(forcedDir, 'notes.txt'), 'keep me');
      const forceArgs = ['redo topic', '--force', '--dir', 'redo-pack'];
      const forced = isolateHome(home, () => capture(() => craftPack(forceArgs, cwd)));
      assert.strictEqual(forced.value, 0);
      assert.deepStrictEqual(forced.logs, [
        'created redo-topic -> redo-pack',
        'cd redo-pack && claude',
      ]);
      assert.strictEqual(fs.readFileSync(path.join(forcedDir, 'notes.txt'), 'utf8'), 'keep me');
      assertPack(forcedDir, 'redo topic', 'redo-topic', 'Redo Topic', 'researcher@example.com', ['notes.txt']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('empty input and bad targets stop before any pack files are written', () => {
    const home = makeTemp('atris-craft-pack-home-');
    const cwd = makeTemp('atris-craft-pack-cwd-');
    try {
      isolateHome(home, () => {
        const helpArgs = [[], [''], ['help'], ['--help'], ['-h'], ['help', '--force', '--dir', 'nope']];
        for (const args of helpArgs) {
          const result = capture(() => craftPack(args.slice(), cwd));
          assert.deepStrictEqual(result.value, { needsHelp: true }, JSON.stringify(args));
          assert.strictEqual(result.thrown, null, JSON.stringify(args));
          assert.deepStrictEqual(result.logs, [], JSON.stringify(args));
          assert.deepStrictEqual(result.errors, [], JSON.stringify(args));
        }
        assert.deepStrictEqual(fs.readdirSync(cwd), []);

        const unknownArgs = ['routing', 'extra', '--weird'];
        const unknown = capture(() => craftPack(unknownArgs, cwd));
        assert.ok(unknown.thrown instanceof Error);
        assert.strictEqual(unknown.thrown.message, 'unknown pack craft argument: extra --weird');
        assert.deepStrictEqual(unknown.logs, []);
        assert.deepStrictEqual(unknownArgs, ['routing', 'extra', '--weird']);

        const missingDir = ['routing', '--dir', '--force'];
        const missing = capture(() => craftPack(missingDir, cwd));
        assert.ok(missing.thrown instanceof Error);
        assert.strictEqual(missing.thrown.message, '--dir requires a value');
        assert.deepStrictEqual(missing.logs, []);
        assert.deepStrictEqual(missingDir, ['routing', '--dir', '--force']);
        assert.deepStrictEqual(fs.readdirSync(cwd), []);

        const existing = path.join(cwd, 'existing');
        fs.mkdirSync(existing);
        fs.writeFileSync(path.join(existing, 'notes.txt'), 'keep me');
        const blocked = capture(() => craftPack(['existing topic', '--dir', 'existing'], cwd));
        assert.ok(blocked.thrown instanceof Error);
        assert.strictEqual(
          blocked.thrown.message,
          'target is not empty: existing. rerun with --force to overwrite.'
        );
        assert.deepStrictEqual(blocked.logs, []);
        assert.strictEqual(fs.readFileSync(path.join(existing, 'notes.txt'), 'utf8'), 'keep me');
        assert.strictEqual(fs.existsSync(path.join(existing, 'pack.json')), false);

        fs.writeFileSync(path.join(cwd, 'blocked-file'), 'keep');
        const fileTarget = capture(() => craftPack(['topic', '--dir', 'blocked-file'], cwd));
        assert.ok(fileTarget.thrown instanceof Error);
        assert.strictEqual(
          fileTarget.thrown.message,
          'target is not empty: blocked-file. rerun with --force to overwrite.'
        );
        assert.strictEqual(fs.readFileSync(path.join(cwd, 'blocked-file'), 'utf8'), 'keep');

        fs.mkdirSync(path.join(home, '.atris'), { recursive: true });
        fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), '{not json');
        const broken = capture(() => craftPack(['broken creds'], cwd));
        assert.strictEqual(broken.thrown, null);
        assert.strictEqual(broken.value, 0);
        assertPack(
          path.join(cwd, 'broken-creds'),
          'broken creds',
          'broken-creds',
          'Broken Creds',
          'unknown author'
        );

        fs.writeFileSync(
          path.join(home, '.atris', 'credentials.json'),
          JSON.stringify({ email: '   ' })
        );
        const blank = capture(() => craftPack(['blank email'], cwd));
        assert.strictEqual(blank.thrown, null);
        assert.strictEqual(blank.value, 0);
        assertPack(
          path.join(cwd, 'blank-email'),
          'blank email',
          'blank-email',
          'Blank Email',
          'unknown author'
        );
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
