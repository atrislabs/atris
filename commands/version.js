const fs = require('fs');
const path = require('path');
const { rejectUnsupportedJson } = require('../lib/noninteractive');

const PACKAGE_JSON_PATH = path.join(__dirname, '..', 'package.json');

function showVersion(args = process.argv.slice(3)) {
  rejectUnsupportedJson('version', args);
  try {
    const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
    console.log(`atris v${packageJson.version}`);
  } catch (error) {
    console.error('✗ Error: Could not read package.json');
    process.exit(1);
  }
}

module.exports = { showVersion };
