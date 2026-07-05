this todo store's paginate(items, page, pageSize) has an off-by-one bug:
pages overlap by one item instead of tiling the list cleanly.

fix it so pages never overlap or duplicate items, for any page size.

keep npm test green.

do not change the paginate() function signature.
