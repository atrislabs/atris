const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  scanAnomalies,
  findCodeTodos,
  findHotspot,
  isTodoTracked
} = require('../commands/autopilot');

function makeGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-scan-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'commands'), { recursive: true });
  return dir;
}

function commit(dir, message, files) {
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir });
}

test('isTodoTracked returns true when 2+ significant words overlap', () => {
  const backlog = '- **T1:** rebuild the parser for markdown horizontal separators';
  assert.equal(isTodoTracked('rebuild parser', backlog), true);
});

test('isTodoTracked returns false when no overlap', () => {
  assert.equal(isTodoTracked('rebuild parser', '- T1: add tests'), false);
});

test('isTodoTracked handles empty inputs', () => {
  assert.equal(isTodoTracked('', 'anything'), false);
  assert.equal(isTodoTracked('something', ''), false);
});

test('findCodeTodos finds // TODO in JS source', () => {
  const dir = makeGitRepo();
  try {
    commit(dir, 'init', {
      'commands/foo.js': '// TODO: rebuild parser\nconst x = 1;\n',
      'README.md': '# repo\n'
    });
    const todos = findCodeTodos(dir);
    assert.ok(todos.length >= 1);
    assert.equal(todos[0].file, 'commands/foo.js');
    assert.equal(todos[0].line, 1);
    assert.match(todos[0].text, /rebuild parser/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findCodeTodos skips test/, atris/, and _archive directories', () => {
  const dir = makeGitRepo();
  try {
    fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
    commit(dir, 'init', {
      'commands/foo.js': 'const x = 1;\n',
      'test/foo.test.js': '// TODO: add more tests\n',
      'atris/MAP.md': '# TODO: refresh MAP\n',
      'backend/_archive/dead_code.py': '# TODO: delete later\n'
    });
    const todos = findCodeTodos(dir);
    assert.equal(todos.length, 0, 'test/, atris/, and _archive should be skipped');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findHotspot returns file with >5 commits in last 24h', () => {
  const dir = makeGitRepo();
  try {
    for (let i = 0; i < 7; i++) {
      commit(dir, `iteration ${i}`, { 'commands/hot.js': `const x = ${i};\n` });
    }
    commit(dir, 'cold', { 'commands/cold.js': 'const y = 1;\n' });
    const hotspot = findHotspot(dir);
    assert.ok(hotspot);
    assert.equal(hotspot.file, 'commands/hot.js');
    assert.ok(hotspot.commits >= 6);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findHotspot returns null when no file crosses threshold', () => {
  const dir = makeGitRepo();
  try {
    commit(dir, 'one', { 'commands/foo.js': 'const x = 1;\n' });
    commit(dir, 'two', { 'commands/bar.js': 'const y = 1;\n' });
    assert.equal(findHotspot(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scanAnomalies surfaces orphan TODO', () => {
  const dir = makeGitRepo();
  try {
    commit(dir, 'init', {
      'commands/foo.js': '// TODO: migrate to async iterators\n',
      'atris/TODO.md': '# TODO\n\n## Backlog\n\n_(empty)_\n'
    });
    const results = scanAnomalies(dir);
    const orphan = results.find(r => r.kind === 'orphan-todo');
    assert.ok(orphan, 'should surface orphan-todo');
    assert.equal(orphan.priority, 6);
    assert.equal(orphan.skipKey, 'orphan-todo');
    assert.match(orphan.why, /migrate/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scanAnomalies suppresses orphan TODO when backlog already mentions it', () => {
  const dir = makeGitRepo();
  try {
    commit(dir, 'init', {
      'commands/foo.js': '// TODO: migrate parser to async iterators\n',
      'atris/TODO.md': '# TODO\n\n## Backlog\n- T1: migrate parser iterators [execute]\n'
    });
    const results = scanAnomalies(dir);
    const orphan = results.find(r => r.kind === 'orphan-todo');
    assert.equal(orphan, undefined, 'backlog covers it, should not surface');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scanAnomalies surfaces unverified-detector when sidecar has detector but no last_detected', () => {
  const dir = makeGitRepo();
  try {
    commit(dir, 'init', {
      'atris/TODO.md': '# TODO\n\n## Backlog\n',
      'atris/lessons.json': JSON.stringify({
        'bug-x': { detector: 'exit 0' }
      })
    });
    const results = scanAnomalies(dir);
    const unverified = results.find(r => r.kind === 'unverified-detector');
    assert.ok(unverified);
    assert.equal(unverified.priority, 5.5);
    assert.match(unverified.task, /unverified detector/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scanAnomalies ignores lesson metadata that is already last_detected', () => {
  const dir = makeGitRepo();
  try {
    commit(dir, 'init', {
      'atris/TODO.md': '# TODO\n\n## Backlog\n',
      'atris/lessons.json': JSON.stringify({
        'bug-x': { detector: 'exit 0', last_detected: '2026-04-20' }
      })
    });
    const results = scanAnomalies(dir);
    const unverified = results.find(r => r.kind === 'unverified-detector');
    assert.equal(unverified, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scanAnomalies never throws on a bare directory (no git, no atris)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-scan-bare-'));
  try {
    assert.doesNotThrow(() => scanAnomalies(dir));
    const results = scanAnomalies(dir);
    assert.ok(Array.isArray(results));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
