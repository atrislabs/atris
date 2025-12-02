# atris-backend.md — backend architecture

> ai backend code smells like over-engineering. this policy keeps it simple.

---

## naming

**avoid:** `data`, `result`, `temp`, `handler`, `manager`, `service`, `utils`

**do:** names reveal intent. `userAuthToken` not `token`. delete unused code completely.

---

## abstractions

**avoid:** wrappers that call one function, interfaces with one implementation, "just in case" extensibility

**do:** three concrete examples before you abstract. copy-paste until patterns emerge.

---

## error handling

**avoid:** catch-all blocks, generic messages, defensive checks the type system handles

**do:** let errors bubble. include context: what were you doing? what input caused this?

---

## data access

**avoid:** n+1 queries, loading everything for one field, scattered raw sql

**do:** think about access patterns upfront. batch when possible. use indexes.

---

## api design

**avoid:** inconsistent naming, mystery params (`type=1`), different shapes for same resource

**do:** boring and consistent. same patterns everywhere.

---

## before shipping

- can you explain this in one sentence?
- are abstractions earning their keep?
- do error messages help debugging?
- is there anything "just in case" you could delete?

---

## the test

> "would this be easier to understand if simpler?"

if yes, simplify. cleverness is debt.
