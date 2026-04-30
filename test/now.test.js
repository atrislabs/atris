const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureNowFile, nowAtris, refreshNowFile, renderDefaultNow, renderPortfolioNow } = require('../commands/now');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-now-test-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function captureLogs(fn) {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.log = originalLog;
  }
  return lines.join('\n');
}

test('ensureNowFile creates atris/now.md as the workspace front door', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# Demo Map\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n\n- **T1:** Ship it\n', 'utf8');

    const result = ensureNowFile(dir);
    const content = fs.readFileSync(path.join(dir, 'atris', 'now.md'), 'utf8');

    assert.equal(result.created, true);
    assert.match(content, /# now/);
    assert.match(content, /What Matters Now/);
    assert.match(content, /Current Priority/);
    assert.match(content, /Receipts/);
  } finally {
    cleanup(dir);
  }
});

test('refreshNowFile regenerates now.md from current local signals', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# Demo Map\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n\n- **T1:** Ship it\n- **T2:** Validate it\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'now.md'), 'old', 'utf8');

    refreshNowFile(dir);
    const content = fs.readFileSync(path.join(dir, 'atris', 'now.md'), 'utf8');

    assert.match(content, /TODO items visible: 2/);
    assert.doesNotMatch(content, /^old$/);
  } finally {
    cleanup(dir);
  }
});

test('renderDefaultNow refuses non-Atris workspaces', () => {
  const dir = makeTempDir();
  try {
    assert.throws(() => renderDefaultNow(dir), /atris\/ folder not found/);
  } finally {
    cleanup(dir);
  }
});

test('ensureNowFile creates a portfolio now.md for a parent of Atris workspaces', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'pallet', 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pallet', 'atris', 'MAP.md'), '# Pallet Map\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'pallet', 'atris', 'TODO.md'), '# TODO\n\n- **P1:** Recruit\n', 'utf8');

    fs.mkdirSync(path.join(dir, 'parked', 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'parked', 'atris', 'MAP.md'), '# Parked Map\n', 'utf8');

    const result = ensureNowFile(dir);
    const content = fs.readFileSync(path.join(dir, 'atris', 'now.md'), 'utf8');

    assert.equal(result.created, true);
    assert.match(content, /portfolio of Atris workspaces/);
    assert.match(content, /pallet: Pallet Map; 1 visible TODO item/);
    assert.match(content, /parked: Parked Map; 0 visible TODO items/);
  } finally {
    cleanup(dir);
  }
});

test('renderPortfolioNow refuses a parent with no child Atris workspaces', () => {
  const dir = makeTempDir();
  try {
    assert.throws(() => renderPortfolioNow(dir), /atris\/ folder not found/);
  } finally {
    cleanup(dir);
  }
});

test('now --all refreshes the parent portfolio and every child workspace', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'pallet', 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pallet', 'atris', 'MAP.md'), '# Pallet Map\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'pallet', 'atris', 'TODO.md'), '# TODO\n\n- **P1:** Recruit\n', 'utf8');

    fs.mkdirSync(path.join(dir, 'parked', 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'parked', 'atris', 'MAP.md'), '# Parked Map\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'parked', 'atris', 'TODO.md'), '# TODO\n', 'utf8');

    const output = captureLogs(() => nowAtris(['--all'], dir));

    assert.match(output, /Refreshed 2 child workspaces/);
    assert.match(fs.readFileSync(path.join(dir, 'atris', 'now.md'), 'utf8'), /portfolio of Atris workspaces/);
    assert.match(fs.readFileSync(path.join(dir, 'pallet', 'atris', 'now.md'), 'utf8'), /Pallet Map/);
    assert.match(fs.readFileSync(path.join(dir, 'parked', 'atris', 'now.md'), 'utf8'), /Parked Map/);
  } finally {
    cleanup(dir);
  }
});
