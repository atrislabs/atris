'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');

test('atris init twice leaves one Project Context section in each member it injects into', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-init-rerun-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const home = path.join(root, 'home');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  // The shipped executor and navigator cards have no Workflow heading to inject
  // before, so seed one to exercise all three injections.
  for (const member of ['executor', 'navigator']) {
    const dir = path.join(project, 'atris', 'team', member);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'MEMBER.md'), `# ${member}\n\n---\n\n## Workflow\n\nDo the work.\n`);
  }

  const init = () => {
    const res = spawnSync(process.execPath, [cliPath, 'init'], {
      cwd: project,
      input: '',
      encoding: 'utf8',
      timeout: 60000,
      env: { ...scrubAgentEnv(), HOME: home, ATRIS_SKIP_UPDATE_CHECK: '1' },
    });
    assert.equal(res.status, 0, res.stderr);
  };
  const sections = (member) => {
    const file = path.join(project, 'atris', 'team', member, 'MEMBER.md');
    return fs.readFileSync(file, 'utf8').match(/^## Project Context$/gm) || [];
  };

  init();
  init();
  for (const member of ['executor', 'navigator', 'validator']) {
    assert.equal(sections(member).length, 1, `${member} has exactly one Project Context section`);
  }
});
