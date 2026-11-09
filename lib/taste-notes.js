'use strict';

// Taste is personal, so it lives outside the shipped skill: the project's
// atris/taste/TASTE.md and the person's ~/.atris/taste/TASTE.md. Sync replaces
// atris/skills/ on every update and never touches either file. Init and update
// only create the project starter when it is missing.

const fs = require('fs');
const path = require('path');

const PROJECT_TASTE_FILE = path.join('taste', 'TASTE.md');

const STARTER = `# Taste

How this project should look and read: its brand and its voice. Agents read this before making anything a person will see. The person's own taste in \`~/.atris/taste/TASTE.md\` comes second.

Each line gives the rule in plain words and links to a short note with the reason and real examples. \`atris/skills/taste/notes.md\` shows the shape.

## The list

- (Nothing recorded yet. When someone corrects how something looks or reads, add the rule here.)
`;

// Returns true when the starter was written (or would be, in a dry run).
function ensureProjectTasteFile(atrisDir, { dryRun = false } = {}) {
  const file = path.join(atrisDir, PROJECT_TASTE_FILE);
  if (fs.existsSync(file)) return false;
  if (!dryRun) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, STARTER, { flag: 'wx' });
  }
  return true;
}

module.exports = { ensureProjectTasteFile };
