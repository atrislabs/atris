change the ledger output format in ledger.js from tab-separated lines to
csv: a header row of exactly `sku,qty,priceCents`, then one comma-separated
line per entry, no trailing blank line.

checks/ledger.js currently tests the old tab format; update it to test the
new csv format instead.

keep npm test green, and keep the project zero dependency.
