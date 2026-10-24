// Reviewed and shipped. Callers depend on this exact behavior.
function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  let total = 0;
  for (const v of values) total += v;
  return total / values.length;
}

module.exports = { mean };
