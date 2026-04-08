const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { safePath, applyOp } = require('../commands/serve');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-serve-test-'));
}

function rmTmp(dir) {
  if (dir && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('safePath', () => {
  test('resolves relative path', () => {
    const wd = tmpDir();
    try {
      const result = safePath(wd, 'src/foo.py');
      assert.ok(result.endsWith('src/foo.py'));
      assert.ok(result.startsWith(fs.realpathSync(wd)));
    } finally {
      rmTmp(wd);
    }
  });

  test('rejects absolute path', () => {
    const wd = tmpDir();
    try {
      assert.throws(() => safePath(wd, '/etc/passwd'), /relative/);
    } finally {
      rmTmp(wd);
    }
  });

  test('rejects ..', () => {
    const wd = tmpDir();
    try {
      assert.throws(() => safePath(wd, '../../../etc/passwd'), /\.\./);
    } finally {
      rmTmp(wd);
    }
  });

  test('rejects empty path', () => {
    const wd = tmpDir();
    try {
      assert.throws(() => safePath(wd, ''));
    } finally {
      rmTmp(wd);
    }
  });

  test('allows nested paths', () => {
    const wd = tmpDir();
    try {
      const result = safePath(wd, 'a/b/c/d.txt');
      assert.ok(result.endsWith('a/b/c/d.txt'));
    } finally {
      rmTmp(wd);
    }
  });
});

describe('applyOp', () => {
  test('write creates a file', async () => {
    const wd = tmpDir();
    try {
      const result = await applyOp(wd, {
        type: 'write',
        path: 'foo.txt',
        content: 'hello world',
      });
      assert.equal(result.status, 'ok');
      assert.equal(result.result.bytes_written, 11);
      assert.equal(fs.readFileSync(path.join(wd, 'foo.txt'), 'utf8'), 'hello world');
    } finally {
      rmTmp(wd);
    }
  });

  test('write creates parent directories', async () => {
    const wd = tmpDir();
    try {
      const result = await applyOp(wd, {
        type: 'write',
        path: 'a/b/c/foo.txt',
        content: 'nested',
      });
      assert.equal(result.status, 'ok');
      assert.equal(fs.readFileSync(path.join(wd, 'a/b/c/foo.txt'), 'utf8'), 'nested');
    } finally {
      rmTmp(wd);
    }
  });

  test('write rejects path traversal', async () => {
    const wd = tmpDir();
    try {
      const result = await applyOp(wd, {
        type: 'write',
        path: '../escape.txt',
        content: 'bad',
      });
      assert.equal(result.status, 'error');
      assert.match(result.result.error, /\.\./);
    } finally {
      rmTmp(wd);
    }
  });

  test('read returns file content', async () => {
    const wd = tmpDir();
    try {
      fs.writeFileSync(path.join(wd, 'foo.txt'), 'read me');
      const result = await applyOp(wd, { type: 'read', path: 'foo.txt' });
      assert.equal(result.status, 'ok');
      assert.equal(result.result.content, 'read me');
    } finally {
      rmTmp(wd);
    }
  });

  test('read returns error for missing file', async () => {
    const wd = tmpDir();
    try {
      const result = await applyOp(wd, { type: 'read', path: 'missing.txt' });
      assert.equal(result.status, 'error');
      assert.match(result.result.error, /not found/);
    } finally {
      rmTmp(wd);
    }
  });

  test('edit replaces find with replace', async () => {
    const wd = tmpDir();
    try {
      fs.writeFileSync(path.join(wd, 'foo.txt'), 'hello world');
      const result = await applyOp(wd, {
        type: 'edit',
        path: 'foo.txt',
        find: 'world',
        replace: 'universe',
      });
      assert.equal(result.status, 'ok');
      assert.equal(result.result.replacements, 1);
      assert.equal(fs.readFileSync(path.join(wd, 'foo.txt'), 'utf8'), 'hello universe');
    } finally {
      rmTmp(wd);
    }
  });

  test('edit returns error if find not found', async () => {
    const wd = tmpDir();
    try {
      fs.writeFileSync(path.join(wd, 'foo.txt'), 'hello world');
      const result = await applyOp(wd, {
        type: 'edit',
        path: 'foo.txt',
        find: 'galaxy',
        replace: 'x',
      });
      assert.equal(result.status, 'error');
      assert.match(result.result.error, /not present/);
    } finally {
      rmTmp(wd);
    }
  });

  test('delete removes file', async () => {
    const wd = tmpDir();
    try {
      fs.writeFileSync(path.join(wd, 'foo.txt'), 'gone soon');
      const result = await applyOp(wd, { type: 'delete', path: 'foo.txt' });
      assert.equal(result.status, 'ok');
      assert.equal(fs.existsSync(path.join(wd, 'foo.txt')), false);
    } finally {
      rmTmp(wd);
    }
  });

  test('bash runs command in working directory', async () => {
    const wd = tmpDir();
    try {
      fs.writeFileSync(path.join(wd, 'a.txt'), 'a');
      fs.writeFileSync(path.join(wd, 'b.txt'), 'b');
      const result = await applyOp(wd, { type: 'bash', command: 'ls' });
      assert.equal(result.status, 'ok');
      assert.match(result.result.stdout, /a\.txt/);
      assert.match(result.result.stdout, /b\.txt/);
    } finally {
      rmTmp(wd);
    }
  });

  test('bash captures error exit code', async () => {
    const wd = tmpDir();
    try {
      const result = await applyOp(wd, { type: 'bash', command: 'false' });
      assert.equal(result.status, 'error');
      assert.notEqual(result.result.exit_code, 0);
    } finally {
      rmTmp(wd);
    }
  });

  test('unknown op type returns error', async () => {
    const wd = tmpDir();
    try {
      const result = await applyOp(wd, { type: 'rm_rf_root', path: 'x' });
      assert.equal(result.status, 'error');
      assert.match(result.result.error, /unknown/);
    } finally {
      rmTmp(wd);
    }
  });
});
