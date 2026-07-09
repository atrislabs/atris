'use strict';

const fs = require('fs');
const path = require('path');
const { initAtris } = require('./init');
const { run: themeCommand } = require('./theme');
const { parseSimpleFlags, runPlainInterview } = require('./interview');
const {
  parseTimeToDecimal,
  parseDaysArg,
  buildAvailableHours,
  resolveTimezone,
} = require('./avail');
const { getAppBaseUrl } = require('../utils/api');

const VALUE_FLAGS = [
  '--name',
  '--want',
  '--currency',
  '--username',
  '--wake',
  '--sleep',
  '--where',
  '--tz',
  '--days',
  '--slot-minutes',
  '--window-days',
];

const MEET_FIELDS = [
  { key: 'name', flag: '--name', question: 'who are you?\n> ' },
  { key: 'want', flag: '--want', question: 'what do you want to make happen?\n> ' },
  { key: 'currency', flag: '--currency', question: 'what would count as a win in your world?\n> ' },
];

function showHelp() {
  console.log('');
  console.log('usage: atris meet --name <name> --want <want> --currency <win>');
  console.log('');
  console.log('onboard someone in one sitting, write their first profile, and print their /book link.');
  console.log('');
  console.log('options:');
  console.log('  --name text          who they are');
  console.log('  --want text          what they want');
  console.log('  --currency text      what a win looks like');
  console.log('  --username text      booking link name, defaults from --name');
  console.log('  --wake time          first bookable time, default 9am');
  console.log('  --sleep time         last bookable time, default 5pm');
  console.log('  --days days          all, weekdays, weekends, or mon,wed,fri');
  console.log('');
}

function slugify(value, fallback = 'guest') {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}

function positiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function withQuietOutput(fn) {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function ensureAtrisWorkspace(root) {
  if (fs.existsSync(path.join(root, 'atris'))) return;

  const originalArgv = process.argv;
  process.argv = [originalArgv[0], originalArgv[1], 'init', '--yes'];
  const cwd = process.cwd();
  process.chdir(root);
  try {
    initAtris();
  } finally {
    process.chdir(cwd);
    process.argv = originalArgv;
  }
}

async function ensureTheme(root) {
  if (fs.existsSync(path.join(root, '.atris', 'theme.json'))) return 0;
  const cwd = process.cwd();
  process.chdir(root);
  try {
    return await themeCommand(['init']);
  } finally {
    process.chdir(cwd);
  }
}

function buildBookingProfile(options = {}) {
  const wake = options.wake || '9am';
  const sleep = options.sleep || '5pm';
  const wakeDec = parseTimeToDecimal(wake);
  const sleepDec = parseTimeToDecimal(sleep);
  if (!(wakeDec < sleepDec)) throw new Error('wake must be before sleep on the same day');

  const days = options.days || 'weekdays';
  const dayIndexes = parseDaysArg(days);
  const timezone = resolveTimezone({ tz: options.tz, where: options.where });

  return {
    days,
    wake,
    sleep,
    settings: {
      timezone,
      available_hours: buildAvailableHours(dayIndexes, wakeDec, sleepDec),
      slot_duration_minutes: positiveInt(options.slotMinutes, 30),
      booking_window_days: positiveInt(options.windowDays, 30),
    },
  };
}

function renderProfile({ name, want, currency, link, username, booking }) {
  return [
    '# profile',
    '',
    `name: ${name}`,
    `booking link: ${link}`,
    `currency: ${currency}`,
    '',
    '## first wish',
    '',
    `- said: ${want}`,
    `- win means: ${currency}`,
    '',
    '## booking page',
    '',
    `- username: ${username}`,
    `- days: ${booking.days}`,
    `- hours: ${booking.wake} to ${booking.sleep}`,
    `- timezone: ${booking.settings.timezone}`,
    '',
  ].join('\n');
}

function writeMeetFiles(root, profile) {
  const atrisDir = path.join(root, 'atris');
  fs.mkdirSync(atrisDir, { recursive: true });
  fs.writeFileSync(path.join(atrisDir, 'profile.md'), renderProfile(profile), 'utf8');

  const localConfigDir = path.join(root, '.atris');
  fs.mkdirSync(localConfigDir, { recursive: true });
  fs.writeFileSync(path.join(localConfigDir, 'booking-settings.json'), JSON.stringify({
    username: profile.username,
    link: profile.link,
    settings: profile.booking.settings,
  }, null, 2) + '\n', 'utf8');
}

async function meetCommand(args = [], root = process.cwd()) {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    showHelp();
    return 0;
  }

  const interview = await runPlainInterview({ args, fields: MEET_FIELDS });
  if (!interview.ok) {
    console.error(`meet needs ${interview.missing.join(', ')} when not running in a terminal.`);
    return 2;
  }

  const parsed = parseSimpleFlags(args, VALUE_FLAGS);
  const name = interview.answers.name;
  const want = interview.answers.want;
  const currency = interview.answers.currency;
  const username = slugify(parsed.values['--username'] || name);
  const link = `${getAppBaseUrl()}/book/${username}`;

  let booking;
  try {
    booking = buildBookingProfile({
      wake: parsed.values['--wake'],
      sleep: parsed.values['--sleep'],
      where: parsed.values['--where'],
      tz: parsed.values['--tz'],
      days: parsed.values['--days'],
      slotMinutes: parsed.values['--slot-minutes'],
      windowDays: parsed.values['--window-days'],
    });
  } catch (err) {
    console.error(err.message || String(err));
    return 1;
  }

  await withQuietOutput(async () => {
    ensureAtrisWorkspace(root);
    const themeCode = await ensureTheme(root);
    if (themeCode) throw new Error('theme setup failed');
  });

  writeMeetFiles(root, { name, want, currency, username, link, booking });

  console.log(link);
  console.log(`next: share this link; atris will start turning new conversations into ${currency}.`);
  return 0;
}

module.exports = {
  meetCommand,
  slugify,
  buildBookingProfile,
  renderProfile,
};
