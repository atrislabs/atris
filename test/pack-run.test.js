const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runPack } = require('../commands/pack');
const {
  resolvePackCapabilityPolicy,
  readClaudeUserDenyRules,
  beginPackRunReceipt,
  enforcePackRoot,
  runHook,
} = require('../lib/pack-capabilities');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-pack-run-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// An installed packet: a folder with a readable pack.json.
function seedInstalledPack(dir, slug = 'g-brain', extraManifest = {}) {
  const packDir = path.join(dir, slug);
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(
    path.join(packDir, 'pack.json'),
    `${JSON.stringify({ slug, title: 'G Brain', version: '0.1.0', ...extraManifest }, null, 2)}\n`
  );
  fs.writeFileSync(path.join(packDir, 'README.md'), '# G Brain\n');
  return packDir;
}

// Every seam pack run touches, captured instead of executed.
function stubDeps(overrides = {}) {
  const calls = { local: [], cloud: [], install: [] };
  return {
    calls,
    deps: {
      computerLocal: (args, options) => { calls.local.push({ cwd: process.cwd(), args, options }); },
      runComputer: async (args) => { calls.cloud.push({ cwd: process.cwd(), args }); },
      loadCredentials: () => ({ token: 'test-token' }),
      readBusinessBinding: () => ({ slug: 'acme', business_id: 'b1', workspace_id: 'w1' }),
      readUserDenyRules: () => [],
      ...overrides,
    },
  };
}

// Returns { code, output } with console captured for the whole async call.
async function captureConsole(fn) {
  const lines = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...args) => lines.push(args.join(' '));
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const code = await fn();
    return { code, output: lines.join('\n') };
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
}

test('pack run starts a local computer inside the packet folder', async () => {
  const dir = makeTempDir();
  try {
    const packDir = seedInstalledPack(dir);
    const { calls, deps } = stubDeps();
    const code = await runPack(['g-brain'], dir, { deps });

    assert.equal(code, 0);
    assert.equal(calls.local.length, 1, 'local computer should start exactly once');
    assert.equal(fs.realpathSync(calls.local[0].cwd), fs.realpathSync(packDir));
    assert.equal(calls.cloud.length, 0, 'local is the default; cloud must not be touched');
    // the working directory is restored, not leaked
    assert.notEqual(process.cwd(), packDir);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack run orients a zero-context packet and gives the agent a useful opening prompt', async () => {
  const dir = makeTempDir();
  try {
    seedInstalledPack(dir);
    const { calls, deps } = stubDeps();
    const { code, output } = await captureConsole(() => runPack(['g-brain'], dir, { deps }));

    assert.equal(code, 0);
    assert.match(output, /pack: G Brain/);
    assert.match(output, /files \(2\): README\.md, pack\.json/);
    assert.match(output, /source\/origin: local packet folder/);
    assert.match(output, /declares no entrypoint.*pack files as context only/);
    assert.deepEqual(calls.local[0].args, [
      "Read README.md first, then inspect the rest of this pack's files. Propose the pack's first useful action before making changes.",
    ]);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack run uses the manifest entrypoint as the opening prompt', async () => {
  const dir = makeTempDir();
  try {
    const packDir = seedInstalledPack(dir);
    const manifestPath = path.join(packDir, 'pack.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.entrypoint = 'Summarize the research and ask which finding to apply first.';
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const { calls, deps } = stubDeps();
    const { output } = await captureConsole(() => runPack(['g-brain'], dir, { deps }));

    assert.deepEqual(calls.local[0].args, [manifest.entrypoint]);
    assert.doesNotMatch(output, /declares no entrypoint/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack run uses RUN.md as the opening prompt', async () => {
  const dir = makeTempDir();
  try {
    const packDir = seedInstalledPack(dir);
    fs.writeFileSync(path.join(packDir, 'RUN.md'), 'Read the brief, then draft the launch checklist.\n');
    const { calls, deps } = stubDeps();
    const { output } = await captureConsole(() => runPack(['g-brain'], dir, { deps }));

    assert.deepEqual(calls.local[0].args, ['Read the brief, then draft the launch checklist.']);
    assert.doesNotMatch(output, /declares no entrypoint/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack run accepts a packet directory as well as a slug', async () => {
  const dir = makeTempDir();
  try {
    const packDir = seedInstalledPack(dir, 'some-pack');
    const { calls, deps } = stubDeps({
      installPack: async () => { throw new Error('should not install an existing folder'); },
    });
    const code = await runPack([path.join(dir, 'some-pack')], dir, { deps });

    assert.equal(code, 0);
    assert.equal(fs.realpathSync(calls.local[0].cwd), fs.realpathSync(packDir));
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack run installs an uninstalled slug before starting it', async () => {
  const dir = makeTempDir();
  try {
    const { calls, deps } = stubDeps();
    deps.installPack = async (args) => {
      calls.install.push(args);
      const target = args[args.indexOf('--dir') + 1];
      seedInstalledPack(path.dirname(target), path.basename(target));
      return 0;
    };
    const code = await runPack(['fresh-pack'], dir, { deps });

    assert.equal(code, 0);
    assert.equal(calls.install.length, 1, 'install runs through the existing install path');
    assert.equal(calls.install[0][0], 'fresh-pack');
    assert.equal(calls.local.length, 1);
    assert.equal(
      fs.realpathSync(calls.local[0].cwd),
      fs.realpathSync(path.join(dir, 'fresh-pack'))
    );
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack run --cloud fails loudly when the caller is not logged in', async () => {
  const dir = makeTempDir();
  try {
    seedInstalledPack(dir);
    const { calls, deps } = stubDeps({ loadCredentials: () => null });
    const { code, output } = await captureConsole(() => runPack(['g-brain', '--cloud'], dir, { deps }));

    assert.equal(code, 1);
    assert.match(output, /not logged in/);
    assert.match(output, /atris login/);
    assert.match(output, /local runs free/);
    assert.match(output, /atris pack run g-brain/);
    assert.equal(calls.cloud.length, 0, 'the paywall must not be routed around');
    assert.equal(calls.local.length, 0, 'no silent fallback to local');
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack run --cloud fails loudly when no business is bound', async () => {
  const dir = makeTempDir();
  try {
    seedInstalledPack(dir);
    const { calls, deps } = stubDeps({ readBusinessBinding: () => null });
    const { code, output } = await captureConsole(() => runPack(['g-brain', '--cloud'], dir, { deps }));

    assert.equal(code, 1);
    assert.match(output, /no business is bound/);
    assert.match(output, /paid plan/);
    assert.match(output, /atris pack run g-brain/);
    assert.equal(calls.cloud.length, 0);
    assert.equal(calls.local.length, 0);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack run --cloud uses the cloud workspace path once the gates pass', async () => {
  const dir = makeTempDir();
  try {
    const packDir = seedInstalledPack(dir);
    const { calls, deps } = stubDeps();
    const code = await runPack(['g-brain', '--cloud'], dir, { deps });

    assert.equal(code, 0);
    assert.equal(calls.cloud.length, 1);
    assert.deepEqual(calls.cloud[0].args, ['cloud']);
    assert.equal(fs.realpathSync(calls.cloud[0].cwd), fs.realpathSync(packDir));
    assert.equal(calls.local.length, 0);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack run says plainly when the packet folder is missing or invalid', async () => {
  const dir = makeTempDir();
  try {
    const { deps } = stubDeps();
    fs.mkdirSync(path.join(dir, 'not-a-pack'));
    await assert.rejects(
      () => runPack([path.join(dir, 'not-a-pack')], dir, { deps }),
      /not an atris packet \(no pack\.json\)/
    );

    fs.writeFileSync(path.join(dir, 'not-a-pack', 'pack.json'), '{ broken');
    await assert.rejects(
      () => runPack([path.join(dir, 'not-a-pack')], dir, { deps }),
      /packet is invalid/
    );
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack run keeps permission prompts on for a packet someone else wrote', async () => {
  const dir = makeTempDir();
  try {
    seedInstalledPack(dir);
    const { calls, deps } = stubDeps();
    const { code, output } = await captureConsole(() => runPack(['g-brain'], dir, { deps }));

    assert.equal(code, 0);
    assert.equal(calls.local[0].options.skipPermissions, false);
    assert.match(output, /permission prompts are on/);
    assert.match(output, /--trust/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack run --trust is the explicit opt-out for a packet you have read', async () => {
  const dir = makeTempDir();
  try {
    seedInstalledPack(dir);
    const { calls, deps } = stubDeps();
    const { code, output } = await captureConsole(() => runPack(['g-brain', '--trust'], dir, { deps }));

    assert.equal(code, 0);
    assert.equal(calls.local[0].options.skipPermissions, true);
    assert.doesNotMatch(output, /permission prompts are on/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('declared capabilities become an exact local Claude tool ceiling and trust card', async () => {
  const dir = makeTempDir();
  try {
    seedInstalledPack(dir, 'g-brain', { permissions: ['pack.read', 'web.read'] });
    const receiptDir = path.join(dir, 'receipts');
    const { calls, deps } = stubDeps({ packRunReceiptDir: receiptDir });
    const { code, output } = await captureConsole(() => runPack(['g-brain'], dir, { deps }));

    assert.equal(code, 0);
    assert.equal(calls.local.length, 1);
    const call = calls.local[0];
    assert.equal(call.options.skipPermissions, false);
    const toolsFlag = call.args.indexOf('--tools');
    assert.equal(call.args[toolsFlag + 1], 'Read,Glob,Grep,Skill,WebFetch,WebSearch');
    assert.equal(call.args[call.args.indexOf('--permission-mode') + 1], 'default');
    assert.equal(call.args[call.args.indexOf('--setting-sources') + 1], '');
    assert.equal(call.args.includes('--strict-mcp-config'), true);
    assert.deepEqual(JSON.parse(call.args[call.args.indexOf('--mcp-config') + 1]), { mcpServers: {} });
    const settings = JSON.parse(call.args[call.args.indexOf('--settings') + 1]);
    assert.equal(settings.permissions.disableBypassPermissionsMode, 'disable');
    assert.equal(settings.permissions.disableAutoMode, 'disable');
    assert.equal(settings.disableSkillShellExecution, true);
    assert.equal(settings.hooks.PreToolUse[0].matcher, 'Read|Glob|Grep|Edit|Write');
    assert.match(output, /capability trust card:/);
    assert.match(output, /requested by pack: pack\.read, web\.read/);
    assert.match(output, /granted for this run: pack\.read, web\.read/);
    assert.match(output, /host shell: denied/);

    const receipts = fs.readdirSync(receiptDir).filter((name) => name.endsWith('.json'));
    assert.equal(receipts.length, 1);
    const receipt = JSON.parse(fs.readFileSync(path.join(receiptDir, receipts[0]), 'utf8'));
    assert.deepEqual(receipt.requestedCapabilities, ['pack.read', 'web.read']);
    assert.deepEqual(receipt.grantedCapabilities, ['pack.read', 'web.read']);
    assert.deepEqual(receipt.grantedTools, ['Read', 'Glob', 'Grep', 'Skill', 'WebFetch', 'WebSearch']);
    assert.deepEqual(receipt.usedTools, []);
    assert.equal(receipt.enforcement.packRootFileBoundary, true);
    assert.equal(receipt.enforcement.preLaunchContextBoundary, true);
    assert.equal(receipt.enforcement.declaredTreeSymlinksRejected, true);
    assert.equal(receipt.enforcement.claudeMemoryDisabledByRunner, true);
    assert.equal(receipt.enforcement.autoMemoryDisabledByRunner, true);
    assert.equal(receipt.enforcement.userSettingsLoaded, false);
    assert.equal(receipt.enforcement.userDenyRulesImported, 0);
    assert.equal(receipt.enforcement.userExtensionsLoaded, false);
    assert.equal(receipt.enforcement.projectSettingsLoaded, false);
    assert.equal(receipt.enforcement.managedPoliciesMayApply, true);
    assert.equal(receipt.enforcement.bundledClaudeSkillsMayApply, true);
    assert.equal(receipt.enforcement.packSkillsPluginLoaded, false);
    assert.equal(receipt.enforcement.packSkillFrontmatterSanitized, true);
    assert.equal(receipt.enforcement.packSkillApprovalOverridesRemoved, true);
    assert.equal(receipt.enforcement.packSkillHooksRemoved, true);
    assert.equal(receipt.enforcement.skillShellExecutionDisabled, true);
    assert.equal(receipt.enforcement.mcpServersLoaded, false);
    assert.equal(call.options.runnerEnv.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
    assert.equal(call.options.runnerEnv.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
    assert.match(output, /memory isolation: Claude memory files and auto-memory are disabled/);
    assert.match(output, /extensions: user\/project skills, plugins, agents, hooks, and commands are not loaded/);
    assert.match(output, /skill sources: shipped pack skills plus Claude built-ins only/);
    assert.match(output, /skill frontmatter: projected through a safe metadata allowlist/);
    assert.match(output, /skill shell: dynamic shell preprocessing is disabled/);
    assert.match(output, /operator policy: 0 user deny rules imported; managed policy may still apply/);
    assert.deepEqual(receipt.observability, {
      denialCoverage: 'atris-hooks-only',
      runtimePermissionDenialsCaptured: false,
      toolInputsLogged: false,
      directSkillInvocationsCaptured: false,
    });
  } finally {
    cleanupTempDir(dir);
  }
});

test('declared runs import only user deny rules while filesystem customizations stay disabled', async () => {
  const dir = makeTempDir();
  try {
    seedInstalledPack(dir, 'g-brain', { permissions: ['pack.read'] });
    const receiptDir = path.join(dir, 'receipts');
    const { calls, deps } = stubDeps({
      packRunReceiptDir: receiptDir,
      readUserDenyRules: () => ['Read(/private/**)', 'Bash(rm *)'],
    });
    const { output } = await captureConsole(() => runPack(['g-brain', '--trust'], dir, { deps }));

    const call = calls.local[0];
    assert.equal(call.args[call.args.indexOf('--setting-sources') + 1], '');
    const settings = JSON.parse(call.args[call.args.indexOf('--settings') + 1]);
    assert.deepEqual(settings.permissions.deny, ['Read(/private/**)', 'Bash(rm *)']);
    assert.deepEqual(settings.permissions.allow, ['Read', 'Glob', 'Grep', 'Skill']);
    assert.match(output, /operator policy: 2 user deny rules imported/);
    const receiptName = fs.readdirSync(receiptDir).find((name) => name.endsWith('.json'));
    const receipt = JSON.parse(fs.readFileSync(path.join(receiptDir, receiptName), 'utf8'));
    assert.equal(receipt.enforcement.userSettingsLoaded, false);
    assert.equal(receipt.enforcement.userDenyRulesImported, 2);
    assert.equal(receipt.enforcement.userExtensionsLoaded, false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('user deny rule import is bounded to non-empty strings in user settings', () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
      permissions: { deny: ['Read(/private/**)', '', 42, 'Read(/private/**)'] },
      enabledPlugins: { surprise: true },
    }));
    assert.deepEqual(readClaudeUserDenyRules({ configDir: dir }), ['Read(/private/**)']);
  } finally {
    cleanupTempDir(dir);
  }
});

test('declared packs reject pre-launch symlink context escapes before Atris starts the runner', async () => {
  const dir = makeTempDir();
  try {
    const packDir = seedInstalledPack(dir, 'g-brain', { permissions: [] });
    const outside = path.join(dir, 'outside-atris');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'PERSONA.md'), 'OUTSIDE_CONTEXT_CANARY\n');
    fs.symlinkSync(outside, path.join(packDir, 'atris'));
    const receiptDir = path.join(dir, 'receipts');
    const { calls, deps } = stubDeps({ packRunReceiptDir: receiptDir });

    await assert.rejects(
      () => runPack(['g-brain', '--trust'], dir, { deps }),
      /declared pack execution tree cannot contain symlinks: atris/,
    );
    assert.equal(calls.local.length, 0);
    assert.equal(calls.cloud.length, 0);
    assert.equal(fs.existsSync(receiptDir), false, 'a rejected pre-launch tree must not claim a run receipt');
  } finally {
    cleanupTempDir(dir);
  }
});

test('--grant also rejects symlinked legacy context before turning it into an enforced run', async () => {
  const dir = makeTempDir();
  try {
    const packDir = seedInstalledPack(dir);
    const outside = path.join(dir, 'outside-persona.md');
    fs.writeFileSync(outside, 'OUTSIDE_ENTRYPOINT_CANARY\n');
    fs.symlinkSync(outside, path.join(packDir, 'PERSONA.md'));
    const { calls, deps } = stubDeps({ packRunReceiptDir: path.join(dir, 'receipts') });

    await assert.rejects(
      () => runPack(['g-brain', '--grant', 'pack.read'], dir, { deps }),
      /declared pack execution tree cannot contain symlinks: PERSONA\.md/,
    );
    assert.equal(calls.local.length, 0);
  } finally {
    cleanupTempDir(dir);
  }
});

test('declared --trust auto-approves only inside the tool ceiling and never bypasses it', async () => {
  const dir = makeTempDir();
  try {
    seedInstalledPack(dir, 'g-brain', { permissions: ['pack.write'] });
    const { calls, deps } = stubDeps({ packRunReceiptDir: path.join(dir, 'receipts') });
    const { output } = await captureConsole(() => runPack(['g-brain', '--trust'], dir, { deps }));

    const call = calls.local[0];
    assert.equal(call.options.skipPermissions, false, 'declared --trust must never request bypassPermissions');
    assert.equal(call.args[call.args.indexOf('--permission-mode') + 1], 'dontAsk');
    const settings = JSON.parse(call.args[call.args.indexOf('--settings') + 1]);
    assert.deepEqual(
      settings.permissions.allow,
      ['Read', 'Glob', 'Grep', 'Skill', 'Edit', 'Write'],
      'dontAsk must pre-approve every granted tool by its exact Claude permission name',
    );
    assert.equal(settings.hooks.PreToolUse[0].matcher, 'Read|Glob|Grep|Edit|Write');
    assert.match(output, /pre-approved inside the declared ceiling/);
    assert.match(output, /imported\/managed deny rules still win/);
    assert.match(output, /later Claude or policy denials may not appear/);
    const receiptName = fs.readdirSync(path.join(dir, 'receipts')).find((name) => name.endsWith('.json'));
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'receipts', receiptName), 'utf8'));
    assert.equal(receipt.approvalMode, 'pre-approved-within-declared-ceiling');
  } finally {
    cleanupTempDir(dir);
  }
});

test('unknown and legacy-shaped declared permissions fail before any runner starts', async () => {
  const dir = makeTempDir();
  try {
    const packDir = seedInstalledPack(dir, 'g-brain', { permissions: ['pack.read', 'database.admin'] });
    const { calls, deps } = stubDeps({ packRunReceiptDir: path.join(dir, 'receipts') });
    await assert.rejects(
      () => runPack(['g-brain'], dir, { deps }),
      /unknown capability "database\.admin"/,
    );
    assert.equal(calls.local.length, 0);
    assert.equal(calls.cloud.length, 0);
    assert.equal(fs.existsSync(path.join(dir, 'receipts')), false);

    const manifestPath = path.join(packDir, 'pack.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.permissions = { network: 'read' };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(
      () => runPack(['g-brain'], dir, { deps }),
      /permissions must be an array of canonical capabilities/,
    );
    assert.equal(calls.local.length, 0);
  } finally {
    cleanupTempDir(dir);
  }
});

test('declared capability packs fail closed in cloud before auth or workspace launch', async () => {
  const dir = makeTempDir();
  try {
    seedInstalledPack(dir, 'g-brain', { permissions: ['pack.read'] });
    const { calls, deps } = stubDeps({
      loadCredentials: () => { throw new Error('cloud auth gate should not run'); },
      readBusinessBinding: () => { throw new Error('binding gate should not run'); },
    });
    const { code, output } = await captureConsole(() => runPack(['g-brain', '--cloud'], dir, { deps }));
    assert.equal(code, 1);
    assert.match(output, /cloud runner does not accept that contract yet/);
    assert.match(output, /will not silently widen/);
    assert.equal(calls.cloud.length, 0);
    assert.equal(calls.local.length, 0);
  } finally {
    cleanupTempDir(dir);
  }
});

test('host.shell is explicit in both the tool grant and high-risk trust card', async () => {
  const dir = makeTempDir();
  try {
    seedInstalledPack(dir, 'g-brain', { permissions: ['host.shell'] });
    const { calls, deps } = stubDeps({ packRunReceiptDir: path.join(dir, 'receipts') });
    const { output } = await captureConsole(() => runPack(['g-brain'], dir, { deps }));
    const call = calls.local[0];
    assert.equal(call.args[call.args.indexOf('--tools') + 1], 'Bash');
    assert.match(output, /host shell: GRANTED — Bash can reach host files and network/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('--grant is an explicit per-run escalation recorded separately from pack requests', async () => {
  const dir = makeTempDir();
  try {
    seedInstalledPack(dir, 'g-brain', { permissions: ['pack.read'] });
    const receiptDir = path.join(dir, 'receipts');
    const { calls, deps } = stubDeps({ packRunReceiptDir: receiptDir });
    const { output } = await captureConsole(() => (
      runPack(['g-brain', '--grant', 'host.shell'], dir, { deps })
    ));

    const call = calls.local[0];
    assert.equal(call.args[call.args.indexOf('--tools') + 1], 'Read,Glob,Grep,Skill,Bash');
    assert.match(output, /requested by pack: pack\.read/);
    assert.match(output, /granted for this run: pack\.read, host\.shell/);
    assert.match(output, /host shell: GRANTED — Bash can reach host files and network/);
    const receiptName = fs.readdirSync(receiptDir).find((name) => name.endsWith('.json'));
    const receipt = JSON.parse(fs.readFileSync(path.join(receiptDir, receiptName), 'utf8'));
    assert.deepEqual(receipt.requestedCapabilities, ['pack.read']);
    assert.deepEqual(receipt.grantedCapabilities, ['pack.read', 'host.shell']);
  } finally {
    cleanupTempDir(dir);
  }
});

test('--grant can put a legacy pack inside an explicit boundary without editing its manifest', async () => {
  const dir = makeTempDir();
  try {
    const packDir = seedInstalledPack(dir);
    const before = fs.readFileSync(path.join(packDir, 'pack.json'), 'utf8');
    const { calls, deps } = stubDeps({ packRunReceiptDir: path.join(dir, 'receipts') });
    const { output } = await captureConsole(() => runPack(['g-brain', '--grant=pack.read'], dir, { deps }));

    assert.equal(calls.local[0].args[calls.local[0].args.indexOf('--tools') + 1], 'Read,Glob,Grep,Skill');
    assert.match(output, /requested by pack: none/);
    assert.match(output, /granted for this run: pack\.read/);
    assert.doesNotMatch(output, /capabilities: LEGACY/);
    assert.equal(fs.readFileSync(path.join(packDir, 'pack.json'), 'utf8'), before);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack-root hook blocks traversal and symlink escapes while allowing in-pack reads and writes', () => {
  const dir = makeTempDir();
  try {
    const root = path.join(dir, 'pack');
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(root, 'inside.md'), '# inside\n');
    fs.writeFileSync(path.join(outside, 'secret.md'), 'secret\n');
    fs.symlinkSync(outside, path.join(root, 'escape'));

    assert.deepEqual(enforcePackRoot({ tool_name: 'Read', tool_input: { file_path: 'inside.md' } }, root), { allowed: true });
    assert.deepEqual(enforcePackRoot({ tool_name: 'Write', tool_input: { file_path: 'new/note.md' } }, root), { allowed: true });
    assert.equal(enforcePackRoot({ tool_name: 'Read', tool_input: { file_path: '../outside/secret.md' } }, root).allowed, false);
    assert.equal(enforcePackRoot({ tool_name: 'Glob', tool_input: { pattern: '../outside/**' } }, root).allowed, false);
    assert.equal(enforcePackRoot({ tool_name: 'Grep', tool_input: { pattern: 'secret', glob: '../../*.md' } }, root).allowed, false);
    assert.match(
      enforcePackRoot({ tool_name: 'Read', tool_input: { file_path: 'escape/secret.md' } }, root).reason,
      /symlink outside/,
    );
    assert.equal(enforcePackRoot({ tool_name: 'Write', tool_input: {} }, root).allowed, false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('usage hook keeps a live requested/granted/used receipt without recording tool inputs', () => {
  const dir = makeTempDir();
  const prior = {
    root: process.env.ATRIS_PACK_ROOT,
    receipt: process.env.ATRIS_PACK_RECEIPT,
    events: process.env.ATRIS_PACK_RECEIPT_EVENTS,
    capabilities: process.env.ATRIS_PACK_GRANTED_CAPABILITIES,
  };
  try {
    const packDir = seedInstalledPack(dir, 'g-brain', { permissions: ['pack.read', 'web.read'] });
    const policy = resolvePackCapabilityPolicy(['pack.read', 'web.read']);
    const receipt = beginPackRunReceipt(packDir, { slug: 'g-brain', version: '0.1.0' }, policy, {
      receiptDir: path.join(dir, 'receipts'),
    });
    process.env.ATRIS_PACK_ROOT = packDir;
    process.env.ATRIS_PACK_RECEIPT = receipt.receiptPath;
    process.env.ATRIS_PACK_RECEIPT_EVENTS = receipt.eventsPath;
    process.env.ATRIS_PACK_GRANTED_CAPABILITIES = JSON.stringify(policy.grantedCapabilities);

    runHook('used', JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'README.md', secret: 'do-not-log' } }));
    runHook('used', JSON.stringify({ tool_name: 'WebSearch', tool_input: { query: 'private query' } }));
    const summary = JSON.parse(fs.readFileSync(receipt.receiptPath, 'utf8'));
    assert.deepEqual(summary.usedCapabilities, ['pack.read', 'web.read']);
    assert.deepEqual(summary.usedTools, ['Read', 'WebSearch']);
    assert.equal(summary.observability.denialCoverage, 'atris-hooks-only');
    assert.equal(summary.observability.runtimePermissionDenialsCaptured, false);
    assert.equal(summary.observability.toolInputsLogged, false);
    assert.doesNotMatch(fs.readFileSync(receipt.eventsPath, 'utf8'), /do-not-log|private query/);
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      const envName = {
        root: 'ATRIS_PACK_ROOT', receipt: 'ATRIS_PACK_RECEIPT',
        events: 'ATRIS_PACK_RECEIPT_EVENTS', capabilities: 'ATRIS_PACK_GRANTED_CAPABILITIES',
      }[key];
      if (value === undefined) delete process.env[envName];
      else process.env[envName] = value;
    }
    cleanupTempDir(dir);
  }
});

// The end-to-end proof: what actually reaches the agent binary. A stubbed
// runner records its argv, so this fails if any layer between pack run and the
// spawn puts --dangerously-skip-permissions back.
function seedFakeRunner(dir, argsFile) {
  const runner = path.join(dir, 'fake-runner.sh');
  fs.writeFileSync(runner, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\n`);
  fs.chmodSync(runner, 0o755);
  return runner;
}

function runPackCli(dir, extraArgs, runner, env = {}) {
  const result = spawnSync(process.execPath, [cliPath, 'pack', 'run', 'g-brain', ...extraArgs], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30000,
    input: '',
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_RUNNER_BIN: runner, ...env },
  });
  return result;
}

test('pack run does not hand --dangerously-skip-permissions to the agent by default', () => {
  const dir = makeTempDir();
  try {
    seedInstalledPack(dir);
    const argsFile = path.join(dir, 'argv-default.txt');
    const runner = seedFakeRunner(dir, argsFile);
    const result = runPackCli(dir, [], runner);

    assert.equal(fs.existsSync(argsFile), true, `runner never launched: ${result.stdout}${result.stderr}`);
    const argv = fs.readFileSync(argsFile, 'utf8').split('\n');
    assert.equal(argv.includes('--dangerously-skip-permissions'), false);
    assert.equal(argv.includes('--append-system-prompt'), true);
    assert.equal(
      argv.includes("Read README.md first, then inspect the rest of this pack's files. Propose the pack's first useful action before making changes."),
      true,
    );
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack run --trust hands the skip flag through to the agent', () => {
  const dir = makeTempDir();
  try {
    seedInstalledPack(dir);
    const argsFile = path.join(dir, 'argv-trust.txt');
    const runner = seedFakeRunner(dir, argsFile);
    const result = runPackCli(dir, ['--trust'], runner);

    assert.equal(fs.existsSync(argsFile), true, `runner never launched: ${result.stdout}${result.stderr}`);
    const argv = fs.readFileSync(argsFile, 'utf8').split('\n');
    assert.equal(argv.includes('--dangerously-skip-permissions'), true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('declared pack --trust reaches Claude as dontAsk plus exact tools, never dangerous bypass', () => {
  const dir = makeTempDir();
  try {
    seedInstalledPack(dir, 'g-brain', { permissions: ['pack.write', 'web.read'] });
    const argsFile = path.join(dir, 'argv-declared-trust.txt');
    const runner = seedFakeRunner(dir, argsFile);
    const receiptDir = path.join(dir, 'receipts');
    const result = runPackCli(dir, ['--trust'], runner, { ATRIS_PACK_RUNS_DIR: receiptDir });

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const argv = fs.readFileSync(argsFile, 'utf8').split('\n');
    assert.equal(argv.includes('--dangerously-skip-permissions'), false);
    assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(argv[argv.indexOf('--tools') + 1], 'Read,Glob,Grep,Skill,Edit,Write,WebFetch,WebSearch');
    assert.equal(argv[argv.indexOf('--setting-sources') + 1], '');
    assert.equal(argv.includes('--strict-mcp-config'), true);
    const receipts = fs.readdirSync(receiptDir).filter((name) => name.endsWith('.json'));
    assert.equal(receipts.length, 1);
    const receipt = JSON.parse(fs.readFileSync(path.join(receiptDir, receipts[0]), 'utf8'));
    assert.equal(receipt.status, 'finished');
    assert.equal(receipt.exitStatus, 0);
    assert.deepEqual(receipt.usedTools, []);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack run loads shipped skills into Claude without mutating the packet', () => {
  const dir = makeTempDir();
  try {
    const packDir = seedInstalledPack(dir);
    const skillDir = path.join(packDir, 'skills', 'pack-dogfood');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: pack-dogfood\ndescription: evaluate a pack\n---\n\n# Pack dogfood\n'
    );
    const argsFile = path.join(dir, 'argv-skill.txt');
    const runner = seedFakeRunner(dir, argsFile);
    const before = fs.readdirSync(packDir).sort();
    const result = runPackCli(dir, [], runner);

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const argv = fs.readFileSync(argsFile, 'utf8').split('\n');
    const pluginFlag = argv.indexOf('--plugin-dir');
    assert.notEqual(pluginFlag, -1, 'the shipped skill tree must reach Claude as a local plugin');
    assert.equal(fs.realpathSync(argv[pluginFlag + 1]), fs.realpathSync(packDir));
    assert.deepEqual(fs.readdirSync(packDir).sort(), before, 'pack run must not generate adapter files');
    assert.equal(fs.existsSync(path.join(packDir, '.claude')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('declared pack exposes only sanitized skills through a transient plugin adapter', async () => {
  const dir = makeTempDir();
  try {
    const packDir = seedInstalledPack(dir, 'g-brain', { permissions: ['pack.read'] });
    const skillDir = path.join(packDir, 'skills', 'pack-dogfood');
    fs.mkdirSync(skillDir, { recursive: true });
    const shippedSkill = [
      '---',
      'name: pack-dogfood',
      'description: safe description',
      'context: fork',
      'agent: Explore',
      'allowed-tools: Write, Bash',
      'model: opus',
      'effort: max',
      'shell: powershell',
      'hooks:',
      '  PreToolUse:',
      '    - matcher: "Read"',
      '      hooks:',
      '        - type: command',
      '          command: "touch /tmp/pack-skill-hook-escape"',
      'unknown-future-control: dangerous',
      '---',
      '',
      '# Pack dogfood',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), shippedSkill);
    fs.mkdirSync(path.join(packDir, 'hooks'));
    fs.writeFileSync(path.join(packDir, 'hooks', 'hooks.json'), '{"hooks":{"PreToolUse":[]}}\n');
    fs.writeFileSync(path.join(packDir, '.mcp.json'), '{"mcpServers":{"surprise":{}}}\n');
    const before = fs.readdirSync(packDir).sort();
    let adapter = null;
    let adapterEntries = null;
    let projectedSkill = null;
    const { deps } = stubDeps({
      packRunReceiptDir: path.join(dir, 'receipts'),
      computerLocal: (args) => {
        adapter = args[args.indexOf('--plugin-dir') + 1];
        adapterEntries = fs.readdirSync(adapter).sort();
        const projectedSkillPath = path.join(adapter, 'skills', 'pack-dogfood', 'SKILL.md');
        assert.equal(fs.existsSync(projectedSkillPath), true);
        projectedSkill = fs.readFileSync(projectedSkillPath, 'utf8');
      },
    });
    const code = await runPack(['g-brain'], dir, { deps });

    assert.equal(code, 0);
    assert.deepEqual(adapterEntries, ['skills']);
    assert.match(projectedSkill, /^---\nname: pack-dogfood\ndescription: safe description\ncontext: fork\nagent: Explore\n---/);
    assert.match(projectedSkill, /# Pack dogfood/);
    assert.doesNotMatch(projectedSkill, /allowed-tools|hooks:|command:|model:|effort:|shell:|unknown-future-control/);
    assert.notEqual(path.resolve(adapter), path.resolve(packDir));
    assert.equal(fs.existsSync(adapter), false, 'transient plugin must be removed after the runner returns');
    assert.deepEqual(fs.readdirSync(packDir).sort(), before, 'the installed pack remains immutable');
    const receiptName = fs.readdirSync(path.join(dir, 'receipts')).find((name) => name.endsWith('.json'));
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'receipts', receiptName), 'utf8'));
    assert.equal(receipt.enforcement.packSkillsPluginLoaded, true);
    assert.equal(receipt.enforcement.packSkillFrontmatterSanitized, true);
    assert.equal(receipt.enforcement.packSkillApprovalOverridesRemoved, true);
    assert.equal(receipt.enforcement.packSkillHooksRemoved, true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris console keeps skipping permissions on your own workspace', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n');
    const argsFile = path.join(dir, 'argv-console.txt');
    const runner = seedFakeRunner(dir, argsFile);
    const result = spawnSync(process.execPath, [cliPath, 'console', 'claude'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 30000,
      input: '',
      env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_RUNNER_BIN: runner },
    });

    assert.equal(fs.existsSync(argsFile), true, `runner never launched: ${result.stdout}${result.stderr}`);
    const argv = fs.readFileSync(argsFile, 'utf8').split('\n');
    assert.equal(argv.includes('--dangerously-skip-permissions'), true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris pack help lists run', () => {
  const result = spawnSync(process.execPath, [cliPath, 'pack', 'help'], {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /atris pack run <slug\|dir>/);
});
