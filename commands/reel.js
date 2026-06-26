// atris reel — one line of text into a short, on-brand video (an animated card).
//
//   atris reel "Ship faster" --theme brand --size square
//   atris reel "It just works." --kind quote --by "a founder" --seconds 3
//
// Renders frames with headless Chrome (the same one `atris card` uses) and encodes
// with ffmpeg. No new dependency. Falls back to a card image if either is missing.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawnSync } = require('child_process');
const { promisify } = require('util');
const pexec = promisify(execFile);
const { buildReelFrame, reelFrames } = require('../lib/reel');
const { SIZES, KINDS } = require('../lib/card');

function parseFlags(argv) {
  const flags = {}; const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2); const next = argv[i + 1];
      if (next != null && !next.startsWith('--')) { flags[key] = next; i++; } else flags[key] = true;
      continue;
    }
    pos.push(a);
  }
  return { flags, pos };
}

function findBin(macApps, names) {
  for (const p of macApps) if (fs.existsSync(p)) return p;
  for (const name of names) {
    const r = spawnSync('command', ['-v', name], { shell: true, encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}
const findChrome = () => (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH))
  ? process.env.CHROME_PATH
  : findBin([
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ], ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome']);
const findFfmpeg = () => findBin(['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'], ['ffmpeg']);

async function renderFrames(chrome, ts, spec, dir, w, h, onDone) {
  const pad = (i) => String(i).padStart(4, '0');
  let idx = 0; let done = 0;
  async function worker() {
    while (idx < ts.length) {
      const i = idx++;
      const { html } = buildReelFrame(spec, ts[i]);
      const hf = path.join(dir, `f-${pad(i)}.html`);
      const pf = path.join(dir, `f-${pad(i)}.png`);
      fs.writeFileSync(hf, html);
      await pexec(chrome, [
        '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
        `--window-size=${w},${h}`, '--virtual-time-budget=2200',
        `--user-data-dir=${path.join(dir, 'ud-' + i)}`,
        `--screenshot=${pf}`, `file://${hf}`,
      ], { timeout: 60000 });
      onDone && onDone(++done, ts.length);
    }
  }
  const conc = Math.min(5, ts.length);
  await Promise.all(Array.from({ length: conc }, worker));
}

async function run(argv) {
  const { flags, pos } = parseFlags(argv);
  if (pos[0] === 'help' || flags.help) {
    console.log(`\n  atris reel — one line of text into a short on-brand video\n
  atris reel "Your headline" [--kind statement|quote|stat] [--theme <name>] [--size square|og|wide|story] [--seconds 2.6]
  flags: --sub --kicker --by --number --label --brand --version --out <file.mp4>\n`);
    return 0;
  }

  const text = pos.join(' ').trim();
  const kind = flags.kind || 'statement';
  if (!KINDS.includes(kind)) { console.error(`  unknown kind "${kind}". try: ${KINDS.join(', ')}`); return 2; }
  const size = flags.size || 'square';
  if (!SIZES[size]) { console.error(`  unknown size "${size}". try: ${Object.keys(SIZES).join(', ')}`); return 2; }
  if (kind === 'stat' && !flags.number && !text) { console.error('  stat reels need --number'); return 2; }
  if (kind !== 'stat' && !text) { console.error('  give the reel some text: atris reel "Your headline"'); return 2; }

  const seconds = Math.max(1, Math.min(8, parseFloat(flags.seconds) || 2.6));
  const fps = 20;
  const spec = {
    kind, text, headline: text, theme: flags.theme, size,
    sub: flags.sub, kicker: flags.kicker, by: flags.by,
    number: flags.number, label: flags.label, brand: flags.brand, version: flags.version,
  };
  const { w, h } = SIZES[size];
  const base = flags.out ? String(flags.out).replace(/\.mp4$/i, '') : `reel-${kind}-${flags.theme || 'atris'}-${size}`;
  const outMp4 = path.resolve(`${base}.mp4`);

  const chrome = findChrome();
  if (!chrome) { console.error('\n  no Chrome found to render frames. install Chrome or set CHROME_PATH.\n'); return 1; }
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) { console.error('\n  no ffmpeg found to encode the video. install ffmpeg (brew install ffmpeg).\n'); return 1; }

  const ts = reelFrames(seconds, fps);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-reel-'));
  console.log(`\n  rendering ${ts.length} frames (${seconds}s, ${size})...`);
  try {
    await renderFrames(chrome, ts, spec, dir, w, h, (d, n) => {
      if (d === n || d % 10 === 0) process.stdout.write(`\r  frames ${d}/${n}   `);
    });
    process.stdout.write('\n  encoding...\n');
    await pexec(ffmpeg, [
      '-y', '-framerate', String(fps), '-i', path.join(dir, 'f-%04d.png'),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outMp4,
    ]);
  } catch (e) {
    console.error(`\n  render failed: ${String(e.message).split('\n')[0]}`); return 1;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  if (!fs.existsSync(outMp4)) { console.error('  no video produced'); return 1; }
  console.log(`\n  ✓ ${kind} reel, ${w}x${h}, ${seconds}s, theme ${flags.theme || 'atris'}\n    ${outMp4}\n`);
  return 0;
}

module.exports = { run, findChrome, findFfmpeg };
