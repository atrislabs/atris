const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { laterAtris, laterNotePath } = require('../commands/later');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// Point HOME and ATRIS_OPERATOR at known values so the greeting and any
// saved-account lookup never read the real machine, then put them back.
function withFakeEnv(fn) {
  const home = mkTmp('atris-later-home-');
  const saved = { HOME: process.env.HOME, ATRIS_OPERATOR: process.env.ATRIS_OPERATOR };
  process.env.HOME = home;
  process.env.ATRIS_OPERATOR = 'dana';
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    cleanup(home);
  }
}

function capture() {
  const lines = [];
  return { lines, log: (line) => lines.push(String(line)) };
}

test('later: --help, -h and help print usage, return 0, and write no note', () => {
  withFakeEnv(() => {
    for (const flag of ['--help', '-h', 'help']) {
      const root = mkTmp('atris-later-help-');
      try {
        const out = capture();
        const code = laterAtris([flag], { root, log: out.log });
        assert.strictEqual(code, 0, `exit code for ${flag}`);
        assert.deepStrictEqual(out.lines, ['Usage: atris later "<sentence>"']);
        assert.strictEqual(fs.existsSync(laterNotePath(root)), false);
      } finally {
        cleanup(root);
      }
    }
  });
});

test('later: no sentence (or only flags) prints usage, returns 2, and writes no note', () => {
  withFakeEnv(() => {
    const root = mkTmp('atris-later-empty-');
    try {
      const bare = capture();
      assert.strictEqual(laterAtris([], { root, log: bare.log }), 2);
      assert.deepStrictEqual(bare.lines, ['Usage: atris later "<sentence>"']);

      const flagsOnly = capture();
      assert.strictEqual(laterAtris(['--json', '--yes'], { root, log: flagsOnly.log }), 2);
      assert.deepStrictEqual(flagsOnly.lines, ['Usage: atris later "<sentence>"']);

      assert.strictEqual(fs.existsSync(laterNotePath(root)), false);
    } finally {
      cleanup(root);
    }
  });
});

test('later: saves the sentence, drops flags and trailing punctuation, and replies with the remember line', () => {
  withFakeEnv(() => {
    const root = mkTmp('atris-later-save-');
    try {
      const out = capture();
      const code = laterAtris(['--verbose', 'call', 'mom', 'tomorrow.', '--yes'], { root, log: out.log });

      assert.strictEqual(code, 0);
      assert.strictEqual(fs.readFileSync(laterNotePath(root), 'utf8'), 'call mom tomorrow\n');

      // First log is the blank spacer line, then the rendered reply.
      assert.strictEqual(out.lines[0], '');
      assert.strictEqual(
        out.lines[1],
        ["hey dana, I'll remember call mom tomorrow.", '', 'next: atris do'].join('\n'),
      );
    } finally {
      cleanup(root);
    }
  });
});

test('later: next step is "atris" when the folder already holds visible work', () => {
  withFakeEnv(() => {
    const root = mkTmp('atris-later-visible-');
    try {
      fs.writeFileSync(path.join(root, 'draft.md'), '# draft\n');
      // Dotfiles are not user work, so they must not change the next step.
      fs.writeFileSync(path.join(root, '.hidden'), 'x');

      const out = capture();
      assert.strictEqual(laterAtris(['ship', 'the', 'draft'], { root, log: out.log }), 0);
      assert.match(out.lines[1], /\nnext: atris$/);
    } finally {
      cleanup(root);
    }
  });
});

test('later: an over-long sentence is clipped to 72 characters with an ellipsis', () => {
  withFakeEnv(() => {
    const root = mkTmp('atris-later-long-');
    try {
      const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
      const out = capture();
      assert.strictEqual(laterAtris([long], { root, log: out.log }), 0);

      const saved = fs.readFileSync(laterNotePath(root), 'utf8').replace(/\n$/, '');
      assert.ok(saved.length <= 72, `saved note is ${saved.length} chars`);
      assert.ok(saved.endsWith('...'), `expected ellipsis, got: ${saved}`);
      assert.ok(out.lines[1].startsWith(`hey dana, I'll remember ${saved}.`));
    } finally {
      cleanup(root);
    }
  });
});
