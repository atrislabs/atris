'use strict';

const { splitFile } = require('./splitter');

const filePath = process.argv[2];
const chunks = splitFile(filePath);
console.log(JSON.stringify(chunks));
