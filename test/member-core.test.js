const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const memberCore = require('../lib/member-core');
const memberCommandModule = require('../commands/member');

function withTempWorkspace(fn) {
  const previousCwd = process.cwd();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-core-')));
  fs.mkdirSync(path.join(root, 'atris', 'team', 'builder'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'atris', 'team', 'builder', 'MEMBER.md'),
    ['---', 'name: builder', 'role: Software Builder', 'type: agent', '---', '', '# Persona', 'Builds slices.'].join('\n'),
    'utf8'
  );
  try {
    process.chdir(root);
    return fn(root);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('lib/member-core exports shared member helpers and keeps commands/member exports intact', () => {
  const expectedCoreHelpers = [
    'memberPaths',
    'requireRunnableMember',
    'requireMemberDir',
    'loadMemberGoals',
    'readOptionalText',
    'memberRunMissionMap',
    'memberLiveMission',
    'ageLabelFromMs',
    'readJsonlRowsIfExists',
    'safeReadText',
    'repoRelative',
    'appendMemberGoalLog',
    'appendProjectLog',
    'parseFrontmatter',
    'writeMemberReceipt',
    'writeWakeReceipt',
    'writeMemberLoopReceipt',
    'writeAutoImproverReceipt',
  ];
  for (const name of expectedCoreHelpers) {
    assert.equal(typeof memberCore[name], 'function', `expected ${name} in lib/member-core.js`);
  }

  const expectedMemberExports = [
    'logDateForScan',
    'memberStandupLines',
    'standupTableData',
    'memberRunDefaultWallSeconds',
    'memberRunWantsReferee',
    'proposalPromptForGoal',
    'memberGoFinishTask',
    'memberRunReviewAsk',
    'memberUpSpawn',
    'appendMemberGoalLog',
    'appendProjectLog',
    'memberCommand',
    'findAllMembers',
    'findWorkspaceBusinessId',
    'parseFrontmatter',
    'wakeBootLines',
    'buildMemberRunStartArgs',
    'inferMemberRunVerifier',
    'memberRunSaveDecision',
    'buildMemberSubagentShell',
    'pickMemberForIdea',
  ];
  for (const name of expectedMemberExports) {
    assert.equal(typeof memberCommandModule[name], 'function', `expected ${name} in commands/member.js exports`);
  }
});

test('lib/member-core path, goals, frontmatter, log, jsonl, and receipt helpers work in an isolated workspace', () => {
  withTempWorkspace((root) => {
    const paths = memberCore.requireRunnableMember('builder');
    assert.equal(paths.memberFile, path.join(root, 'atris', 'team', 'builder', 'MEMBER.md'));

    const goals = memberCore.loadMemberGoals('builder', paths);
    assert.equal(goals.member, 'builder');
    assert.deepEqual(goals.goals, []);

    const fm = memberCore.parseFrontmatter(memberCore.readOptionalText(paths.memberFile));
    assert.equal(fm.name, 'builder');
    assert.equal(fm.role, 'Software Builder');

    const jsonlFile = path.join(root, 'sample.jsonl');
    fs.writeFileSync(jsonlFile, '{"a":1}\nnot-json\n{"b":2}\n', 'utf8');
    assert.deepEqual(memberCore.readJsonlRowsIfExists(jsonlFile), [{ a: 1 }, { b: 2 }]);
    assert.equal(memberCore.safeReadText(jsonlFile), '{"a":1}\nnot-json\n{"b":2}\n');
    assert.equal(memberCore.repoRelative(root, jsonlFile), 'sample.jsonl');

    const goalLogPath = memberCore.appendMemberGoalLog(paths.memberDir, 'builder', 'Goal step', { status: 'ok', empty: '' });
    assert.match(fs.readFileSync(goalLogPath, 'utf8'), /- status: ok/);

    const projectLogPath = memberCore.appendProjectLog('Project step', { member: 'builder' });
    assert.match(fs.readFileSync(projectLogPath, 'utf8'), /- member: builder/);

    const wakeReceipt = memberCore.writeWakeReceipt('builder', { ok: true, step: 'wake' });
    const loopReceipt = memberCore.writeMemberLoopReceipt('builder', { ok: true, step: 'loop' });
    const autoReceipt = memberCore.writeAutoImproverReceipt('builder', { ok: true, step: 'auto' });
    assert.equal(JSON.parse(fs.readFileSync(wakeReceipt, 'utf8')).step, 'wake');
    assert.equal(JSON.parse(fs.readFileSync(loopReceipt, 'utf8')).step, 'loop');
    assert.equal(JSON.parse(fs.readFileSync(autoReceipt.receiptPath, 'utf8')).step, 'auto');
    assert.equal(JSON.parse(fs.readFileSync(autoReceipt.latestPath, 'utf8')).receipt_path, autoReceipt.receiptPath);

    assert.equal(memberCore.ageLabelFromMs(0), '-');
    assert.equal(memberCore.ageLabelFromMs(9900, 10000), 'now');
    assert.equal(memberCore.ageLabelFromMs(10000, 10000 + 5 * 60 * 1000), '5m');
    assert.equal(memberCore.memberLiveMission('builder', new Map()), null);
  });
});
