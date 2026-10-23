const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runAuditChecks } = require('../commands/skill');

test('audit preserves the supplied frontmatter name', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-audit-frontmatter-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const checks = runAuditChecks({
    frontmatter: { name: 'daily-notes' },
    leafFolder: 'daily-notes',
    path: path.join(dir, 'SKILL.md'),
    content: '1. Write a note.\n',
  });

  assert.deepStrictEqual(checks.find((check) => check.id === 'name-exists'), {
    id: 'name-exists',
    severity: 'ERROR',
    pass: true,
    message: 'name: daily-notes',
  });
});
