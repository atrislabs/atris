'use strict';

const { toMeters } = require('./convert');

const [, , amountArg, unitArg] = process.argv;
const amount = Number(amountArg);
console.log(toMeters(amount, unitArg).toFixed(2));
