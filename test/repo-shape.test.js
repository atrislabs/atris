const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectDefaultVerify, getVerifyCommand } = require('../commands/autopilot');

const packageJson = require('../package.json');
const packageLock = require('../package-lock.json');

function makeTempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-shape-'));
}

test('detectDefaultVerify returns null for a bare directory', () => {
  const dir = makeTempRepo();
  try {
    assert.equal(detectDefaultVerify(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('npm package includes runtime workspace templates', () => {
  const files = packageJson.files || [];
  assert.ok(files.includes('templates/'), 'package.json files must include templates/ for business init');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'templates', 'business-starter', 'MAP.md')));
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'templates', 'business-starter', 'team', 'START_HERE.md')));
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'templates', 'research-canonical', 'MAP.md')));
});

test('npm package metadata matches the reviewed release version', () => {
  assert.equal(packageJson.version, '3.30.2');
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[''].version, packageJson.version);
});

test('npm package includes launchpad and deck assets', () => {
  const files = packageJson.files || [];
  assert.ok(files.includes('commands/'), 'package.json files must include commands/ for launchpad');
  assert.ok(files.includes('decks/'), 'package.json files must include decks/ for deck artifacts');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'commands', 'launchpad.js')));
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'decks', 'atris-seed-pitch-v7.json')));
});

test('npm package must not ship local workspace wiki', () => {
  const files = packageJson.files || [];
  const wikiEntries = files.filter((entry) => String(entry).startsWith('atris/wiki'));
  assert.deepEqual(wikiEntries, [], 'atris/wiki/ is local-only; users scaffold their own via init/ingest');
});

test('detectDefaultVerify returns npm test for Node package with real test script', () => {
  const dir = makeTempRepo();
  try {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'node --test' } })
    );
    assert.equal(detectDefaultVerify(dir), 'npm test');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectDefaultVerify ignores stub test script from npm init default', () => {
  const dir = makeTempRepo();
  try {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } })
    );
    assert.equal(detectDefaultVerify(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectDefaultVerify returns pytest for pyproject.toml', () => {
  const dir = makeTempRepo();
  try {
    fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "x"\n');
    assert.equal(detectDefaultVerify(dir), 'pytest');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectDefaultVerify returns pytest for setup.py fallback', () => {
  const dir = makeTempRepo();
  try {
    fs.writeFileSync(path.join(dir, 'setup.py'), '# stub\n');
    assert.equal(detectDefaultVerify(dir), 'pytest');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectDefaultVerify returns cargo test for Rust', () => {
  const dir = makeTempRepo();
  try {
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname = "x"\n');
    assert.equal(detectDefaultVerify(dir), 'cargo test');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectDefaultVerify returns go test for Go', () => {
  const dir = makeTempRepo();
  try {
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module example\ngo 1.21\n');
    assert.equal(detectDefaultVerify(dir), 'go test ./...');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectDefaultVerify prefers Node when both Node and Python files exist', () => {
  const dir = makeTempRepo();
  try {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'node --test' } })
    );
    fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "x"\n');
    assert.equal(detectDefaultVerify(dir), 'npm test');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getVerifyCommand returns explicit Verify when TODO.md has one', () => {
  const dir = makeTempRepo();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'atris', 'TODO.md'),
      [
        '# TODO.md',
        '',
        '## Backlog',
        '- **T1:** explicit task [execute]',
        '  **Verify:** exit 0',
        '',
        '## In Progress',
        '',
        '## Completed',
        ''
      ].join('\n')
    );
    const r = getVerifyCommand(dir, 'explicit task');
    assert.equal(r.cmd, 'exit 0');
    assert.equal(r.explicit, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getVerifyCommand falls back to shape default when TODO task has no Verify', () => {
  const dir = makeTempRepo();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'atris', 'TODO.md'),
      ['# TODO.md', '', '## Backlog', '', '## In Progress', '', '## Completed', ''].join('\n')
    );
    fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "x"\n');
    const r = getVerifyCommand(dir, 'no-such-task');
    assert.equal(r.cmd, 'pytest');
    assert.equal(r.explicit, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
