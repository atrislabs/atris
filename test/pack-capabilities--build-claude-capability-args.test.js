const test = require('node:test');
const assert = require('node:assert');

const { buildClaudeCapabilityArgs } = require('../lib/pack-capabilities');

function settingsFromArgs(args) {
  const index = args.indexOf('--settings');
  assert.notStrictEqual(index, -1, 'expected a --settings flag in the argv list');
  return JSON.parse(args[index + 1]);
}

test('buildClaudeCapabilityArgs returns [] for non-enforced policies', () => {
  assert.deepStrictEqual(buildClaudeCapabilityArgs(null), []);
  assert.deepStrictEqual(buildClaudeCapabilityArgs(undefined), []);
  assert.deepStrictEqual(buildClaudeCapabilityArgs({ status: 'legacy' }), []);
  assert.deepStrictEqual(buildClaudeCapabilityArgs({ status: 'invalid', reason: 'x' }), []);
});

test('buildClaudeCapabilityArgs emits a bounded argv for an enforced policy', () => {
  const policy = { status: 'enforced', tools: ['Read', 'Glob', 'Grep', 'Skill'] };
  const args = buildClaudeCapabilityArgs(policy, { hookScript: '/tmp/fake-hook.js' });

  assert.strictEqual(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep,Skill');
  assert.strictEqual(args[args.indexOf('--permission-mode') + 1], 'default');
  assert.ok(args.includes('--no-chrome'));
  assert.ok(!args.includes('--no-session-persistence'));
  assert.strictEqual(args[args.indexOf('--setting-sources') + 1], '');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.deepStrictEqual(
    JSON.parse(args[args.indexOf('--mcp-config') + 1]),
    { mcpServers: {} },
  );

  const settings = settingsFromArgs(args);
  assert.strictEqual(settings.disableAllHooks, false);
  assert.strictEqual(settings.disableSkillShellExecution, true);
  assert.strictEqual(settings.permissions.defaultMode, 'default');
  assert.strictEqual(settings.permissions.disableBypassPermissionsMode, 'disable');
  assert.strictEqual(settings.permissions.disableAutoMode, 'disable');
  assert.ok(!('deny' in settings.permissions));
  assert.ok(!('allow' in settings.permissions));
});

test('buildClaudeCapabilityArgs wires all four hook phases to the hook script', () => {
  const policy = { status: 'enforced', tools: ['Read'] };
  const settings = settingsFromArgs(
    buildClaudeCapabilityArgs(policy, { hookScript: '/tmp/fake-hook.js' }),
  );
  const hooks = settings.hooks;
  for (const phase of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SessionEnd']) {
    assert.ok(Array.isArray(hooks[phase]), `missing hook block for ${phase}`);
    assert.strictEqual(hooks[phase][0].hooks[0].type, 'command');
    assert.ok(
      hooks[phase][0].hooks[0].command.includes('/tmp/fake-hook.js'),
      `${phase} hook command does not reference the hook script`,
    );
  }
  assert.ok(hooks.PreToolUse[0].hooks[0].command.endsWith(' pre'));
  assert.ok(hooks.PostToolUse[0].hooks[0].command.endsWith(' used'));
  assert.ok(hooks.PostToolUseFailure[0].hooks[0].command.endsWith(' failed'));
  assert.ok(hooks.SessionEnd[0].hooks[0].command.endsWith(' session-end'));
});

test('buildClaudeCapabilityArgs trust mode adds allow list, deny rules, and non-interactive flag', () => {
  const policy = { status: 'enforced', tools: ['Read', 'Grep'] };
  const userDenyRules = ['Bash(rm *)', 'Read(./.env)'];
  const args = buildClaudeCapabilityArgs(policy, {
    trust: true,
    userDenyRules,
    nonInteractive: true,
    hookScript: '/tmp/fake-hook.js',
  });

  assert.strictEqual(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(args.includes('--no-session-persistence'));

  const settings = settingsFromArgs(args);
  assert.strictEqual(settings.permissions.defaultMode, 'dontAsk');
  assert.deepStrictEqual(settings.permissions.deny, userDenyRules);
  assert.deepStrictEqual(settings.permissions.allow, ['Read', 'Grep']);
});

test('buildClaudeCapabilityArgs ignores a non-array userDenyRules value', () => {
  const policy = { status: 'enforced', tools: ['Read'] };
  const settings = settingsFromArgs(
    buildClaudeCapabilityArgs(policy, { userDenyRules: 'Bash(rm *)' }),
  );
  assert.ok(!('deny' in settings.permissions));
});
