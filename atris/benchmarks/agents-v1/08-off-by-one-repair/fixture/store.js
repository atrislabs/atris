'use strict';

function paginate(items, page, pageSize) {
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  return items.slice(start, end + 1);
}

module.exports = { paginate };
