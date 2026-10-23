const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skillCommand } = require('../commands/skill');

// These synchronous tests restore process globals before the next test runs.
function inSandbox(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-skill-command-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousLog = console.log;
  const output = [];
  try {
    process.chdir(root);
    process.env.HOME = root;
    console.log = (...args) => output.push(args.join(' '));
    // commands/skill.js reads no ATRIS_* environment variables.
    run(process.cwd(), output);
  } finally {
    console.log = previousLog;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('create writes a standard local skill with its supplied description', () => {
  inSandbox((root, output) => {
    skillCommand('create', 'daily-note', '--local', '--description=Use when x=y needs a note.');

    const skillPath = path.join(root, 'atris', 'skills', 'daily-note', 'SKILL.md');
    const content = fs.readFileSync(skillPath, 'utf8');
    assert.match(content, /^---\nname: daily-note\ndescription: "Use when x=y needs a note\."\nversion: 1\.0\.0\n/);
    assert.match(content, /tags:\n  - daily-note\n---/);
    assert.match(content, /1\. Step one\n2\. Step two\n3\. Step three/);
    assert.ok(output.includes('✓ Created atris/skills/daily-note/SKILL.md'));
    assert.ok(output.includes('  Template: standard (workflows + rules)'));
    assert.ok(output.includes(`  Edit: ${skillPath}`));
    for (const tool of ['.claude', '.codex', '.cursor']) {
      assert.strictEqual(fs.existsSync(path.join(root, tool)), false);
    }
  });
});

test('new alias creates a customer integration skill with a default description', () => {
  inSandbox((root, output) => {
    skillCommand('new', 'example-co/inbox-reader', '--integration', '--local');

    const skillPath = path.join(root, 'atris', 'customers', 'example-co', 'skills', 'inbox-reader', 'SKILL.md');
    const content = fs.readFileSync(skillPath, 'utf8');
    assert.match(content, /^---\nname: inbox-reader\n/);
    assert.match(content, /description: Integration skill for inbox-reader\. Use when user asks about inbox-reader-related tasks\./);
    assert.match(content, /  - inbox-reader\n  - integration\n/);
    assert.match(content, /## Bootstrap \(ALWAYS Run First\)/);
    assert.match(content, /## API Reference/);
    assert.match(content, /## Error Handling/);
    assert.ok(output.includes('✓ Created atris/customers/example-co/skills/inbox-reader/SKILL.md'));
    assert.ok(output.includes('  Template: integration (bootstrap + API reference + error handling)'));
    assert.strictEqual(fs.existsSync(path.join(root, 'atris', 'skills')), false);
  });
});

test('fix with no name reports an empty local skills folder and exits with an error', () => {
  inSandbox((root, output) => {
    const skillsDir = path.join(root, 'atris', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });

    const previousExit = process.exit;
    const previousError = console.error;
    const errors = [];
    const exitSignal = new Error('intercepted process exit');
    let exitCode;
    try {
      console.error = (...args) => errors.push(args.join(' '));
      process.exit = (code) => { exitCode = code; throw exitSignal; };
      assert.throws(() => skillCommand('fix'), (error) => error === exitSignal);
    } finally {
      process.exit = previousExit;
      console.error = previousError;
    }
    assert.strictEqual(exitCode, 1);
    assert.deepStrictEqual(errors, [
      'Skill "--all" not found. Run "atris skill list" to see available skills.'
    ]);
    assert.deepStrictEqual(output, []);
    assert.deepStrictEqual(fs.readdirSync(skillsDir), []);
    assert.deepStrictEqual(fs.readdirSync(root), ['atris']);
  });
});
