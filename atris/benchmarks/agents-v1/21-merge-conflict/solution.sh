set -eu
cat > math.js <<'JS'
'use strict';

function add(a, b) {
  return Number(a) + Number(b);
}

module.exports = { add };
JS
cat > message.js <<'JS'
'use strict';

function greeting(name) {
  return `hello ${String(name).trim().toUpperCase()}`;
}

module.exports = { greeting };
JS
git add math.js message.js
