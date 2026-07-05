this csv splitter is broken: index.js requires the wrong path for the
splitter module, and something inside lib/ is wired together with a
circular require that leaves a function undefined at runtime.

fix index.js and everything under lib/ so `node index.js data.csv` runs
successfully and prints the split chunks as json, and so npm test passes.

data.csv has 4 rows; the default chunk size is 2.
