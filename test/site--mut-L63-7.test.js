const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSite } = require('../lib/site');

test('buildSite loads theme colors from the explicit root rather than cwd', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-root-theme-'));
  const previousCwd = process.cwd();
  try {
    const root = path.join(dir, 'project');
    const cwd = path.join(dir, 'elsewhere');
    for (const [folder, bg] of [[root, '#123456'], [cwd, '#654321']]) {
      fs.mkdirSync(path.join(folder, '.atris'), { recursive: true });
      fs.writeFileSync(path.join(folder, '.atris', 'theme.json'), JSON.stringify({
        themes: { 'root-theme': { color: { bg } } },
      }));
    }
    const doc = path.join(root, 'guide.md');
    fs.writeFileSync(doc, '# Guide\n\nA short guide.\n');
    process.chdir(cwd);

    const result = buildSite(doc, {
      root, theme: 'root-theme', out: path.join(dir, 'output'),
    });

    for (const file of [result.indexPath, result.pages[0].out]) {
      const html = fs.readFileSync(file, 'utf8');
      assert.equal(html.match(/--brand-bg:[^;]+;/)?.[0], '--brand-bg:#123456;');
    }
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
