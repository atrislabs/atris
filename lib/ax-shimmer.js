const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  muted: '\x1b[90m',
  white: '\x1b[37m',
  bright: '\x1b[97m',
};

function useColor(options = {}) {
  if (options.color === false) return false;
  if (process.env.NO_COLOR) return false;
  return Boolean(options.color || options.isTTY);
}

function paint(text, codes, options = {}) {
  if (!useColor(options)) return String(text);
  const styles = codes.filter(Boolean);
  if (!styles.length) return String(text);
  return `${styles.join('')}${text}${ANSI.reset}`;
}

const SHIMMER_TICK_STEP = 0.44;

function shimmerStyleForDistance(dist) {
  // Obelisk .shimmer-text: pure grayscale luminance sweep — no bold, no hue.
  const t = Math.min(Math.max(dist, 0) / 3.4, 1);
  if (t <= 0.2) return [ANSI.bright];
  if (t <= 0.48) return [ANSI.white];
  if (t <= 0.72) return [ANSI.muted];
  return [ANSI.dim, ANSI.muted];
}

function renderShimmerText(text, tick = 0, options = {}) {
  const value = String(text || '');
  if (!value) return '';
  if (!useColor(options)) return value;

  const len = Math.max(1, value.length);
  const cycle = len + 12;
  const head = (Number(tick) * SHIMMER_TICK_STEP) % cycle;

  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === ' ') {
      out += ' ';
      continue;
    }
    let dist = Math.abs(i - head);
    if (dist > cycle / 2) dist = cycle - dist;
    out += paint(char, shimmerStyleForDistance(dist), options);
  }
  return out;
}

module.exports = {
  ANSI,
  SHIMMER_TICK_STEP,
  paint,
  renderShimmerText,
  shimmerStyleForDistance,
  useColor,
};
