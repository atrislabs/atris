const { spawnSync } = require('node:child_process');

function hasHelp(args = []) {
  return args.includes('--help') || args.includes('-h') || args[0] === 'help';
}

function firstLine(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || 'unknown';
}

function formatCommand(parts = []) {
  return parts.join(' ').trim();
}

function runCaptured(binary, args = []) {
  return spawnSync(binary, args, {
    encoding: 'utf8',
    env: process.env,
  });
}

function missingBinary(result) {
  return result && result.error && result.error.code === 'ENOENT';
}

function printMissingBinary(config) {
  console.error(`${config.name} cli not found.`);
  console.error(`install: ${config.installHint}`);
}

function ensureBinary(config) {
  const result = runCaptured(config.binary, config.versionArgs || ['--version']);
  if (missingBinary(result)) {
    printMissingBinary(config);
    return { ok: false, result };
  }
  if (result.error) {
    console.error(`${config.name} cli check failed: ${result.error.message}`);
    return { ok: false, result };
  }
  return { ok: true, result };
}

function runAuthCheck(config) {
  if (!config.authArgs || config.authArgs.length === 0) {
    return { ok: true, skipped: true };
  }
  const result = runCaptured(config.binary, config.authArgs);
  if (missingBinary(result)) {
    printMissingBinary(config);
    return { ok: false, result };
  }
  if (result.error) {
    console.error(`${config.name} auth check failed: ${result.error.message}`);
    return { ok: false, result };
  }
  return { ok: result.status === 0, result };
}

function printHelp(config) {
  console.log('');
  console.log(`usage: atris ${config.name} <command> [args]`);
  console.log('');
  console.log('commands:');
  console.log('  doctor        detect the cli binary and auth state');
  console.log('  auth          check auth state');
  for (const command of config.commands) {
    console.log(`  ${command.usage.padEnd(13)} ${command.description}`);
  }
  console.log('');
  console.log(`binary: ${config.binary}`);
  console.log(`install: ${config.installHint}`);
  console.log('');
}

function printDoctor(config) {
  const binary = ensureBinary(config);
  if (!binary.ok) return 1;

  console.log(`${config.name} integration`);
  console.log(`binary: found ${config.binary}`);
  console.log(`version: ${firstLine(binary.result.stdout || binary.result.stderr).toLowerCase()}`);

  const auth = runAuthCheck(config);
  if (auth.skipped) {
    console.log('auth: not checked');
    return 0;
  }
  if (auth.ok) {
    console.log('auth: ok');
    return 0;
  }
  console.error('auth: failed');
  console.error(`login: ${config.loginHint}`);
  return 1;
}

function printAuth(config) {
  const binary = ensureBinary(config);
  if (!binary.ok) return 1;
  const auth = runAuthCheck(config);
  if (auth.skipped || auth.ok) {
    console.log('auth: ok');
    return 0;
  }
  console.error('auth: failed');
  console.error(`login: ${config.loginHint}`);
  return 1;
}

function matchCommand(config, args) {
  return config.commands.find((command) => {
    if (args.length < command.match.length) return false;
    return command.match.every((part, index) => args[index] === part);
  });
}

function runPassthrough(config, command, args) {
  const binary = ensureBinary(config);
  if (!binary.ok) return 1;

  const rest = args.slice(command.match.length);
  const cliArgs = [...command.forward, ...rest];
  const result = spawnSync(config.binary, cliArgs, {
    stdio: 'inherit',
    env: process.env,
  });
  if (missingBinary(result)) {
    printMissingBinary(config);
    return 1;
  }
  if (result.error) {
    console.error(`${config.name} command failed: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 0;
}

function createOfficialCliCommand(config) {
  return function officialCliCommand(args = []) {
    const normalizedArgs = Array.isArray(args) ? args : Array.from(arguments);
    if (normalizedArgs.length === 0 || hasHelp(normalizedArgs)) {
      printHelp(config);
      return 0;
    }

    const subcommand = normalizedArgs[0];
    if (subcommand === 'doctor' || subcommand === 'status') {
      return printDoctor(config);
    }
    if (subcommand === 'auth') {
      return printAuth(config);
    }

    const command = matchCommand(config, normalizedArgs);
    if (!command) {
      console.error(`unknown ${config.name} command: ${formatCommand(normalizedArgs)}`);
      console.error(`run: atris ${config.name} --help`);
      return 1;
    }

    return runPassthrough(config, command, normalizedArgs);
  };
}

module.exports = {
  createOfficialCliCommand,
  ensureBinary,
  hasHelp,
  matchCommand,
  printHelp,
  runAuthCheck,
};
