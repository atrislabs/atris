const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { getLogPath, ensureLogDirectory, createLogFile, addInboxIdea } = require('../lib/file-ops');

function logAtris() {
  const targetDir = path.join(process.cwd(), 'atris');

  if (!fs.existsSync(targetDir)) {
    console.error('✗ Error: atris/ folder not found. Run "atris init" first.');
    process.exit(1);
  }

  ensureLogDirectory();
  const { logFile, dateFormatted } = getLogPath();

  if (!fs.existsSync(logFile)) {
    createLogFile(logFile, dateFormatted);
  }

  console.log(`┌─────────────────────────────────────────────────────────┐`);
  console.log(`│ Daily Log — ${dateFormatted}              [type "exit" to quit] │`);
  console.log(`└─────────────────────────────────────────────────────────┘`);
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> '
  });

  rl.prompt();

  rl.on('line', (line) => {
    const input = line.trim();

    if (input.toLowerCase() === 'exit') {
      console.log('\n✓ Log saved');
      rl.close();
      process.exit(0);
    }

    if (input) {
      addInboxIdea(logFile, input);
    }

    rl.prompt();
  });

  rl.on('close', () => {
    process.exit(0);
  });
}

function localDateString(now = new Date()) {
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function digestDate(args) {
  const equalsArg = args.find((arg) => String(arg).startsWith('--date='));
  const dateIndex = args.indexOf('--date');
  const date = equalsArg
    ? equalsArg.slice('--date='.length)
    : dateIndex >= 0
      ? args[dateIndex + 1]
      : localDateString();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    throw new Error('Usage: atris logs [today] [--date YYYY-MM-DD] [--json]');
  }
  return date;
}

function readDigestSection(root, title, relativePath, maxLines = null) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) return null;

  const content = fs.readFileSync(absolutePath, 'utf8');
  const lines = content.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();

  if (maxLines !== null && lines.length > maxLines) {
    return {
      title,
      path: relativePath.split(path.sep).join('/'),
      lines: [...lines.slice(0, maxLines), `truncated after ${maxLines} lines`],
    };
  }

  return {
    title,
    path: relativePath.split(path.sep).join('/'),
    lines,
  };
}

function logsDigest(args = [], options = {}) {
  const root = options.cwd || process.cwd();
  const date = digestDate(args);
  const sections = [];
  const workspacePath = path.join('atris', 'logs', date.slice(0, 4), `${date}.md`);
  const workspaceSection = readDigestSection(root, 'Workspace journal', workspacePath);
  if (workspaceSection) sections.push(workspaceSection);

  const teamRoot = path.join(root, 'atris', 'team');
  if (fs.existsSync(teamRoot) && fs.statSync(teamRoot).isDirectory()) {
    const members = fs.readdirSync(teamRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));

    for (const member of members) {
      const relativePath = path.join('atris', 'team', member, 'logs', `${date}.md`);
      const section = readDigestSection(root, `Team: ${member}`, relativePath, 80);
      if (section) sections.push(section);
    }
  }

  const payload = { date, sections };
  if (args.includes('--json')) {
    console.log(JSON.stringify(payload, null, 2));
  } else if (sections.length === 0) {
    console.log(`No logs for ${date} yet.`);
  } else {
    console.log(sections.map((section) => [
      `=== ${section.title} ===`,
      section.path,
      ...section.lines,
    ].join('\n')).join('\n\n'));
  }

  return payload;
}

module.exports = { logAtris, logsDigest };
