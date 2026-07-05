set -eu
cat > divide.js <<'JS'
#!/usr/bin/env node
'use strict';

function main(args = process.argv.slice(2)) {
  const dividend = Number(args[0]);
  const divisor = Number(args[1]);
  if (!Number.isFinite(dividend) || !Number.isFinite(divisor)) {
    console.error('usage: node divide.js <dividend> <divisor>');
    process.exit(2);
  }
  if (divisor === 0) {
    console.error('divisor must be non-zero');
    process.exit(2);
  }
  console.log(String(dividend / divisor));
}

if (require.main === module) main();

module.exports = { main };
JS
