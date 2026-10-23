'use strict';

// The person's own calendar day as YYYY-MM-DD. toISOString() gives the UTC
// day, which is already tomorrow in the evening west of Greenwich.
function localDay(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

module.exports = { localDay };
