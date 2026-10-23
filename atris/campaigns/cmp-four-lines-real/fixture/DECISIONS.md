# Decisions

- mean() is done. It was reviewed last week and callers depend on it as is, including returning null for an empty list. Do not change src/mean.js.
- median() should behave like mean() at the edges: null for an empty or non-array input.
