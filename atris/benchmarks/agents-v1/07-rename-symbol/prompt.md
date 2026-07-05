rename the function `toMeters` (exported from convert.js) to `toBaseUnits`
everywhere it is defined or called, including in checks/convert.js.

keep npm test green.

do not change any other behavior, and keep the project zero dependency.
