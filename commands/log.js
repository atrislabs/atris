const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { getLogPath, ensureLogDirectory, createLogFile, addInboxIdea } = require('../lib/file-ops');
const { isFreshWorkspace, speakFirstMinute } = require('../lib/first-minute');
const { isForcedNonInteractive } = require('../lib/noninteractive');

function readPipedStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function journalRel(logFile) {
  return (path.relative(process.cwd(), logFile) || logFile).split(path.sep).join('/');
}

function printLogJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

function printReplNeeded(asJson, dateFormatted, rel) {
  const error = `Daily log REPL needs a terminal (${dateFormatted}).`;
  if (asJson) {
    printLogJson({
      ok: false,
      error,
      journal: rel,
      next_command: 'atris log "note"',
    });
    return;
  }
  console.log(error);
  console.log(`journal: ${rel}`);
  console.log('Next: atris log --repl   # in a terminal, or atris log "note" / atris wish --json --no-mission');
}

function captureNotes(logFile, notes) {
  return notes.map((note) => addInboxIdea(logFile, note));
}

function printCapture(asJson, ids, notes, rel) {
  if (asJson) {
    const payload = {
      ok: true,
      action: 'inbox_capture',
      journal: rel,
      next_command: 'atris logs',
    };
    if (notes.length === 1) {
      payload.id = `I${ids[0]}`;
      payload.note = notes[0];
    } else {
      payload.count = notes.length;
      payload.ids = ids.map((id) => `I${id}`);
      payload.notes = notes;
    }
    printLogJson(payload);
    return;
  }
  if (notes.length === 1) {
    console.log(`captured I${ids[0]}: ${notes[0]}`);
    console.log(`journal: ${rel}`);
    console.log('Next: atris logs');
    return;
  }
  console.log(`captured ${notes.length} note${notes.length === 1 ? '' : 's'} in ${rel}`);
}

function logAtris() {
  const root = process.cwd();
  const args = process.argv.slice(3);
  const asJson = args.includes('--json');
  const forced = isForcedNonInteractive(args);
  const wantsRepl = args.includes('--repl');
  const positional = args.filter((arg) => !String(arg).startsWith('-'));
  const note = positional.join(' ').trim();

  // Empty folder talks like bare atris. Do not create atris/ or write
  // a journal. After init, a note still captures.
  if (isFreshWorkspace(root)) {
    process.exit(speakFirstMinute({ root, fresh: true, asJson }));
  }

  ensureLogDirectory();
  const { logFile, dateFormatted } = getLogPath();

  if (!fs.existsSync(logFile)) {
    createLogFile(logFile, dateFormatted);
  }

  const rel = journalRel(logFile);

  // `atris log "sentence"` (or one slug-like word) appends to today's Inbox.
  if (note && !wantsRepl) {
    printCapture(asJson, captureNotes(logFile, [note]), [note], rel);
    return;
  }

  // Piped stdin (tests and scripts): consume lines once, never hang waiting.
  if (!process.stdin.isTTY) {
    const piped = readPipedStdin();
    const lines = piped.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const notes = lines.filter((line) => line.toLowerCase() !== 'exit');
    if (notes.length > 0 && !wantsRepl) {
      printCapture(asJson, captureNotes(logFile, notes), notes, rel);
      return;
    }
    printReplNeeded(asJson, dateFormatted, rel);
    return;
  }

  // Forced headless: never open a REPL.
  if (forced) {
    printReplNeeded(asJson, dateFormatted, rel);
    return;
  }

  console.log(`┌─────────────────────────────────────────────────────────┐`);
  console.log(`│ Daily Log, ${dateFormatted}              [type "exit" to quit] │`);
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

// Splits a journal body into its ## groups so the digest can show
// completed / inbox / notes as short labeled blocks instead of a raw dump.
function journalGroups(lines) {
  const groups = [];
  let current = null;
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = { heading: heading[1], lines: [] };
      groups.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return groups;
}

function bulletCount(group) {
  return group.lines.filter((line) => /^\s*-\s+/.test(line)).length;
}

function digestSummaryLine(date, sections) {
  let completed = 0;
  let inbox = 0;
  for (const section of sections) {
    for (const group of journalGroups(section.lines)) {
      if (/^completed/i.test(group.heading)) completed += bulletCount(group);
      else if (/^inbox/i.test(group.heading)) inbox += bulletCount(group);
    }
  }
  const parts = [`${sections.length} log${sections.length === 1 ? '' : 's'}`];
  if (completed) parts.push(`${completed} completed`);
  if (inbox) parts.push(`${inbox} inbox`);
  return `${date}: ${parts.join(', ')}`;
}

function renderDigestSection(section) {
  const groups = journalGroups(section.lines);
  if (!groups.length) {
    return [`=== ${section.title} ===`, section.path, ...section.lines].join('\n');
  }
  const out = [`=== ${section.title} ===`, section.path];
  for (const group of groups) {
    const body = group.lines.filter((line) => line.trim() && line.trim() !== '---');
    if (!body.length) continue;
    out.push('', `${group.heading.toLowerCase()} (${bulletCount(group)})`, ...body);
  }
  return out.join('\n');
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
    console.log([
      digestSummaryLine(date, sections),
      '',
      ...sections.map(renderDigestSection),
    ].join('\n'));
  }

  return payload;
}

module.exports = { logAtris, logsDigest };
