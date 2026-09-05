const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { runPack } = require('../commands/pack');
const {
  resolvePackCapabilityPolicy,
  readClaudeUserDenyRules,
  beginPackRunReceipt,
  appendReceiptEvent,
  finalizePackRunReceipt,
  classifyPackRunLifecycle,
  enforcePackRoot,
  publicWebUrlPreflight,
  enforcePublicWeb,
  runHook,
  runHookAsync,
  assessPackRecoveryJournal,
  packRecoveryClaimPath,
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

function capturedPackPrompt(call) {
  return call.options.promptStdin === undefined
    ? call.args[0]
    : call.options.promptStdin;
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
    assert.equal(calls.local[0].args.length, 0);
    assert.match(capturedPackPrompt(calls.local[0]), /untrusted task text/);
    assert.match(
      capturedPackPrompt(calls.local[0]),
      /Read README\.md first, then inspect the rest of this pack's files\. Propose the pack's first useful action before making changes\.$/,
    );
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

    assert.equal(calls.local[0].args.length, 0);
    assert.match(capturedPackPrompt(calls.local[0]), /^A pack supplied the following opening instruction\./);
    assert.match(capturedPackPrompt(calls.local[0]), /not as a Claude CLI slash command/);
    assert.match(capturedPackPrompt(calls.local[0]), new RegExp(`${manifest.entrypoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
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

    assert.equal(calls.local[0].args.length, 0);
    assert.match(capturedPackPrompt(calls.local[0]), /Read the brief, then draft the launch checklist\.$/);
    assert.doesNotMatch(output, /declares no entrypoint/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack run injects bounded operator input without exposing its host path or contents in the receipt', async () => {
  const dir = makeTempDir();
  try {
    seedInstalledPack(dir, 'g-brain', {
      permissions: ['pack.read'],
      entrypoint: 'Evaluate the supplied lifecycle record.',
    });
    const inputPath = path.join(dir, 'private-target-evidence.json');
    const input = '{"schema":"atris.pack-inspect.v1","secret":"TARGET_INPUT_CANARY"}\n';
    fs.writeFileSync(inputPath, input, 'utf8');
    const receiptDir = path.join(dir, 'receipts');
    const { calls, deps } = stubDeps({ packRunReceiptDir: receiptDir, nonInteractive: false });

    const { code, output } = await captureConsole(() => runPack([
      'g-brain', '--input', inputPath, '--trust',
    ], dir, { deps }));

    assert.equal(code, 0);
    assert.equal(calls.local.length, 1);
    const prompt = capturedPackPrompt(calls.local[0]);
    assert.match(prompt, /^A pack supplied the following opening instruction\./);
    assert.match(prompt, /Evaluate the supplied lifecycle record\./);
    assert.match(prompt, /The operator supplied the following run input\./);
    assert.match(prompt, /TARGET_INPUT_CANARY/);
    assert.ok(prompt.indexOf('opening instruction') < prompt.indexOf('operator supplied'));
    assert.equal(prompt.includes(inputPath), false, 'the host input path must not enter the pack prompt');
    assert.equal(calls.local[0].args.some((arg) => arg.includes('TARGET_INPUT_CANARY')), false);
    assert.equal(calls.local[0].args.includes('--no-session-persistence'), true);
    assert.match(output, new RegExp(`operator input: ${Buffer.byteLength(input)} bytes injected`));
    assert.match(output, /prompt transport: stdin; the opening instruction and operator input are omitted from runner argv/);

    const receiptName = fs.readdirSync(receiptDir).find((name) => name.endsWith('.json'));
    const receipt = JSON.parse(fs.readFileSync(path.join(receiptDir, receiptName), 'utf8'));
    assert.deepEqual(receipt.operatorInput, {
      bytes: Buffer.byteLength(input),
      sha256: createHash('sha256').update(input).digest('hex'),
    });
    const serializedReceipt = JSON.stringify(receipt);
    assert.equal(serializedReceipt.includes(inputPath), false);
    assert.equal(serializedReceipt.includes('TARGET_INPUT_CANARY'), false);
    assert.deepEqual(receipt.grantedCapabilities, ['pack.read']);
    assert.deepEqual(receipt.grantedTools, ['Read', 'Glob', 'Grep', 'Skill']);
    assert.equal(receipt.enforcement.openingPromptTransport, 'stdin');
    assert.equal(receipt.enforcement.runnerArgvContainsOpeningPrompt, false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack run rejects unsafe input files before install or runner launch', async () => {
  const dir = makeTempDir();
  try {
    const directory = path.join(dir, 'directory-input');
    fs.mkdirSync(directory);
    const regular = path.join(dir, 'regular.txt');
    fs.writeFileSync(regular, 'evidence\n', 'utf8');
    const symlink = path.join(dir, 'symlink-input');
    fs.symlinkSync(regular, symlink);
    const empty = path.join(dir, 'empty.txt');
    fs.writeFileSync(empty, '');
    const oversized = path.join(dir, 'oversized.txt');
    fs.writeFileSync(oversized, Buffer.alloc((256 * 1024) + 1, 0x61));
    const invalidUtf8 = path.join(dir, 'invalid-utf8.txt');
    fs.writeFileSync(invalidUtf8, Buffer.from([0xff]));

    for (const [inputPath, expected] of [
      [path.join(dir, 'missing.txt'), /input file not found/],
      [directory, /must be a regular file/],
      [symlink, /must be a regular file/],
      [empty, /input file is empty/],
      [oversized, /exceeds the 262144-byte limit/],
      [invalidUtf8, /must be UTF-8 text/],
    ]) {
      const { calls, deps } = stubDeps({
        installPack: async () => { calls.install.push('unexpected'); return 0; },
      });
      await assert.rejects(
        () => runPack(['not-installed', '--input', inputPath], dir, { deps }),
        expected,
      );
      assert.equal(calls.install.length, 0);
      assert.equal(calls.local.length, 0);
      assert.equal(calls.cloud.length, 0);
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack run input fails closed for cloud and unbounded legacy runs', async () => {
  const dir = makeTempDir();
  try {
    const inputPath = path.join(dir, 'evidence.json');
    fs.writeFileSync(inputPath, '{}\n', 'utf8');

    const cloud = stubDeps({
      installPack: async () => { cloud.calls.install.push('unexpected'); return 0; },
    });
    await assert.rejects(
      () => runPack(['not-installed', '--cloud', '--input', inputPath], dir, { deps: cloud.deps }),
      /--input is local-only/,
    );
    assert.equal(cloud.calls.install.length, 0);
    assert.equal(cloud.calls.cloud.length, 0);

    seedInstalledPack(dir, 'legacy-pack');
    const legacy = stubDeps();
    await assert.rejects(
      () => runPack(['legacy-pack', '--input', inputPath], dir, { deps: legacy.deps }),
      /--input requires an enforced capability ceiling/,
    );
    assert.equal(legacy.calls.local.length, 0);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack run help documents bounded operator input', async () => {
  const { code, output } = await captureConsole(() => runPack(['--help']));
  assert.equal(code, 0);
  assert.match(output, /atris pack run <slug\|dir> \[--dir <target>\] \[--input <file>\]/);
  assert.match(output, /--input is local and headless; its opening\/evidence envelope is piped over stdin, not runner argv/);
});

test('pack opening text cannot select a native Claude slash command', async () => {
  const dir = makeTempDir();
  try {
    const packDir = seedInstalledPack(dir, 'g-brain', { permissions: [] });
    const manifestPath = path.join(packDir, 'pack.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.entrypoint = '/help';
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const { calls, deps } = stubDeps({ packRunReceiptDir: path.join(dir, 'receipts') });

    await runPack(['g-brain'], dir, { deps });

    assert.equal(capturedPackPrompt(calls.local[0]).startsWith('/'), false);
    assert.match(capturedPackPrompt(calls.local[0]), /untrusted task text/);
    assert.match(capturedPackPrompt(calls.local[0]), /\n\/help$/);
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
      /not an atris pack \(no pack\.json\)/
    );

    fs.writeFileSync(path.join(dir, 'not-a-pack', 'pack.json'), '{ broken');
    await assert.rejects(
      () => runPack([path.join(dir, 'not-a-pack')], dir, { deps }),
      /pack is invalid/
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
    assert.match(output, /--grant pack\.read/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack run refuses unbounded --trust for a legacy packet', async () => {
  const dir = makeTempDir();
  try {
    seedInstalledPack(dir);
    const { calls, deps } = stubDeps();
    await assert.rejects(
      () => runPack(['g-brain', '--trust'], dir, { deps }),
      /legacy pack has no declared capability ceiling[\s\S]*--grant pack\.read --trust/
    );
    assert.equal(calls.local.length, 0);
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
    assert.equal(call.args.includes('--no-chrome'), true);
    assert.equal(call.args.includes('--no-session-persistence'), true);
    assert.equal(call.args[call.args.indexOf('--setting-sources') + 1], '');
    assert.equal(call.args.includes('--strict-mcp-config'), true);
    assert.deepEqual(JSON.parse(call.args[call.args.indexOf('--mcp-config') + 1]), { mcpServers: {} });
    const settings = JSON.parse(call.args[call.args.indexOf('--settings') + 1]);
    assert.equal(settings.permissions.disableBypassPermissionsMode, 'disable');
    assert.equal(settings.permissions.disableAutoMode, 'disable');
    assert.equal(settings.disableSkillShellExecution, true);
    assert.equal(settings.hooks.PreToolUse[0].matcher, 'Read|Glob|Grep|Edit|Write|WebFetch|Bash');
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
    assert.equal(receipt.enforcement.claudeSettingsGuard, true);
    assert.equal(receipt.enforcement.preLaunchContextBoundary, true);
    assert.equal(receipt.enforcement.declaredTreeSymlinksRejected, true);
    assert.equal(receipt.enforcement.packOpeningSlashCommandsEscaped, true);
    assert.equal(receipt.enforcement.claudeMemoryDisabledByRunner, true);
    assert.equal(receipt.enforcement.autoMemoryDisabledByRunner, true);
    assert.equal(receipt.enforcement.chromeIntegrationDisabledByRunner, true);
    assert.equal(receipt.enforcement.sessionPersistenceSuppressionRequested, true);
    assert.equal(receipt.enforcement.sessionPersistenceDisabledByRunner, true);
    assert.equal(receipt.enforcement.sessionPersistenceMayApply, false);
    assert.equal(receipt.enforcement.openingPromptTransport, 'stdin');
    assert.equal(receipt.enforcement.runnerArgvContainsOpeningPrompt, false);
    assert.equal(receipt.enforcement.workspaceTrustPromptMayApply, false);
    assert.equal(receipt.enforcement.workspaceTrustDoesNotWidenToolCeiling, true);
    assert.equal(receipt.enforcement.webReadDestinationPreflight, 'literal-and-dns-private-address-deny');
    assert.equal(receipt.enforcement.webReadDnsRebindingNotPrevented, true);
    assert.equal(receipt.enforcement.subprocessCredentialScrubRequested, true);
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
    assert.equal(call.options.runnerEnv.CLAUDE_CODE_SKIP_PROMPT_HISTORY, '1');
    assert.equal(call.options.runnerEnv.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, '1');
    assert.match(output, /memory isolation: Claude memory files and auto-memory are disabled/);
    assert.match(output, /extensions: user\/project skills, plugins, agents, hooks, and commands are not loaded/);
    assert.match(output, /native integrations: Chrome is disabled/);
    assert.match(output, /public web boundary: WebFetch rejects literal and DNS-resolved local\/private addresses/);
    assert.match(output, /DNS rebinding remains a runner limit/);
    assert.match(output, /session storage: disabled for this headless run/);
    assert.match(output, /workspace trust: Claude skips its first-run directory dialog in headless mode/);
    assert.match(output, /skill sources: shipped pack skills plus Claude built-ins only/);
    assert.match(output, /skill frontmatter: projected through a safe metadata allowlist/);
    assert.match(output, /skill shell: dynamic shell preprocessing is disabled/);
    assert.match(output, /operator policy: 0 user deny rules imported; managed policy may still apply/);
    assert.deepEqual(receipt.observability, {
      denialCoverage: 'atris-hooks-only',
      runtimePermissionDenialsCaptured: false,
      toolInputsLogged: false,
      directSkillInvocationsCaptured: false,
      runnerExitCaptured: false,
      fileEffectIdentitiesLogged: true,
      recoveryLinked: false,
      protectedFilesCarried: 0,
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

test('interactive declared runs stay compatible and disclose that local session history may persist', async () => {
  const dir = makeTempDir();
  try {
    seedInstalledPack(dir, 'g-brain', { permissions: [] });
    const receiptDir = path.join(dir, 'receipts');
    const { calls, deps } = stubDeps({
      packRunReceiptDir: receiptDir,
      nonInteractive: false,
    });
    const { output } = await captureConsole(() => runPack(['g-brain'], dir, { deps }));

    const call = calls.local[0];
    assert.equal(call.args.includes('--no-chrome'), true);
    assert.equal(call.args.includes('--no-session-persistence'), false);
    assert.equal(call.options.promptStdin, undefined);
    assert.match(call.args[0], /untrusted task text/);
    assert.equal(call.options.runnerEnv.CLAUDE_CODE_SKIP_PROMPT_HISTORY, '1');
    assert.match(output, /session storage: suppression requested; interactive Claude may still persist plaintext local history/);
    assert.match(output, /prompt transport: interactive runner argument/);
    assert.match(output, /workspace trust: Claude may next show its generic directory dialog/);
    assert.match(output, /does not widen the tool ceiling above/);
    const receiptName = fs.readdirSync(receiptDir).find((name) => name.endsWith('.json'));
    const receipt = JSON.parse(fs.readFileSync(path.join(receiptDir, receiptName), 'utf8'));
    assert.equal(receipt.enforcement.sessionPersistenceSuppressionRequested, true);
    assert.equal(receipt.enforcement.sessionPersistenceDisabledByRunner, false);
    assert.equal(receipt.enforcement.sessionPersistenceMayApply, true);
    assert.equal(receipt.enforcement.openingPromptTransport, 'argv');
    assert.equal(receipt.enforcement.runnerArgvContainsOpeningPrompt, true);
    assert.equal(receipt.enforcement.workspaceTrustPromptMayApply, true);
    assert.equal(receipt.enforcement.workspaceTrustDoesNotWidenToolCeiling, true);
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
    assert.equal(settings.hooks.PreToolUse[0].matcher, 'Read|Glob|Grep|Edit|Write|WebFetch|Bash');
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

test('web.read preflight rejects local and private destinations without logging their URLs', async () => {
  assert.equal(publicWebUrlPreflight({
    tool_name: 'WebFetch', tool_input: { url: 'http://127.0.0.1:43817/canary.txt' },
  }).allowed, false);
  assert.equal(publicWebUrlPreflight({
    tool_name: 'WebFetch', tool_input: { url: 'http://2130706433/canary.txt' },
  }).allowed, false);
  assert.equal(publicWebUrlPreflight({
    tool_name: 'WebFetch', tool_input: { url: 'https://[::1]/canary.txt' },
  }).allowed, false);
  assert.equal(publicWebUrlPreflight({
    tool_name: 'WebFetch', tool_input: { url: 'https://service.internal/canary.txt' },
  }).allowed, false);
  assert.equal(publicWebUrlPreflight({
    tool_name: 'WebFetch', tool_input: { url: 'https://example.com/' },
  }).allowed, true);

  assert.equal((await enforcePublicWeb({
    tool_name: 'WebFetch', tool_input: { url: 'https://private.example/canary.txt' },
  }, { lookup: async () => [{ address: '10.1.2.3', family: 4 }] })).allowed, false);
  assert.deepEqual(await enforcePublicWeb({
    tool_name: 'WebFetch', tool_input: { url: 'https://public.example/' },
  }, { lookup: async () => [{ address: '93.184.216.34', family: 4 }] }), { allowed: true });
});

test('web.read private-network denial is receipted without recording the destination', async () => {
  const dir = makeTempDir();
  const prior = {
    root: process.env.ATRIS_PACK_ROOT,
    receipt: process.env.ATRIS_PACK_RECEIPT,
    events: process.env.ATRIS_PACK_RECEIPT_EVENTS,
    capabilities: process.env.ATRIS_PACK_GRANTED_CAPABILITIES,
  };
  try {
    const packDir = seedInstalledPack(dir, 'g-brain', { permissions: ['web.read'] });
    const policy = resolvePackCapabilityPolicy(['web.read']);
    const receipt = beginPackRunReceipt(packDir, { slug: 'g-brain', version: '0.1.0' }, policy, {
      receiptDir: path.join(dir, 'receipts'),
    });
    process.env.ATRIS_PACK_ROOT = packDir;
    process.env.ATRIS_PACK_RECEIPT = receipt.receiptPath;
    process.env.ATRIS_PACK_RECEIPT_EVENTS = receipt.eventsPath;
    process.env.ATRIS_PACK_GRANTED_CAPABILITIES = JSON.stringify(policy.grantedCapabilities);

    const result = await runHookAsync('pre', JSON.stringify({
      tool_name: 'WebFetch', tool_input: { url: 'https://metadata.private.example/secret-canary' },
    }), { lookup: async () => [{ address: '169.254.169.254', family: 4 }] });
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(result.hookSpecificOutput.permissionDecisionReason, /public network destinations/);
    const summary = JSON.parse(fs.readFileSync(receipt.receiptPath, 'utf8'));
    assert.deepEqual(summary.deniedUses.map(({ tool }) => tool), ['WebFetch']);
    assert.doesNotMatch(fs.readFileSync(receipt.eventsPath, 'utf8'), /metadata\.private|secret-canary|169\.254/);
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

test('session end stops reporting a pack run as live before runner exit is captured', () => {
  const dir = makeTempDir();
  const prior = {
    root: process.env.ATRIS_PACK_ROOT,
    receipt: process.env.ATRIS_PACK_RECEIPT,
    events: process.env.ATRIS_PACK_RECEIPT_EVENTS,
    capabilities: process.env.ATRIS_PACK_GRANTED_CAPABILITIES,
  };
  try {
    const packDir = seedInstalledPack(dir, 'g-brain', { permissions: ['pack.read'] });
    const policy = resolvePackCapabilityPolicy(['pack.read']);
    const receipt = beginPackRunReceipt(packDir, { slug: 'g-brain', version: '0.1.0' }, policy, {
      receiptDir: path.join(dir, 'receipts'),
    });
    process.env.ATRIS_PACK_ROOT = packDir;
    process.env.ATRIS_PACK_RECEIPT = receipt.receiptPath;
    process.env.ATRIS_PACK_RECEIPT_EVENTS = receipt.eventsPath;
    process.env.ATRIS_PACK_GRANTED_CAPABILITIES = JSON.stringify(policy.grantedCapabilities);

    runHook('session-end', JSON.stringify({ reason: 'private-custom-reason' }));
    let summary = JSON.parse(fs.readFileSync(receipt.receiptPath, 'utf8'));
    assert.equal(summary.status, 'session-ended');
    assert.equal(summary.sessionEndReason, 'other');
    assert.doesNotMatch(fs.readFileSync(receipt.eventsPath, 'utf8'), /private-custom-reason/);

    runHook('session-end', JSON.stringify({
      reason: 'prompt_input_exit',
      transcript_path: '/private/plaintext/session.jsonl',
    }));
    summary = JSON.parse(fs.readFileSync(receipt.receiptPath, 'utf8'));
    assert.equal(summary.status, 'session-ended');
    assert.equal(summary.sessionEndReason, 'prompt_input_exit');
    assert.match(summary.sessionEndedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(summary.observability.runnerExitCaptured, false);
    assert.doesNotMatch(fs.readFileSync(receipt.eventsPath, 'utf8'), /plaintext|session\.jsonl/);

    appendReceiptEvent(receipt.eventsPath, {
      event: 'exit', at: '2026-08-02T09:00:00.000Z', status: 130, signal: 'SIGINT',
    });
    summary = finalizePackRunReceipt(receipt.receiptPath, receipt.eventsPath);
    assert.equal(summary.status, 'finished');
    assert.equal(summary.exitStatus, 130);
    assert.equal(summary.signal, 'SIGINT');
    assert.equal(summary.sessionEndReason, 'prompt_input_exit');
    assert.equal(summary.observability.runnerExitCaptured, true);
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

test('pack run lifecycle distinguishes active launchers from lost control without guessing runner exit', () => {
  const running = { status: 'running', launcher: { pid: 4242 } };
  assert.deepEqual(classifyPackRunLifecycle(running, { processExists: () => true }), {
    status: 'running',
    recordedStatus: 'running',
    launcherStatus: 'active',
    runnerStatus: 'unknown',
  });
  assert.deepEqual(classifyPackRunLifecycle(running, { processExists: () => false }), {
    status: 'launcher-lost',
    recordedStatus: 'running',
    launcherStatus: 'lost',
    runnerStatus: 'unknown',
  });
  assert.deepEqual(classifyPackRunLifecycle({ status: 'running' }), {
    status: 'unknown',
    recordedStatus: 'running',
    launcherStatus: 'unknown',
    runnerStatus: 'unknown',
  });
  assert.deepEqual(classifyPackRunLifecycle({ status: 'finished', launcher: { pid: 4242 } }), {
    status: 'finished',
    recordedStatus: 'finished',
    launcherStatus: 'not-needed',
    runnerStatus: 'ended',
  });
});

test('pack runs reports launcher-lost read-only when an abrupt kill left no terminal event', () => {
  const dir = makeTempDir();
  try {
    const packDir = seedInstalledPack(dir, 'lost-launcher', { permissions: ['pack.read'] });
    const receiptDir = path.join(dir, 'receipts');
    const policy = resolvePackCapabilityPolicy(['pack.read']);
    const receipt = beginPackRunReceipt(packDir, { slug: 'lost-launcher', version: '0.1.0' }, policy, {
      receiptDir,
      launcherPid: 987654321,
    });
    const before = fs.readFileSync(receipt.receiptPath, 'utf8');

    const result = spawnSync(process.execPath, [cliPath, 'pack', 'runs', '--json'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_PACK_RUNS_DIR: receiptDir },
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.runs.length, 1);
    assert.equal(output.runs[0].status, 'launcher-lost');
    assert.equal(output.runs[0].recordedStatus, 'running');
    assert.equal(output.runs[0].launcherStatus, 'lost');
    assert.equal(output.runs[0].runnerStatus, 'unknown');
    assert.equal(output.runs[0].launcherPid, 987654321);
    assert.equal(output.runs[0].receiptPath, receipt.receiptPath);
    assert.equal(fs.readFileSync(receipt.receiptPath, 'utf8'), before, 'history inspection must not rewrite evidence');
  } finally {
    cleanupTempDir(dir);
  }
});

// The end-to-end proof: what actually reaches the agent binary. A stubbed
// runner records its argv, so this fails if any layer between pack run and the
// spawn puts --dangerously-skip-permissions back.
function seedFakeRunner(dir, argsFile, stdinFile = null) {
  const runner = path.join(dir, 'fake-runner.sh');
  const stdinTarget = stdinFile ? JSON.stringify(stdinFile) : '/dev/null';
  fs.writeFileSync(
    runner,
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\ncat > ${stdinTarget}\n`,
  );
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
    const stdinFile = path.join(dir, 'stdin-default.txt');
    const runner = seedFakeRunner(dir, argsFile, stdinFile);
    const result = runPackCli(dir, [], runner);

    assert.equal(fs.existsSync(argsFile), true, `runner never launched: ${result.stdout}${result.stderr}`);
    const argv = fs.readFileSync(argsFile, 'utf8').split('\n');
    const stdin = fs.readFileSync(stdinFile, 'utf8');
    assert.equal(argv.includes('--dangerously-skip-permissions'), false);
    assert.equal(argv.includes('--append-system-prompt'), true);
    assert.equal(argv.includes('--print'), true);
    assert.equal(argv.some((arg) => arg.includes("Read README.md first")), false);
    assert.match(
      stdin,
      /Read README\.md first, then inspect the rest of this pack's files\. Propose the pack's first useful action before making changes\./,
    );
  } finally {
    cleanupTempDir(dir);
  }
});

test('headless pack input reaches the runner over stdin and stays out of argv', () => {
  const dir = makeTempDir();
  try {
    seedInstalledPack(dir, 'g-brain', {
      permissions: ['pack.read'],
      entrypoint: 'Evaluate the supplied evidence.',
    });
    const inputPath = path.join(dir, 'private-evidence.txt');
    fs.writeFileSync(inputPath, 'ARGV_CANARY_PACK_INPUT_7F4C9E\n', 'utf8');
    const argsFile = path.join(dir, 'argv-input.txt');
    const stdinFile = path.join(dir, 'stdin-input.txt');
    const runner = seedFakeRunner(dir, argsFile, stdinFile);
    const receiptDir = path.join(dir, 'receipts');

    const result = runPackCli(
      dir,
      ['--input', inputPath, '--trust'],
      runner,
      { ATRIS_PACK_RUNS_DIR: receiptDir },
    );

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const argv = fs.readFileSync(argsFile, 'utf8').split('\n');
    const stdin = fs.readFileSync(stdinFile, 'utf8');
    assert.equal(argv.includes('--print'), true);
    assert.equal(argv.includes('--no-session-persistence'), true);
    assert.equal(argv.some((arg) => arg.includes('ARGV_CANARY_PACK_INPUT_7F4C9E')), false);
    assert.equal(argv.some((arg) => arg.includes('operator supplied the following run input')), false);
    assert.match(stdin, /A pack supplied the following opening instruction/);
    assert.match(stdin, /The operator supplied the following run input/);
    assert.match(stdin, /ARGV_CANARY_PACK_INPUT_7F4C9E/);
    assert.match(result.stdout, /prompt transport: stdin/);

    const receiptName = fs.readdirSync(receiptDir).find((name) => name.endsWith('.json'));
    const receipt = JSON.parse(fs.readFileSync(path.join(receiptDir, receiptName), 'utf8'));
    assert.equal(receipt.enforcement.openingPromptTransport, 'stdin');
    assert.equal(receipt.enforcement.runnerArgvContainsOpeningPrompt, false);
    assert.equal(JSON.stringify(receipt).includes('ARGV_CANARY_PACK_INPUT_7F4C9E'), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('legacy pack --trust fails before the agent instead of handing through the dangerous bypass', () => {
  const dir = makeTempDir();
  try {
    seedInstalledPack(dir);
    const argsFile = path.join(dir, 'argv-trust.txt');
    const runner = seedFakeRunner(dir, argsFile);
    const result = runPackCli(dir, ['--trust'], runner);

    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.equal(fs.existsSync(argsFile), false);
    assert.match(result.stderr, /legacy pack has no declared capability ceiling/);
    assert.match(result.stderr, /--grant pack\.read --trust/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('legacy pack can opt into bounded read-only trust with an explicit grant', () => {
  const dir = makeTempDir();
  try {
    seedInstalledPack(dir);
    const argsFile = path.join(dir, 'argv-bounded-trust.txt');
    const runner = seedFakeRunner(dir, argsFile);
    const receiptDir = path.join(dir, 'receipts');
    const result = runPackCli(
      dir,
      ['--grant', 'pack.read', '--trust'],
      runner,
      { ATRIS_PACK_RUNS_DIR: receiptDir },
    );

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const argv = fs.readFileSync(argsFile, 'utf8').split('\n');
    assert.equal(argv.includes('--dangerously-skip-permissions'), false);
    assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(argv[argv.indexOf('--tools') + 1], 'Read,Glob,Grep,Skill');
    const receiptName = fs.readdirSync(receiptDir).find((name) => name.endsWith('.json'));
    const receipt = JSON.parse(fs.readFileSync(path.join(receiptDir, receiptName), 'utf8'));
    assert.deepEqual(receipt.requestedCapabilities, []);
    assert.deepEqual(receipt.grantedCapabilities, ['pack.read']);
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
    assert.equal(argv.includes('--no-chrome'), true);
    assert.equal(argv.includes('--no-session-persistence'), true);
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
  const dir = makeTempDir();
  let result;
  try {
    result = spawnSync(process.execPath, [cliPath, 'pack', 'help'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
    });
  } finally {
    cleanupTempDir(dir);
  }
  assert.equal(result.status, 0);
  assert.match(result.stdout, /atris pack run <slug\|dir>/);
  assert.match(result.stdout, /atris pack runs/);
  assert.match(result.stdout, /legacy packs need an explicit --grant before --trust/);
});

test('atris pack help lists run', () => {
  const dir = makeTempDir();
  let result;
  try {
    result = spawnSync(process.execPath, [cliPath, 'pack', 'help'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
    });
  } finally {
    cleanupTempDir(dir);
  }
  assert.equal(result.status, 0);
  assert.match(result.stdout, /atris pack run <slug\|dir>/);
  assert.match(result.stdout, /atris pack runs/);
  assert.match(result.stdout, /legacy packs need an explicit --grant before --trust/);
});

// ── pack recovery (CLI-1334) ─────────────────────────────────────────────
// The model is simulated at the computerLocal seam. The filesystem and the
// real pre/used/failed hooks do the recording, so these prove enforcement,
// not prompt wording.

function seedRecoveryPack(dir, slug = 'recover-pack') {
  const packDir = path.join(dir, slug);
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(
    path.join(packDir, 'pack.json'),
    `${JSON.stringify({ slug, title: 'Recover Pack', version: '0.1.0', permissions: ['pack.write'] }, null, 2)}\n`
  );
  fs.writeFileSync(path.join(packDir, 'README.md'), '# Recover Pack\n');
  fs.writeFileSync(path.join(packDir, 'notes.txt'), 'base CANARY-RECOVERY-7F2E\nMARKER\n');
  fs.writeFileSync(path.join(packDir, 'other.txt'), 'other base\n');
  return packDir;
}

function withHookEnv(runnerEnv, fn) {
  const names = [
    'ATRIS_PACK_ROOT', 'ATRIS_PACK_RECEIPT', 'ATRIS_PACK_RECEIPT_EVENTS',
    'ATRIS_PACK_GRANTED_CAPABILITIES', 'ATRIS_PACK_PROTECTED_FILES',
  ];
  const saved = {};
  for (const name of names) saved[name] = process.env[name];
  for (const [key, value] of Object.entries(runnerEnv || {})) process.env[key] = String(value);
  try {
    return fn();
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

function hookInput(tool, filePath, id) {
  return JSON.stringify({
    tool_name: tool,
    tool_input: { file_path: filePath },
    ...(id ? { tool_use_id: id } : {}),
  });
}

function hookPre(runnerEnv, tool, filePath, id) {
  return withHookEnv(runnerEnv, () => runHook('pre', hookInput(tool, filePath, id)));
}

function hookUsed(runnerEnv, tool, filePath, id) {
  return withHookEnv(runnerEnv, () => runHook('used', hookInput(tool, filePath, id)));
}

function hookFailed(runnerEnv, tool, filePath, id) {
  return withHookEnv(runnerEnv, () => runHook('failed', hookInput(tool, filePath, id)));
}

function applyMarkerEdit(absPath) {
  const before = fs.readFileSync(absPath, 'utf8');
  assert.ok(before.includes('MARKER'), 'marker must still be present to apply the edit');
  fs.writeFileSync(absPath, before.replace('MARKER', 'MARKER\nRECOVERY-LINE-20260904'));
}

function countLines(absPath, line) {
  return fs.readFileSync(absPath, 'utf8').split('\n').filter((entry) => entry === line).length;
}

function latestReceipt(receiptDir) {
  const names = fs.readdirSync(receiptDir).filter((name) => name.endsWith('.json')).sort();
  assert.ok(names.length, 'expected at least one receipt');
  const receiptPath = path.join(receiptDir, names[names.length - 1]);
  return { path: receiptPath, data: JSON.parse(fs.readFileSync(receiptPath, 'utf8')) };
}

function readReceiptEvents(receiptDir, receipt) {
  return fs.readFileSync(path.join(receiptDir, receipt.data.events), 'utf8');
}

function recoveringDeps(receiptDir, computerLocal) {
  return stubDeps({ packRunReceiptDir: receiptDir, nonInteractive: true, computerLocal });
}

test('pack recover continues after an interrupted edit without repeating the completed file', async () => {
  const dir = makeTempDir();
  try {
    const packDir = seedRecoveryPack(dir);
    const receiptDir = path.join(dir, 'receipts');
    const notesPath = path.join(packDir, 'notes.txt');
    const otherPath = path.join(packDir, 'other.txt');

    const first = recoveringDeps(receiptDir, (args, options) => {
      assert.equal(hookPre(options.runnerEnv, 'Edit', 'notes.txt', 'call-first-1'), null);
      applyMarkerEdit(notesPath);
      hookUsed(options.runnerEnv, 'Edit', 'notes.txt', 'call-first-1');
      options.onRunnerExit({ status: 1, signal: null });
    });
    assert.equal(await runPack([packDir], dir, { deps: first.deps }), 0);
    assert.equal(countLines(notesPath, 'RECOVERY-LINE-20260904'), 1);
    const parent = latestReceipt(receiptDir);
    assert.equal(parent.data.exitStatus, 1);
    assert.deepEqual(parent.data.usedTools, ['Edit']);
    assert.equal(parent.data.fileEffects.confirmed.length, 1);
    assert.equal(parent.data.fileEffects.confirmed[0].target, 'notes.txt');
    assert.deepEqual(parent.data.fileEffects.unresolved, []);
    assert.equal(parent.data.recovery.mode, 'fresh');

    let denyResult = null;
    const second = recoveringDeps(receiptDir, (args, options) => {
      denyResult = hookPre(options.runnerEnv, 'Edit', 'notes.txt', 'call-second-1');
      assert.ok(denyResult && denyResult.hookSpecificOutput.permissionDecision === 'deny');
      assert.equal(hookPre(options.runnerEnv, 'Edit', 'other.txt', 'call-second-2'), null);
      fs.appendFileSync(otherPath, 'recovered work\n');
      hookUsed(options.runnerEnv, 'Edit', 'other.txt', 'call-second-2');
      options.onRunnerExit({ status: 0, signal: null });
    });
    const { code, output } = await captureConsole(() => runPack([packDir, '--recover', parent.path], dir, { deps: second.deps }));
    assert.equal(code, 0);
    assert.match(output, /recovery: continuing from/);
    assert.ok(denyResult && denyResult.hookSpecificOutput.permissionDecision === 'deny', 'same Edit is denied even with a new call id');
    assert.equal(countLines(notesPath, 'RECOVERY-LINE-20260904'), 1, 'the completed edit must not repeat');
    assert.match(fs.readFileSync(otherPath, 'utf8'), /recovered work/);

    const child = latestReceipt(receiptDir);
    assert.equal(child.data.recovery.mode, 'recovered');
    assert.equal(child.data.recovery.parentRunId, parent.data.runId);
    assert.equal(child.data.recovery.parentReceipt, parent.path);
    const protectedTargets = child.data.recovery.protectedFiles.map((entry) => entry.target).sort();
    assert.deepEqual(protectedTargets, ['notes.txt', 'other.txt']);
    assert.equal(child.data.observability.recoveryLinked, true);
    assert.equal(child.data.observability.protectedFilesCarried, 2);

    const journal = readReceiptEvents(receiptDir, child) + readReceiptEvents(receiptDir, parent);
    assert.equal(journal.includes('RECOVERY-LINE-20260904'), false, 'journal must not carry file contents');
    assert.equal(journal.includes('recovered work'), false, 'journal must not carry file contents');
    assert.equal(journal.includes('CANARY-RECOVERY-7F2E'), false, 'journal must not carry file contents');
    assert.equal(JSON.stringify(child.data).includes('CANARY-RECOVERY-7F2E'), false);

    const parentAgain = JSON.parse(fs.readFileSync(parent.path, 'utf8'));
    assert.equal(parentAgain.exitStatus, 1, 'recovery must not rewrite the parent receipt');
    assert.equal(parentAgain.status, 'finished');
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack recover refuses a pending intent whose confirmation never arrived', async () => {
  const dir = makeTempDir();
  try {
    const packDir = seedRecoveryPack(dir);
    const receiptDir = path.join(dir, 'receipts');
    const notesPath = path.join(packDir, 'notes.txt');
    let started = false;
    const first = recoveringDeps(receiptDir, (args, options) => {
      assert.equal(hookPre(options.runnerEnv, 'Edit', 'notes.txt', 'call-crash-1'), null);
      applyMarkerEdit(notesPath);
      // No used hook: the crash window between intent and confirmation.
      options.onRunnerExit({ status: 1, signal: null });
    });
    assert.equal(await runPack([packDir], dir, { deps: first.deps }), 0);
    const parent = latestReceipt(receiptDir);
    assert.equal(parent.data.fileEffects.unresolved.length, 1);
    assert.equal(parent.data.fileEffects.unresolved[0].reason, 'missing-post');

    const second = recoveringDeps(receiptDir, () => { started = true; });
    await assert.rejects(
      () => runPack([packDir, '--recover', parent.path], dir, { deps: second.deps }),
      /unresolved file effect.*missing-post/,
    );
    assert.equal(started, false, 'no runner may launch while an effect is unresolved');
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack recover proceeds when a failed action left its never-confirmed target absent', async () => {
  const dir = makeTempDir();
  try {
    const packDir = seedRecoveryPack(dir);
    const receiptDir = path.join(dir, 'receipts');
    const first = recoveringDeps(receiptDir, (args, options) => {
      assert.equal(hookPre(options.runnerEnv, 'Write', 'draft.txt', 'call-fail-1'), null);
      hookFailed(options.runnerEnv, 'Write', 'draft.txt', 'call-fail-1');
      options.onRunnerExit({ status: 1, signal: null });
    });
    assert.equal(await runPack([packDir], dir, { deps: first.deps }), 0);
    const parent = latestReceipt(receiptDir);
    assert.equal(parent.data.fileEffects.failed.length, 1);
    assert.deepEqual(parent.data.fileEffects.unresolved, []);

    const second = recoveringDeps(receiptDir, (args, options) => {
      assert.equal(hookPre(options.runnerEnv, 'Write', 'draft.txt', 'call-retry-1'), null);
      fs.writeFileSync(path.join(packDir, 'draft.txt'), 'second try\n');
      hookUsed(options.runnerEnv, 'Write', 'draft.txt', 'call-retry-1');
      options.onRunnerExit({ status: 0, signal: null });
    });
    assert.equal(await runPack([packDir, '--recover', parent.path], dir, { deps: second.deps }), 0);
    const child = latestReceipt(receiptDir);
    assert.equal(child.data.recovery.mode, 'recovered');
    assert.ok(child.data.recovery.protectedFiles.some((entry) => entry.target === 'draft.txt'));
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack recover refuses when a failed action may have changed an existing file', async () => {
  const dir = makeTempDir();
  try {
    const packDir = seedRecoveryPack(dir);
    const receiptDir = path.join(dir, 'receipts');
    let started = false;
    const first = recoveringDeps(receiptDir, (args, options) => {
      assert.equal(hookPre(options.runnerEnv, 'Edit', 'other.txt', 'call-fail-1'), null);
      hookFailed(options.runnerEnv, 'Edit', 'other.txt', 'call-fail-1');
      options.onRunnerExit({ status: 1, signal: null });
    });
    assert.equal(await runPack([packDir], dir, { deps: first.deps }), 0);
    const parent = latestReceipt(receiptDir);
    const second = recoveringDeps(receiptDir, () => { started = true; });
    await assert.rejects(
      () => runPack([packDir, '--recover', parent.path], dir, { deps: second.deps }),
      /may have changed other\.txt/,
    );
    assert.equal(started, false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack recover refuses active, launcher-lost, and unknown parents', async () => {
  const dir = makeTempDir();
  try {
    const packDir = seedRecoveryPack(dir);
    const receiptDir = path.join(dir, 'receipts');
    let started = false;
    const idle = () => recoveringDeps(receiptDir, () => { started = true; });

    // Still running: the runner never reported an exit.
    assert.equal(await runPack([packDir], dir, { deps: recoveringDeps(receiptDir, () => {}).deps }), 0);
    const running = latestReceipt(receiptDir);
    assert.equal(running.data.status, 'running');
    await assert.rejects(
      () => runPack([packDir, '--recover', running.path], dir, { deps: idle().deps }),
      /no recorded runner exit/,
    );

    // Launcher lost: a dead launcher pid with no exit event proves nothing.
    const policy = resolvePackCapabilityPolicy(['pack.write']);
    const lost = beginPackRunReceipt(packDir, { slug: 'recover-pack', version: '0.1.0' }, policy, {
      receiptDir, launcherPid: 987654321,
    });
    await assert.rejects(
      () => runPack([packDir, '--recover', lost.receiptPath], dir, { deps: idle().deps }),
      /no recorded runner exit/,
    );

    // Unknown recorded state refuses the same way.
    const unknown = JSON.parse(fs.readFileSync(running.path, 'utf8'));
    unknown.status = 'unknown';
    const unknownPath = path.join(receiptDir, 'unknown-state.json');
    fs.writeFileSync(unknownPath, `${JSON.stringify(unknown, null, 2)}\n`);
    await assert.rejects(
      () => runPack([packDir, '--recover', unknownPath], dir, { deps: idle().deps }),
      /no recorded runner exit/,
    );
    assert.equal(started, false, 'no runner may launch for a live or unknown parent');
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack recover rejects success, shell, capability, identity, legacy, corrupt, and remote-shaped requests', async () => {
  const dir = makeTempDir();
  try {
    const packDir = seedRecoveryPack(dir);
    const receiptDir = path.join(dir, 'receipts');
    const notesPath = path.join(packDir, 'notes.txt');
    const manifestPath = path.join(packDir, 'pack.json');
    const manifestBefore = fs.readFileSync(manifestPath, 'utf8');
    const idle = () => {
      let started = false;
      const wrapped = stubDeps({
        packRunReceiptDir: receiptDir,
        nonInteractive: true,
        computerLocal: () => { started = true; },
      });
      return { deps: wrapped.deps, started: () => started };
    };

    let callSeq = 0;
    async function failedParentWithEdit() {
      callSeq += 1;
      callSeq += 1;
      const id = `call-battery-${callSeq}`;
      const first = recoveringDeps(receiptDir, (args, options) => {
        assert.equal(hookPre(options.runnerEnv, 'Edit', 'notes.txt', id), null);
        applyMarkerEdit(notesPath);
        hookUsed(options.runnerEnv, 'Edit', 'notes.txt', id);
        options.onRunnerExit({ status: 1, signal: null });
      });
      // Marker edits apply once per fixture; reset the file for each parent.
      fs.writeFileSync(notesPath, 'base CANARY-RECOVERY-7F2E\nMARKER\n');
      assert.equal(await runPack([packDir], dir, { deps: first.deps }), 0);
      return latestReceipt(receiptDir);
    }

    // Success exit: nothing to recover.
    const succeeded = recoveringDeps(receiptDir, (args, options) => {
      options.onRunnerExit({ status: 0, signal: null });
    });
    assert.equal(await runPack([packDir], dir, { deps: succeeded.deps }), 0);const success = latestReceipt(receiptDir);
    const successIdle = idle();
    await assert.rejects(
      () => runPack([packDir, '--recover', success.path], dir, { deps: successIdle.deps }),
      /succeeded.*nothing to recover/,
    );
    assert.equal(successIdle.started(), false);

    const parent = await failedParentWithEdit();

    // Changed completed file on disk.
    fs.appendFileSync(notesPath, 'tampered\n');
    const tamperedIdle = idle();
    await assert.rejects(
      () => runPack([packDir, '--recover', parent.path], dir, { deps: tamperedIdle.deps }),
      /completed file notes\.txt changed/,
    );
    assert.equal(tamperedIdle.started(), false);
    fs.writeFileSync(notesPath, 'base CANARY-RECOVERY-7F2E\nMARKER\nRECOVERY-LINE-20260904\n');

    // Capability change: manifest narrowed after the parent ran.
    const narrowed = JSON.parse(manifestBefore);
    narrowed.permissions = ['pack.read'];
    fs.writeFileSync(manifestPath, `${JSON.stringify(narrowed, null, 2)}\n`);
    const narrowedIdle = idle();
    await assert.rejects(
      () => runPack([packDir, '--recover', parent.path], dir, { deps: narrowedIdle.deps }),
      /same granted set/,
    );
    assert.equal(narrowedIdle.started(), false);
    fs.writeFileSync(manifestPath, manifestBefore);

    // Host shell granted for this run.
    const shellIdle = idle();
    await assert.rejects(
      () => runPack([packDir, '--recover', parent.path, '--grant', 'host.shell'], dir, { deps: shellIdle.deps }),
      /cannot grant host\.shell/,
    );
    assert.equal(shellIdle.started(), false);

    // Root mismatch: same slug and version in a different folder.
    const sibling = seedRecoveryPack(dir, 'recover-pack-sibling');
    fs.writeFileSync(
      path.join(sibling, 'pack.json'),
      `${JSON.stringify({ slug: 'recover-pack', title: 'Recover Pack', version: '0.1.0', permissions: ['pack.write'] }, null, 2)}\n`
    );
    const siblingIdle = idle();
    await assert.rejects(
      () => runPack([sibling, '--recover', parent.path], dir, { deps: siblingIdle.deps }),
      /different pack, folder, or version/,
    );
    assert.equal(siblingIdle.started(), false);

    // Legacy manifest cannot back recovery.
    const legacyManifest = JSON.parse(manifestBefore);
    delete legacyManifest.permissions;
    fs.writeFileSync(manifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`);
    const legacyIdle = idle();
    await assert.rejects(
      () => runPack([packDir, '--recover', parent.path], dir, { deps: legacyIdle.deps }),
      /legacy packs cannot be recovered/,
    );
    assert.equal(legacyIdle.started(), false);
    fs.writeFileSync(manifestPath, manifestBefore);

    // Corrupt receipt.
    const corruptPath = path.join(receiptDir, 'corrupt.json');
    fs.writeFileSync(corruptPath, '{ broken\n');
    const corruptIdle = idle();
    await assert.rejects(
      () => runPack([packDir, '--recover', corruptPath], dir, { deps: corruptIdle.deps }),
      /corrupt or unreadable/,
    );
    assert.equal(corruptIdle.started(), false);

    // Slug source must not install during recovery.
    const slugIdle = idle();
    await assert.rejects(
      () => runPack(['no-such-pack', '--recover', parent.path], dir, { deps: slugIdle.deps }),
      /existing pack directory/,
    );
    assert.equal(slugIdle.started(), false);

    // Cloud recovery is not supported.
    const cloudIdle = idle();
    await assert.rejects(
      () => runPack([packDir, '--cloud', '--recover', parent.path], dir, { deps: cloudIdle.deps }),
      /local-only/,
    );
    assert.equal(cloudIdle.started(), false);

    // Missing receipt path.
    const missingIdle = idle();
    await assert.rejects(
      () => runPack([packDir, '--recover', path.join(receiptDir, 'nope.json')], dir, { deps: missingIdle.deps }),
      /receipt not found/,
    );
    assert.equal(missingIdle.started(), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack recover refuses a host.shell parent and a run without action identities', async () => {
  const dir = makeTempDir();
  try {
    const packDir = seedRecoveryPack(dir);
    const receiptDir = path.join(dir, 'receipts');
    const idle = () => {
      let started = false;
      const wrapped = stubDeps({
        packRunReceiptDir: receiptDir,
        nonInteractive: true,
        computerLocal: () => { started = true; },
      });
      return { deps: wrapped.deps, started: () => started };
    };

    const shellDir = path.join(dir, 'shell-pack');
    fs.mkdirSync(shellDir, { recursive: true });
    fs.writeFileSync(
      path.join(shellDir, 'pack.json'),
      `${JSON.stringify({ slug: 'shell-pack', title: 'Shell', version: '0.1.0', permissions: ['host.shell'] }, null, 2)}\n`
    );
    const shellFirst = recoveringDeps(receiptDir, (args, options) => {
      options.onRunnerExit({ status: 1, signal: null });
    });
    assert.equal(await runPack([shellDir], dir, { deps: shellFirst.deps }), 0);
    const shellParent = latestReceipt(receiptDir);
    const shellIdle = idle();
    await assert.rejects(
      () => runPack([shellDir, '--recover', shellParent.path], dir, { deps: shellIdle.deps }),
      /host\.shell/,
    );
    assert.equal(shellIdle.started(), false);

    // A run without tool_use_id stays compatible but can never be a parent.
    const packDir2 = seedRecoveryPack(dir, 'recover-pack-noid');
    const noidFirst = recoveringDeps(receiptDir, (args, options) => {
      assert.equal(hookPre(options.runnerEnv, 'Edit', 'notes.txt'), null);
      applyMarkerEdit(path.join(packDir2, 'notes.txt'));
      hookUsed(options.runnerEnv, 'Edit', 'notes.txt');
      options.onRunnerExit({ status: 1, signal: null });
    });
    assert.equal(await runPack([packDir2], dir, { deps: noidFirst.deps }), 0);
    const noid = latestReceipt(receiptDir);
    assert.equal(noid.data.recovery.hasMissingIdentity, true);
    const noidIdle = idle();
    await assert.rejects(
      () => runPack([packDir2, '--recover', noid.path], dir, { deps: noidIdle.deps }),
      /missing.*identit|unresolved file effect/,
    );
    assert.equal(noidIdle.started(), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack recover refuses a journal that escapes the pack root', async () => {
  const dir = makeTempDir();
  try {
    const packDir = seedRecoveryPack(dir);
    const receiptDir = path.join(dir, 'receipts');
    fs.mkdirSync(receiptDir, { recursive: true });
    const policy = resolvePackCapabilityPolicy(['pack.write']);
    const receipt = beginPackRunReceipt(packDir, { slug: 'recover-pack', version: '0.1.0' }, policy, { receiptDir });
    appendReceiptEvent(receipt.eventsPath, {
      event: 'intent', at: new Date().toISOString(), tool: 'Edit', tool_use_id: 'call-evil-1', target: '../evil.md',
    });
    appendReceiptEvent(receipt.eventsPath, { event: 'exit', at: new Date().toISOString(), status: 1, signal: null });
    finalizePackRunReceipt(receipt.receiptPath, receipt.eventsPath);
    let started = false;
    const deps = stubDeps({
      packRunReceiptDir: receiptDir,
      nonInteractive: true,
      computerLocal: () => { started = true; },
    }).deps;
    await assert.rejects(
      () => runPack([packDir, '--recover', receipt.receiptPath], dir, { deps }),
      /outside the pack root|unsafe file target/,
    );
    assert.equal(started, false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('denied pack-root mutations leave no pending intent', async () => {
  const dir = makeTempDir();
  try {
    const packDir = seedRecoveryPack(dir);
    const receiptDir = path.join(dir, 'receipts');
    let denied = null;
    const first = recoveringDeps(receiptDir, (args, options) => {
      denied = hookPre(options.runnerEnv, 'Read', '../outside.md', 'call-deny-1')
        || hookPre(options.runnerEnv, 'Edit', '../outside.md', 'call-deny-2');
      assert.ok(denied && denied.hookSpecificOutput.permissionDecision === 'deny');
      options.onRunnerExit({ status: 1, signal: null });
    });
    assert.equal(await runPack([packDir], dir, { deps: first.deps }), 0);
    const parent = latestReceipt(receiptDir);
    assert.deepEqual(parent.data.deniedUses.map(({ tool }) => tool), ['Read']);
    assert.deepEqual(parent.data.fileEffects.unresolved, []);
    assert.deepEqual(parent.data.fileEffects.confirmed, []);
    assert.equal(parent.data.recovery.hasMissingIdentity, false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack recover protects transitively and claims a parent exactly once', async () => {
  const dir = makeTempDir();
  try {
    const packDir = seedRecoveryPack(dir);
    const receiptDir = path.join(dir, 'receipts');
    const notesPath = path.join(packDir, 'notes.txt');
    const otherPath = path.join(packDir, 'other.txt');

    const first = recoveringDeps(receiptDir, (args, options) => {
      assert.equal(hookPre(options.runnerEnv, 'Edit', 'notes.txt', 'call-t1'), null);
      applyMarkerEdit(notesPath);
      hookUsed(options.runnerEnv, 'Edit', 'notes.txt', 'call-t1');
      options.onRunnerExit({ status: 1, signal: null });
    });
    assert.equal(await runPack([packDir], dir, { deps: first.deps }), 0);
    const parent = latestReceipt(receiptDir);

    const childOne = recoveringDeps(receiptDir, (args, options) => {
      const denied = hookPre(options.runnerEnv, 'Edit', 'notes.txt', 'call-t2');
      assert.ok(denied && denied.hookSpecificOutput.permissionDecision === 'deny');
      assert.equal(hookPre(options.runnerEnv, 'Edit', 'other.txt', 'call-t3'), null);
      fs.appendFileSync(otherPath, 'child one work\n');
      hookUsed(options.runnerEnv, 'Edit', 'other.txt', 'call-t3');
      options.onRunnerExit({ status: 1, signal: null });
    });
    assert.equal(await runPack([packDir, '--recover', parent.path], dir, { deps: childOne.deps }), 0);
    const child = latestReceipt(receiptDir);
    assert.equal(child.data.recovery.parentRunId, parent.data.runId);

    // The parent is consumed: a second recovery from it points at its child.
    let started = false;
    const again = stubDeps({
      packRunReceiptDir: receiptDir,
      nonInteractive: true,
      computerLocal: () => { started = true; },
    }).deps;
    await assert.rejects(
      () => runPack([packDir, '--recover', parent.path], dir, { deps: again }),
      new RegExp(`already recovered as .*${child.data.runId.slice(0, 8)}|already recovered as`),
    );
    assert.equal(started, false);

    // Further recovery comes from the failed child and keeps every protection.
    const childTwo = recoveringDeps(receiptDir, (args, options) => {
      for (const [tool, target, id] of [['Edit', 'notes.txt', 'call-t4'], ['Edit', 'other.txt', 'call-t5']]) {
        const denied = hookPre(options.runnerEnv, tool, target, id);
        assert.ok(denied && denied.hookSpecificOutput.permissionDecision === 'deny', `${target} stays protected`);
      }
      assert.equal(hookPre(options.runnerEnv, 'Write', 'third.txt', 'call-t6'), null);
      fs.writeFileSync(path.join(packDir, 'third.txt'), 'third file\n');
      hookUsed(options.runnerEnv, 'Write', 'third.txt', 'call-t6');
      options.onRunnerExit({ status: 0, signal: null });
    });
    assert.equal(await runPack([packDir, '--recover', child.path], dir, { deps: childTwo.deps }), 0);
    const grandchild = latestReceipt(receiptDir);
    assert.equal(grandchild.data.recovery.parentRunId, child.data.runId);
    assert.deepEqual(
      grandchild.data.recovery.protectedFiles.map((entry) => entry.target).sort(),
      ['notes.txt', 'other.txt', 'third.txt'],
    );
    assert.equal(countLines(notesPath, 'RECOVERY-LINE-20260904'), 1);
    assert.equal(countLines(otherPath, 'child one work'), 1);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack recover refuses a crash-pending claim instead of replaying it', async () => {
  const dir = makeTempDir();
  try {
    const packDir = seedRecoveryPack(dir);
    const receiptDir = path.join(dir, 'receipts');
    const first = recoveringDeps(receiptDir, (args, options) => {
      assert.equal(hookPre(options.runnerEnv, 'Edit', 'notes.txt', 'call-c1'), null);
      applyMarkerEdit(path.join(packDir, 'notes.txt'));
      hookUsed(options.runnerEnv, 'Edit', 'notes.txt', 'call-c1');
      options.onRunnerExit({ status: 1, signal: null });
    });
    assert.equal(await runPack([packDir], dir, { deps: first.deps }), 0);
    const parent = latestReceipt(receiptDir);
    const claimPath = path.join(receiptDir, `${path.basename(parent.path, '.json')}.claim.json`);
    fs.writeFileSync(claimPath, JSON.stringify({
      version: 1,
      parentReceipt: parent.path,
      parentRunId: parent.data.runId,
      claimedAt: new Date().toISOString(),
      childReceipt: null,
    }, null, 2));
    let started = false;
    const deps = stubDeps({
      packRunReceiptDir: receiptDir,
      nonInteractive: true,
      computerLocal: () => { started = true; },
    }).deps;
    await assert.rejects(
      () => runPack([packDir, '--recover', parent.path], dir, { deps }),
      /already in progress.*manual review/,
    );
    assert.equal(started, false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack recover refuses hardlinked completed files and denies inode aliases in the child', async () => {
  const dir = makeTempDir();
  try {
    const packDir = seedRecoveryPack(dir);
    const receiptDir = path.join(dir, 'receipts');
    const notesPath = path.join(packDir, 'notes.txt');
    const first = recoveringDeps(receiptDir, (args, options) => {
      assert.equal(hookPre(options.runnerEnv, 'Edit', 'notes.txt', 'call-h1'), null);
      applyMarkerEdit(notesPath);
      hookUsed(options.runnerEnv, 'Edit', 'notes.txt', 'call-h1');
      options.onRunnerExit({ status: 1, signal: null });
    });
    assert.equal(await runPack([packDir], dir, { deps: first.deps }), 0);
    const parent = latestReceipt(receiptDir);

    const aliasPath = path.join(packDir, 'notes-alias.txt');
    let linked = true;
    try {
      fs.linkSync(notesPath, aliasPath);
    } catch {
      linked = false;
    }
    if (linked) {
      let started = false;
      const deps = stubDeps({
        packRunReceiptDir: receiptDir,
        nonInteractive: true,
        computerLocal: () => { started = true; },
      }).deps;
      await assert.rejects(
        () => runPack([packDir, '--recover', parent.path], dir, { deps }),
        /multiple hard links/,
      );
      assert.equal(started, false);
      fs.unlinkSync(aliasPath);
    }

    // After the link is gone recovery launches; a fresh alias created inside
    // the child still cannot reach the protected bytes by another name.
    const second = recoveringDeps(receiptDir, (args, options) => {
      fs.linkSync(notesPath, aliasPath);
      const denied = hookPre(options.runnerEnv, 'Edit', 'notes-alias.txt', 'call-h2');
      assert.ok(denied && denied.hookSpecificOutput.permissionDecision === 'deny', 'inode alias stays denied');
      assert.equal(hookPre(options.runnerEnv, 'Read', 'notes-alias.txt', 'call-h3'), null, 'reads stay allowed');
      fs.unlinkSync(aliasPath);
      assert.equal(hookPre(options.runnerEnv, 'Edit', 'other.txt', 'call-h4'), null);
      fs.appendFileSync(path.join(packDir, 'other.txt'), 'alias test work\n');
      hookUsed(options.runnerEnv, 'Edit', 'other.txt', 'call-h4');
      options.onRunnerExit({ status: 0, signal: null });
    });
    assert.equal(await runPack([packDir, '--recover', parent.path], dir, { deps: second.deps }), 0);
    const child = latestReceipt(receiptDir);
    assert.equal(child.data.recovery.mode, 'recovered');
    assert.equal(countLines(notesPath, 'RECOVERY-LINE-20260904'), 1);
    const events = readReceiptEvents(receiptDir, child);
    assert.equal(events.split('\n').some((line) => line.includes('"intent"') && line.includes('notes-alias.txt')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack pre-hook subprocess exits 2 when the journal cannot be written', () => {
  const dir = makeTempDir();
  try {
    const packDir = seedRecoveryPack(dir);
    const receiptDir = path.join(dir, 'receipts');
    fs.mkdirSync(receiptDir, { recursive: true });
    const policy = resolvePackCapabilityPolicy(['pack.write']);
    const receipt = beginPackRunReceipt(packDir, { slug: 'recover-pack', version: '0.1.0' }, policy, { receiptDir });
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const result = spawnSync(process.execPath, [path.join(repoRoot, 'lib', 'pack-capabilities.js'), 'pre'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 20000,
      input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'notes.txt' }, tool_use_id: 'call-sub-1' }),
      env: {
        ...process.env,
        ATRIS_PACK_ROOT: packDir,
        ATRIS_PACK_RECEIPT: receipt.receiptPath,
        ATRIS_PACK_RECEIPT_EVENTS: path.join(blocker, 'events.jsonl'),
        ATRIS_PACK_GRANTED_CAPABILITIES: JSON.stringify(['pack.write']),
      },
    });
    assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /capability hook failed/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack run help documents explicit recovery', async () => {
  const { code, output } = await captureConsole(() => runPack(['--help']));
  assert.equal(code, 0);
  assert.match(output, /--recover <receipt\.json>/);
});

test('pack recover trusts journal events over stale summaries', async () => {
  const dir = makeTempDir();
  try {
    const packDir = seedRecoveryPack(dir);
    const receiptDir = path.join(dir, 'receipts');
    const manifest = { slug: 'recover-pack', version: '0.1.0', permissions: ['pack.write'] };
    const policy = resolvePackCapabilityPolicy(manifest.permissions);
    async function failedParent() {
      const first = recoveringDeps(receiptDir, (args, options) => {
        assert.equal(hookPre(options.runnerEnv, 'Edit', 'notes.txt', `call-auth-${Math.random()}`), null);
        applyMarkerEdit(path.join(packDir, 'notes.txt'));
        const env = options.runnerEnv;
        withHookEnv(env, () => {
          const events = fs.readFileSync(env.ATRIS_PACK_RECEIPT_EVENTS, 'utf8').trim().split('\n').map(JSON.parse);
          const intent = events.find((e) => e.event === 'intent');
          fs.appendFileSync(path.join(packDir, 'notes.txt'), '');
          runHook('used', JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'notes.txt' }, tool_use_id: intent.tool_use_id }));
        });
        options.onRunnerExit({ status: 1, signal: null });
      });
      fs.writeFileSync(path.join(packDir, 'notes.txt'), 'base CANARY-RECOVERY-7F2E\nMARKER\n');
      assert.equal(await runPack([packDir], dir, { deps: first.deps }), 0);
      return latestReceipt(receiptDir);
    }
    const parent = await failedParent();
    const idle = () => stubDeps({ packRunReceiptDir: receiptDir, nonInteractive: true, computerLocal: () => {} }).deps;

    const tamperedExit = JSON.parse(fs.readFileSync(parent.path, 'utf8'));
    tamperedExit.status = 'finished';
    tamperedExit.exitStatus = 1;
    const tamperedPath = path.join(receiptDir, 'tampered-exit.json');
    const tamperedEvents = path.join(receiptDir, 'tampered-exit.events.jsonl');
    fs.writeFileSync(tamperedPath, JSON.stringify({ ...tamperedExit, events: path.basename(tamperedEvents) }));
    const parentEvents = fs.readFileSync(path.join(receiptDir, parent.data.events), 'utf8').split('\n').filter(Boolean).filter((l) => !l.includes('"exit"')).join('\n') + '\n';
    fs.writeFileSync(tamperedEvents, parentEvents);
    await assert.rejects(() => runPack([packDir, '--recover', tamperedPath], dir, { deps: idle() }), /no recorded runner exit|terminal exit|conflicts/);

    const shellEvents = fs.readFileSync(path.join(receiptDir, parent.data.events), 'utf8').trim().split('\n').map(JSON.parse);
    shellEvents[0].grantedCapabilities.push('host.shell');
    const shellPath = path.join(receiptDir, 'shell-hide.json');
    const shellEventsPath = path.join(receiptDir, 'shell-hide.events.jsonl');
    fs.writeFileSync(shellEventsPath, shellEvents.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const shellSummary = JSON.parse(fs.readFileSync(parent.path, 'utf8'));
    fs.writeFileSync(shellPath, JSON.stringify({ ...shellSummary, events: path.basename(shellEventsPath) }));
    await assert.rejects(() => runPack([packDir, '--recover', shellPath], dir, { deps: idle() }), /host\.shell|tool ceiling|conflicts/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack recover refuses duplicate, unknown, mismatched, and out-of-order pairings', async () => {
  const dir = makeTempDir();
  try {
    const packDir = seedRecoveryPack(dir);
    const receiptDir = path.join(dir, 'receipts');
    fs.mkdirSync(receiptDir, { recursive: true });
    const policy = resolvePackCapabilityPolicy(['pack.write']);
    const manifest = { slug: 'recover-pack', version: '0.1.0' };
    function journaledParent(mutate) {
      const receipt = beginPackRunReceipt(packDir, manifest, policy, { receiptDir });
      const events = fs.readFileSync(receipt.eventsPath, 'utf8').trim().split('\n').map(JSON.parse);
      const launch = events[0];
      const built = [launch, ...mutate(launch), { event: 'exit', at: new Date().toISOString(), status: 1, signal: null }];
      fs.writeFileSync(receipt.eventsPath, built.map((e) => JSON.stringify(e)).join('\n') + '\n');
      finalizePackRunReceipt(receipt.receiptPath, receipt.eventsPath);
      return receipt;
    }
    const cases = [
      ['duplicate-intent', () => [
        { event: 'intent', at: new Date().toISOString(), tool: 'Write', tool_use_id: 'dup', target: 'a.txt' },
        { event: 'intent', at: new Date().toISOString(), tool: 'Write', tool_use_id: 'dup', target: 'a.txt' },
      ]],
      ['unknown-tool', () => [
        { event: 'intent', at: new Date().toISOString(), tool: 'Writ', tool_use_id: 'u1', target: 'a.txt' },
      ]],
      ['mismatched-tool', () => [
        { event: 'intent', at: new Date().toISOString(), tool: 'Write', tool_use_id: 'm1', target: 'a.txt' },
        { event: 'used', at: new Date().toISOString(), tool: 'Edit', tool_use_id: 'm1', target: 'a.txt', fileSha256: '0'.repeat(64) },
      ]],
      ['out-of-order', () => [
        { event: 'used', at: new Date().toISOString(), tool: 'Write', tool_use_id: 'o1', target: 'a.txt', fileSha256: '0'.repeat(64) },
        { event: 'intent', at: new Date().toISOString(), tool: 'Write', tool_use_id: 'o1', target: 'a.txt' },
      ]],
    ];
    for (const [name, mutate] of cases) {
      const receipt = journaledParent(mutate);
      let started = false;
      const deps = stubDeps({ packRunReceiptDir: receiptDir, nonInteractive: true, computerLocal: () => { started = true; } }).deps;
      await assert.rejects(() => runPack([packDir, '--recover', receipt.receiptPath], dir, { deps }), /unresolved|duplicate|unknown|mismatch|out-of-order|corrupt|manual review/, `${name} must refuse`);
      assert.equal(started, false, `${name} must not launch`);
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack recover keeps journals and claims outside model reach', async () => {
  const dir = makeTempDir();
  try {
    const packDir = seedRecoveryPack(dir);
    const receiptDir = path.join(dir, 'receipts');
    const first = recoveringDeps(receiptDir, (args, options) => {
      assert.equal(hookPre(options.runnerEnv, 'Edit', 'notes.txt', 'call-place-1'), null);
      applyMarkerEdit(path.join(packDir, 'notes.txt'));
      hookUsed(options.runnerEnv, 'Edit', 'notes.txt', 'call-place-1');
      options.onRunnerExit({ status: 1, signal: null });
    });
    assert.equal(await runPack([packDir], dir, { deps: first.deps }), 0);
    const parent = latestReceipt(receiptDir);
    const idle = () => stubDeps({ packRunReceiptDir: receiptDir, nonInteractive: true, computerLocal: () => {} }).deps;

    const insideDir = path.join(packDir, 'receipts');
    fs.mkdirSync(insideDir, { recursive: true });
    const insideReceipt = beginPackRunReceipt(packDir, { slug: 'recover-pack', version: '0.1.0' }, resolvePackCapabilityPolicy(['pack.write']), { receiptDir: insideDir });
    appendReceiptEvent(insideReceipt.eventsPath, { event: 'exit', at: new Date().toISOString(), status: 1, signal: null });
    finalizePackRunReceipt(insideReceipt.receiptPath, insideReceipt.eventsPath);
    await assert.rejects(() => runPack([packDir, '--recover', insideReceipt.receiptPath], dir, { deps: idle() }), /outside the pack root/);

    const childInside = stubDeps({ packRunReceiptDir: insideDir, nonInteractive: true, computerLocal: () => {} }).deps;
    await assert.rejects(() => runPack([packDir, '--recover', parent.path], dir, { deps: childInside }), /outside the pack root/);

    const withEnv = (env, fn) => withHookEnv(env, fn);
    const child = recoveringDeps(receiptDir, (args, options) => {
      const deniedJournal = withEnv(options.runnerEnv, () => runHook('pre', JSON.stringify({ tool_name: 'Write', tool_input: { file_path: options.runnerEnv.ATRIS_PACK_RECEIPT_EVENTS, content: 'tamper' }, tool_use_id: 'tamper-1' })));
      assert.ok(deniedJournal && deniedJournal.hookSpecificOutput.permissionDecision === 'deny', 'journal writes stay denied');
      const malformed = { ...options.runnerEnv, ATRIS_PACK_PROTECTED_FILES: '{' };
      const deniedMalformed = withEnv(malformed, () => runHook('pre', JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'other.txt' }, tool_use_id: 'mal-1' })));
      assert.ok(!deniedMalformed || deniedMalformed.hookSpecificOutput.permissionDecision === 'deny' || deniedMalformed === null, 'malformed protection fails closed or denies protected only');
      const protectedDenied = withEnv({ ...options.runnerEnv, ATRIS_PACK_PROTECTED_FILES: '{' }, () => runHook('pre', JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'notes.txt' }, tool_use_id: 'mal-2' })));
      assert.ok(protectedDenied && protectedDenied.hookSpecificOutput.permissionDecision === 'deny', 'malformed env still denies protected files');
      assert.equal(withEnv(options.runnerEnv, () => runHook('pre', JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'other.txt' }, tool_use_id: 'place-other-1' }))), null);
      fs.appendFileSync(path.join(packDir, 'other.txt'), 'placement work\n');
      withEnv(options.runnerEnv, () => runHook('used', JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'other.txt' }, tool_use_id: 'place-other-1' })));
      options.onRunnerExit({ status: 0, signal: null });
    });
    assert.equal(await runPack([packDir, '--recover', parent.path], dir, { deps: child.deps }), 0);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack recover survives real process exit, rejects empty flag, and guides manual review', async () => {
  const dir = makeTempDir();
  try {
    const packDir = seedRecoveryPack(dir);
    const receiptDir = path.join(dir, 'receipts');
    const first = recoveringDeps(receiptDir, (args, options) => {
      assert.equal(hookPre(options.runnerEnv, 'Edit', 'notes.txt', 'call-exit-1'), null);
      applyMarkerEdit(path.join(packDir, 'notes.txt'));
      hookUsed(options.runnerEnv, 'Edit', 'notes.txt', 'call-exit-1');
      options.onRunnerExit({ status: 1, signal: null });
    });
    assert.equal(await runPack([packDir], dir, { deps: first.deps }), 0);
    const parent = latestReceipt(receiptDir);

    const childSource = `const {runPack}=require(${JSON.stringify(path.join(repoRoot, 'commands/pack.js'))});runPack([${JSON.stringify(packDir)},'--recover',${JSON.stringify(parent.path)}],${JSON.stringify(dir)},{deps:{readUserDenyRules:()=>[],nonInteractive:true,packRunReceiptDir:${JSON.stringify(receiptDir)},computerLocal:(a,o)=>{o.onRunnerExit({status:1,signal:null});process.exit(1);}}}).catch(e=>{console.error(e.message);process.exit(2);});`;
    const child = spawnSync(process.execPath, ['-e', childSource], { encoding: 'utf8' });
    assert.equal(child.status, 1, `exiting runner must exit 1: ${child.stdout}${child.stderr}`);
    const claim = JSON.parse(fs.readFileSync(packRecoveryClaimPath(parent.path), 'utf8'));
    assert.ok(claim.childReceipt && claim.childReceipt.endsWith('.json'), 'claim names the real child before exit');
    const childReceipt = JSON.parse(fs.readFileSync(claim.childReceipt, 'utf8'));
    assert.equal(childReceipt.recovery.parentRunId, parent.data.runId);
    assert.ok(childReceipt.recovery.protectedFiles.some((e) => e.target === 'notes.txt'), 'child retains inherited protection');

    await assert.rejects(() => runPack([packDir, '--recover=', parent.path], dir, { deps: stubDeps({ packRunReceiptDir: receiptDir }).deps }), /needs a receipt path/);
    await assert.rejects(() => runPack([packDir, '--recover', ''], dir, { deps: stubDeps({ packRunReceiptDir: receiptDir }).deps }), /needs a receipt path/);

    const errors = [];
    try { assessPackRecoveryJournal({ packDir, manifest: { slug: 'recover-pack', version: '0.1.0' }, policy: resolvePackCapabilityPolicy(['pack.write']), parentReceiptPath: parent.path, operatorInput: { bytes: 1, sha256: 'x' } }); } catch (e) { errors.push(e.message); }
    const runningReceipt = beginPackRunReceipt(packDir, { slug: 'recover-pack', version: '0.1.0' }, resolvePackCapabilityPolicy(['pack.write']), { receiptDir });
    try {
      assessPackRecoveryJournal({ packDir, manifest: { slug: 'recover-pack', version: '0.1.0' }, policy: resolvePackCapabilityPolicy(['pack.write']), parentReceiptPath: runningReceipt.receiptPath });
    } catch (e) { errors.push(e.message); }
    for (const message of errors) assert.doesNotMatch(message, /rerun the pack fresh/);
    assert.ok(errors.some((m) => /manual review|inspect the prior run/.test(m)), 'guidance points at manual review');
    assert.equal(childReceipt.observability.fileEffectIdentitiesLogged, true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack recover refuses malformed or missing inherited protection, including transitively', async () => {
  const dir = makeTempDir();
  try {
    const packDir = seedRecoveryPack(dir);
    const receiptDir = path.join(dir, 'receipts');
    const manifest = { slug: 'recover-pack', version: '0.1.0' };
    const policy = resolvePackCapabilityPolicy(['pack.write']);
    const notesPath = path.join(packDir, 'notes.txt');
    const otherPath = path.join(packDir, 'other.txt');

    const first = recoveringDeps(receiptDir, (args, options) => {
      assert.equal(hookPre(options.runnerEnv, 'Edit', 'notes.txt', 'call-inherit-1'), null);
      applyMarkerEdit(notesPath);
      hookUsed(options.runnerEnv, 'Edit', 'notes.txt', 'call-inherit-1');
      options.onRunnerExit({ status: 1, signal: null });
    });
    assert.equal(await runPack([packDir], dir, { deps: first.deps }), 0);
    const parent = latestReceipt(receiptDir);

    // Transitive chain: the child is itself a recovered run carrying
    // inherited protection for notes.txt.
    const second = recoveringDeps(receiptDir, (args, options) => {
      assert.equal(hookPre(options.runnerEnv, 'Edit', 'other.txt', 'call-inherit-2'), null);
      fs.appendFileSync(otherPath, 'inherited chain work\n');
      hookUsed(options.runnerEnv, 'Edit', 'other.txt', 'call-inherit-2');
      options.onRunnerExit({ status: 1, signal: null });
    });
    assert.equal(await runPack([packDir, '--recover', parent.path], dir, { deps: second.deps }), 0);
    const child = latestReceipt(receiptDir);
    assert.equal(child.data.recovery.mode, 'recovered');
    assert.ok(child.data.recovery.protectedFiles.some((entry) => entry.target === 'notes.txt'));

    const childEventsPath = path.join(receiptDir, child.data.events);
    const original = fs.readFileSync(childEventsPath, 'utf8');
    const idle = () => {
      let started = false;
      const wrapped = stubDeps({
        packRunReceiptDir: receiptDir,
        nonInteractive: true,
        computerLocal: () => { started = true; },
      });
      return { deps: wrapped.deps, started: () => started };
    };
    async function refusesAfterDamage(label, mutateLaunch, pattern) {
      const events = original.trim().split('\n').map(JSON.parse);
      const damaged = events.map((event) => (event.event === 'launch' ? mutateLaunch(event) : event));
      fs.writeFileSync(childEventsPath, damaged.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
      try {
        const attempt = idle();
        await assert.rejects(
          () => runPack([packDir, '--recover', child.path], dir, { deps: attempt.deps }),
          pattern,
          `${label} must refuse`,
        );
        assert.equal(attempt.started(), false, `${label} must not launch`);
      } finally {
        fs.writeFileSync(childEventsPath, original);
      }
    }

    await refusesAfterDamage(
      'malformed inherited protection',
      (launch) => ({ ...launch, recovery: { ...launch.recovery, protectedFiles: {} } }),
      /malformed recovered protection|corrupt/,
    );
    await refusesAfterDamage(
      'missing recovered protection',
      (launch) => ({ ...launch, recovery: { mode: 'recovered', parentRunId: launch.recovery.parentRunId, parentReceipt: launch.recovery.parentReceipt } }),
      /malformed recovered protection|malformed recovered parent identity|corrupt/,
    );
    await refusesAfterDamage(
      'malformed inherited entry',
      (launch) => ({
        ...launch,
        recovery: { ...launch.recovery, protectedFiles: [{ target: 'notes.txt', sha256: 'not-a-hash' }] },
      }),
      /malformed protected entry|corrupt/,
    );
    await refusesAfterDamage(
      'missing recovered parent identity',
      (launch) => ({ ...launch, recovery: { ...launch.recovery, parentRunId: null } }),
      /malformed recovered parent identity|corrupt/,
    );

    // A stale summary claiming fresh while the journal is recovered refuses
    // on recovery-identity conflict (events copied alongside so the journal
    // binding itself stays valid).
    const summary = JSON.parse(fs.readFileSync(child.path, 'utf8'));
    const stalePath = path.join(receiptDir, 'stale-recovery-identity.json');
    fs.copyFileSync(childEventsPath, path.join(receiptDir, 'stale-recovery-identity.events.jsonl'));
    fs.writeFileSync(stalePath, JSON.stringify({ ...summary, events: 'stale-recovery-identity.events.jsonl', recovery: { mode: 'fresh', protectedFiles: [], journalVersion: 1, hasMissingIdentity: false } }));
    const stale = idle();
    await assert.rejects(
      () => runPack([packDir, '--recover', stalePath], dir, { deps: stale.deps }),
      /recovery identity/,
    );
    assert.equal(stale.started(), false);

    // Damaged history never reaches the runner, so the completed file cannot
    // be permitted again through the real pre-hook.
    const damagedEvents = original.trim().split('\n').map(JSON.parse)
      .map((event) => (event.event === 'launch'
        ? { ...event, recovery: { ...event.recovery, protectedFiles: {} } }
        : event));
    fs.writeFileSync(childEventsPath, damagedEvents.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    try {
      const bypass = idle();
      await assert.rejects(
        () => runPack([packDir, '--recover', child.path], dir, { deps: bypass.deps }),
        /malformed recovered protection|corrupt/,
      );
      assert.equal(bypass.started(), false, 'damaged history must not launch to re-permit completed work');
    } finally {
      fs.writeFileSync(childEventsPath, original);
    }

    // Restored history still recovers: the damage was the journal edit, not
    // the underlying completed work.
    const healthy = recoveringDeps(receiptDir, (args, options) => {
      const denied = hookPre(options.runnerEnv, 'Write', 'notes.txt', 'call-inherit-3');
      assert.ok(denied && denied.hookSpecificOutput.permissionDecision === 'deny', 'inherited completed file stays denied');
      options.onRunnerExit({ status: 0, signal: null });
    });
    assert.equal(await runPack([packDir, '--recover', child.path], dir, { deps: healthy.deps }), 0);
    assert.equal(countLines(notesPath, 'RECOVERY-LINE-20260904'), 1);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack recover validates the recorded tool ceiling exactly', async () => {
  const dir = makeTempDir();
  try {
    const packDir = seedRecoveryPack(dir);
    const receiptDir = path.join(dir, 'receipts');
    const manifest = { slug: 'recover-pack', version: '0.1.0' };
    const policy = resolvePackCapabilityPolicy(['pack.write']);

    const first = recoveringDeps(receiptDir, (args, options) => {
      assert.equal(hookPre(options.runnerEnv, 'Edit', 'notes.txt', 'call-ceiling-1'), null);
      applyMarkerEdit(path.join(packDir, 'notes.txt'));
      hookUsed(options.runnerEnv, 'Edit', 'notes.txt', 'call-ceiling-1');
      options.onRunnerExit({ status: 1, signal: null });
    });
    assert.equal(await runPack([packDir], dir, { deps: first.deps }), 0);
    const parent = latestReceipt(receiptDir);
    assert.deepEqual(
      assessPackRecoveryJournal({ packDir, manifest, policy, parentReceiptPath: parent.path }).protectedFiles.map((entry) => entry.target),
      ['notes.txt'],
    );

    const eventsPath = path.join(receiptDir, parent.data.events);
    const original = fs.readFileSync(eventsPath, 'utf8');
    const idle = () => {
      let started = false;
      const wrapped = stubDeps({
        packRunReceiptDir: receiptDir,
        nonInteractive: true,
        computerLocal: () => { started = true; },
      });
      return { deps: wrapped.deps, started: () => started };
    };
    async function refusesAfterDamage(label, mutateLaunch, pattern) {
      const events = original.trim().split('\n').map(JSON.parse);
      const damaged = events.map((event) => (event.event === 'launch' ? mutateLaunch(event) : event));
      fs.writeFileSync(eventsPath, damaged.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
      try {
        const attempt = idle();
        await assert.rejects(
          () => runPack([packDir, '--recover', parent.path], dir, { deps: attempt.deps }),
          pattern,
          `${label} must refuse`,
        );
        assert.equal(attempt.started(), false, `${label} must not launch`);
      } finally {
        fs.writeFileSync(eventsPath, original);
      }
    }

    const genuineTools = ['Read', 'Glob', 'Grep', 'Skill', 'Edit', 'Write'];
    await refusesAfterDamage(
      'extra shell tool',
      (launch) => ({ ...launch, grantedTools: [...launch.grantedTools, 'Bash'] }),
      /tool ceiling/,
    );
    await refusesAfterDamage(
      'duplicate tool',
      (launch) => ({ ...launch, grantedTools: [...launch.grantedTools, 'Read'] }),
      /tool ceiling/,
    );
    await refusesAfterDamage(
      'unknown tool',
      (launch) => ({ ...launch, grantedTools: [...launch.grantedTools.slice(0, -1), 'Frobnicate'] }),
      /tool ceiling/,
    );
    await refusesAfterDamage(
      'reordered tools',
      (launch) => ({ ...launch, grantedTools: [...genuineTools].reverse() }),
      /tool ceiling/,
    );
    await refusesAfterDamage(
      'unknown requested capability',
      (launch) => ({ ...launch, requestedCapabilities: [...launch.requestedCapabilities, 'database.admin'] }),
      /capability/,
    );
    await refusesAfterDamage(
      'requested outside granted set',
      (launch) => ({ ...launch, requestedCapabilities: [...launch.requestedCapabilities, 'web.read'] }),
      /outside granted set|tool ceiling|capability/,
    );

    // Conflicting stable summary evidence refuses even with a valid journal
    // (events copied alongside so the journal binding itself stays valid).
    const summary = JSON.parse(fs.readFileSync(parent.path, 'utf8'));
    const conflictPath = path.join(receiptDir, 'conflict-tool-ceiling.json');
    fs.copyFileSync(eventsPath, path.join(receiptDir, 'conflict-tool-ceiling.events.jsonl'));
    fs.writeFileSync(conflictPath, JSON.stringify({ ...summary, events: 'conflict-tool-ceiling.events.jsonl', grantedTools: genuineTools.slice(0, -1) }));
    const conflict = idle();
    await assert.rejects(
      () => runPack([packDir, '--recover', conflictPath], dir, { deps: conflict.deps }),
      /tool ceiling/,
    );
    assert.equal(conflict.started(), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack recover refuses emptied inherited protection but allows genuinely empty agreement', async () => {
  const dir = makeTempDir();
  try {
    const packDir = seedRecoveryPack(dir);
    const receiptDir = path.join(dir, 'receipts');
    const manifest = { slug: 'recover-pack', version: '0.1.0' };
    const policy = resolvePackCapabilityPolicy(['pack.write']);
    const notesPath = path.join(packDir, 'notes.txt');
    const idle = () => {
      let started = false;
      const wrapped = stubDeps({
        packRunReceiptDir: receiptDir,
        nonInteractive: true,
        computerLocal: () => { started = true; },
      });
      return { deps: wrapped.deps, started: () => started };
    };

    // Transitive chain with a genuinely completed inherited file: the child
    // itself records no edits, so its only protection is inherited.
    const first = recoveringDeps(receiptDir, (args, options) => {
      assert.equal(hookPre(options.runnerEnv, 'Edit', 'notes.txt', 'call-empty-1'), null);
      applyMarkerEdit(notesPath);
      hookUsed(options.runnerEnv, 'Edit', 'notes.txt', 'call-empty-1');
      options.onRunnerExit({ status: 1, signal: null });
    });
    assert.equal(await runPack([packDir], dir, { deps: first.deps }), 0);
    const parent = latestReceipt(receiptDir);
    const second = recoveringDeps(receiptDir, (args, options) => {
      options.onRunnerExit({ status: 1, signal: null });
    });
    assert.equal(await runPack([packDir, '--recover', parent.path], dir, { deps: second.deps }), 0);
    const child = latestReceipt(receiptDir);
    assert.equal(child.data.recovery.mode, 'recovered');
    assert.deepEqual(child.data.recovery.protectedFiles.map((entry) => entry.target), ['notes.txt']);

    // Baseline agreement between stable summary and journal accepts.
    assert.deepEqual(
      assessPackRecoveryJournal({ packDir, manifest, policy, parentReceiptPath: child.path }).protectedFiles.map((entry) => entry.target),
      ['notes.txt'],
    );

    // Emptying only the launch side while the stable summary still records
    // the completed file must refuse, never silently drop protection.
    const childEventsPath = path.join(receiptDir, child.data.events);
    const original = fs.readFileSync(childEventsPath, 'utf8');
    const emptied = original.trim().split('\n').map(JSON.parse)
      .map((event) => (event.event === 'launch' ? { ...event, recovery: { ...event.recovery, protectedFiles: [] } } : event));
    fs.writeFileSync(childEventsPath, emptied.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    try {
      const attempt = idle();
      await assert.rejects(
        () => runPack([packDir, '--recover', child.path], dir, { deps: attempt.deps }),
        /summary protection conflicts/,
        'emptied inherited protection must refuse',
      );
      assert.equal(attempt.started(), false, 'emptied history must not launch');
    } finally {
      fs.writeFileSync(childEventsPath, original);
    }

    // Genuinely empty recovered protection stays allowed when both records
    // agree: a no-op parent fails with no file effects, and its no-op child
    // carries an honestly empty protection set on both sides.
    const noopParent = recoveringDeps(receiptDir, (args, options) => {
      options.onRunnerExit({ status: 1, signal: null });
    });
    assert.equal(await runPack([packDir], dir, { deps: noopParent.deps }), 0);
    const parent2 = latestReceipt(receiptDir);
    assert.deepEqual(parent2.data.fileEffects.confirmed, []);
    const noopChild = recoveringDeps(receiptDir, (args, options) => {
      options.onRunnerExit({ status: 1, signal: null });
    });
    assert.equal(await runPack([packDir, '--recover', parent2.path], dir, { deps: noopChild.deps }), 0);
    const child2 = latestReceipt(receiptDir);
    assert.deepEqual(child2.data.recovery.protectedFiles, []);
    assert.deepEqual(
      assessPackRecoveryJournal({ packDir, manifest, policy, parentReceiptPath: child2.path }).protectedFiles,
      [],
    );

    const metaSummary = JSON.parse(fs.readFileSync(child.path, 'utf8'));
    delete metaSummary.recovery;
    const metaPath = path.join(receiptDir, 'missing-recovery-meta.json');
    // Copied last so the extra receipt file cannot disturb the lookups above.
    fs.copyFileSync(childEventsPath, path.join(receiptDir, 'missing-recovery-meta.events.jsonl'));
    fs.writeFileSync(metaPath, JSON.stringify({ ...metaSummary, events: 'missing-recovery-meta.events.jsonl' }));
    const meta = idle();
    await assert.rejects(
      () => runPack([packDir, '--recover', metaPath], dir, { deps: meta.deps }),
      /missing stable recovery metadata/,
    );
    assert.equal(meta.started(), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack recover refuses lost file events or contradictory saved effect views before launch', async () => {
  const dir = makeTempDir();
  try {
    const packDir = seedRecoveryPack(dir);
    const receiptDir = path.join(dir, 'receipts');
    const first = recoveringDeps(receiptDir, (args, options) => {
      assert.equal(hookPre(options.runnerEnv, 'Edit', 'notes.txt', 'saved-completion'), null);
      applyMarkerEdit(path.join(packDir, 'notes.txt'));
      hookUsed(options.runnerEnv, 'Edit', 'notes.txt', 'saved-completion');
      options.onRunnerExit({ status: 1, signal: null });
    });
    await runPack([packDir], dir, { deps: first.deps });
    const parent = latestReceipt(receiptDir);
    const eventsPath = path.join(receiptDir, parent.data.events);
    const originalEvents = fs.readFileSync(eventsPath, 'utf8');
    const originalSummary = fs.readFileSync(parent.path, 'utf8');
    const events = originalEvents.trim().split('\n').map(JSON.parse);
    const withoutEffects = events.filter((event) => !['intent', 'used'].includes(event.event));
    const emptyEffects = { confirmed: [], unresolved: [], failed: [] };
    const cases = [
      { name: 'lost completed events', events: withoutEffects, summary: parent.data },
      { name: 'lost events and cleared effect summary', events: withoutEffects,
        summary: { ...parent.data, fileEffects: emptyEffects } },
      { name: 'cleared protected identities', events,
        summary: { ...parent.data, recovery: { ...parent.data.recovery, protectedFiles: [] } } },
      { name: 'lost pending intent', events: withoutEffects,
        summary: { ...parent.data, fileEffects: { ...emptyEffects,
          unresolved: [{ tool: 'Write', target: 'pending.txt', tool_use_id: 'pending', reason: 'missing-post' }] },
        recovery: { ...parent.data.recovery, protectedFiles: [] } } },
    ];
    try {
      for (const item of cases) {
        fs.writeFileSync(eventsPath, item.events.map(JSON.stringify).join('\n') + '\n');
        fs.writeFileSync(parent.path, JSON.stringify(item.summary));
        let started = false;
        const attempt = stubDeps({ packRunReceiptDir: receiptDir,
          computerLocal: () => { started = true; } });
        await assert.rejects(
          () => runPack([packDir, '--recover', parent.path], dir, { deps: attempt.deps }),
          /summary.*conflict/, item.name,
        );
        assert.equal(started, false, item.name);
        assert.equal(fs.existsSync(packRecoveryClaimPath(parent.path)), false, item.name);
      }
    } finally {
      fs.writeFileSync(eventsPath, originalEvents);
      fs.writeFileSync(parent.path, originalSummary);
    }
    assert.deepEqual(assessPackRecoveryJournal({ packDir,
      manifest: { slug: 'recover-pack', version: '0.1.0' },
      policy: resolvePackCapabilityPolicy(['pack.write']), parentReceiptPath: parent.path,
    }).protectedFiles.map((entry) => entry.target), ['notes.txt']);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack recover refuses recorded tool effects outside the granted ceiling', async () => {
  const dir = makeTempDir();
  try {
    const packDir = seedRecoveryPack(dir);
    const receiptDir = path.join(dir, 'receipts');
    for (const record of [
      { event: 'used', tool: 'Bash', capability: 'host.shell' },
      { event: 'failed', tool: 'Bash', capability: 'host.shell' },
      { event: 'used', tool: 'WebFetch', capability: 'web.read' },
      { event: 'used', tool: 'Read', capability: 'host.shell' },
    ]) {
      const receipt = beginPackRunReceipt(packDir, { slug: 'recover-pack', version: '0.1.0' },
        resolvePackCapabilityPolicy(['pack.write']), { receiptDir });
      appendReceiptEvent(receipt.eventsPath, record);
      appendReceiptEvent(receipt.eventsPath, { event: 'exit', status: 1, signal: null });
      // A consistent summary must not make an impossible event history valid.
      finalizePackRunReceipt(receipt.receiptPath, receipt.eventsPath);
      let started = false;
      const attempt = stubDeps({ packRunReceiptDir: receiptDir,
        computerLocal: () => { started = true; } });
      await assert.rejects(
        () => runPack([packDir, '--recover', receipt.receiptPath], dir, { deps: attempt.deps }),
        /tool ceiling mismatch/,
      );
      assert.equal(started, false);
      assert.equal(fs.existsSync(packRecoveryClaimPath(receipt.receiptPath)), false);
    }
  } finally {
    cleanupTempDir(dir);
  }
});
