'use strict';

function formatEntries(entries) {
  return entries.map((e) => `${e.sku}\t${e.qty}\t${e.priceCents}`).join('\n');
}

module.exports = { formatEntries };
