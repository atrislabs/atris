const fs = require('fs');
const path = require('path');
const { writeLesson } = require('./autopilot');

function lessonAtris(subcommand, ...args) {
  const atrisDir = path.join(process.cwd(), 'atris');
  if (!fs.existsSync(atrisDir)) {
    console.error('  ✗ atris/ folder not found. Run "atris init" first.');
    process.exit(1);
  }

  if (subcommand !== 'add') {
    console.log('');
    console.log('  Usage: atris lesson add <slug> <pass|fail> "<text>"');
    console.log('');
    process.exit(subcommand ? 1 : 0);
  }

  const [slug, status, ...messageParts] = args;
  const explanation = messageParts.join(' ').trim();

  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    console.error('  ✗ slug must be kebab-case');
    process.exit(1);
  }

  if (!['pass', 'fail'].includes(status)) {
    console.error('  ✗ status must be "pass" or "fail"');
    process.exit(1);
  }

  if (!explanation) {
    console.error('  ✗ explanation is required');
    process.exit(1);
  }

  writeLesson(process.cwd(), slug, status, explanation);
  console.log(`✓ lesson added: ${slug} (${status})`);
}

module.exports = lessonAtris;
