const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Import the function we're testing
const { detectProjectContext } = require('../commands/init');

describe('detectProjectContext', () => {
  let tempDir;

  // Create a temp directory for each test
  function createTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-test-'));
    return dir;
  }

  function cleanup(dir) {
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test('detects Node.js project from package.json', () => {
    tempDir = createTempDir();
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
      name: 'test-project',
      dependencies: {}
    }));

    const result = detectProjectContext(tempDir);

    assert.strictEqual(result.type, 'nodejs');
    assert.strictEqual(result.hasCode, true);
    assert.strictEqual(result.testCommand, 'npm test');

    cleanup(tempDir);
  });

  test('detects React framework from dependencies', () => {
    tempDir = createTempDir();
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
      name: 'react-app',
      dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' }
    }));

    const result = detectProjectContext(tempDir);

    assert.strictEqual(result.type, 'nodejs');
    assert.strictEqual(result.framework, 'react');

    cleanup(tempDir);
  });

  test('detects Next.js framework', () => {
    tempDir = createTempDir();
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
      name: 'next-app',
      dependencies: { next: '^14.0.0', react: '^18.0.0' }
    }));

    const result = detectProjectContext(tempDir);

    assert.strictEqual(result.framework, 'next');

    cleanup(tempDir);
  });

  test('detects Python project from requirements.txt', () => {
    tempDir = createTempDir();
    fs.writeFileSync(path.join(tempDir, 'requirements.txt'), 'requests==2.31.0\n');

    const result = detectProjectContext(tempDir);

    assert.strictEqual(result.type, 'python');
    assert.strictEqual(result.hasCode, true);
    assert.strictEqual(result.testCommand, 'pytest');

    cleanup(tempDir);
  });

  test('detects FastAPI framework', () => {
    tempDir = createTempDir();
    fs.writeFileSync(path.join(tempDir, 'requirements.txt'), 'fastapi==0.100.0\nuvicorn\n');

    const result = detectProjectContext(tempDir);

    assert.strictEqual(result.type, 'python');
    assert.strictEqual(result.framework, 'fastapi');

    cleanup(tempDir);
  });

  test('detects Django framework', () => {
    tempDir = createTempDir();
    fs.writeFileSync(path.join(tempDir, 'requirements.txt'), 'django==4.2\n');

    const result = detectProjectContext(tempDir);

    assert.strictEqual(result.framework, 'django');

    cleanup(tempDir);
  });

  test('detects Go project', () => {
    tempDir = createTempDir();
    fs.writeFileSync(path.join(tempDir, 'go.mod'), 'module example.com/test\n\ngo 1.21\n');

    const result = detectProjectContext(tempDir);

    assert.strictEqual(result.type, 'go');
    assert.strictEqual(result.testCommand, 'go test ./...');

    cleanup(tempDir);
  });

  test('detects Rust project', () => {
    tempDir = createTempDir();
    fs.writeFileSync(path.join(tempDir, 'Cargo.toml'), '[package]\nname = "test"\n');

    const result = detectProjectContext(tempDir);

    assert.strictEqual(result.type, 'rust');
    assert.strictEqual(result.testCommand, 'cargo test');

    cleanup(tempDir);
  });

  test('detects knowledge base (markdown only)', () => {
    tempDir = createTempDir();
    fs.writeFileSync(path.join(tempDir, 'README.md'), '# Docs\n');
    fs.writeFileSync(path.join(tempDir, 'guide.md'), '# Guide\n');

    const result = detectProjectContext(tempDir);

    assert.strictEqual(result.type, 'knowledge-base');
    assert.strictEqual(result.hasCode, false);

    cleanup(tempDir);
  });

  test('detects file structure directories', () => {
    tempDir = createTempDir();
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{}');
    fs.mkdirSync(path.join(tempDir, 'src'));
    fs.mkdirSync(path.join(tempDir, 'tests'));
    fs.mkdirSync(path.join(tempDir, 'docs'));

    const result = detectProjectContext(tempDir);

    assert.ok(result.fileStructure.includes('src/'));
    assert.ok(result.fileStructure.includes('tests/'));
    assert.ok(result.fileStructure.includes('docs/'));

    cleanup(tempDir);
  });

  test('returns unknown for empty directory', () => {
    tempDir = createTempDir();

    const result = detectProjectContext(tempDir);

    assert.strictEqual(result.type, 'unknown');
    assert.strictEqual(result.hasCode, false);

    cleanup(tempDir);
  });

  test('detects Rails from Gemfile', () => {
    tempDir = createTempDir();
    fs.writeFileSync(path.join(tempDir, 'Gemfile'), "gem 'rails', '~> 7.0'\n");

    const result = detectProjectContext(tempDir);

    assert.strictEqual(result.type, 'ruby');
    assert.strictEqual(result.framework, 'rails');
    assert.strictEqual(result.testCommand, 'rspec');

    cleanup(tempDir);
  });
});
