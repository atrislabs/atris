function printOperatorNext(command, { label = 'Next' } = {}) {
  const clean = String(command || '').trim();
  if (!clean) return;
  console.log(`${label}: ${clean}`);
}

module.exports = { printOperatorNext };
