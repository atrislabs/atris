---
name: atris-backend
description: Backend architecture policy. Use when building APIs, services, data access, or any backend work. Prevents over-engineering.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# atris-backend

Prevents ai-generated backend from being over-engineered and over-abstracted.

## When to Use

- Building APIs, services, database code
- Reviewing backend code
- User asks for architecture feedback

## Quick Reference

**Naming:** avoid `data`, `result`, `handler`, `manager`, `service`, `utils`. names reveal intent.

**Abstractions:** three concrete examples before you abstract. copy-paste until patterns emerge.

**Errors:** let errors bubble. include context: what were you doing? what input caused this?

**Data Access:** no n+1 queries. think about patterns upfront. batch when possible.

**API Design:** boring and consistent. same patterns everywhere.

## Before Shipping

- can you explain this in one sentence?
- are abstractions earning their keep?
- do error messages help debugging?
- anything "just in case" you could delete?

## Full Policy

Read `atris/policies/atris-backend.md` for complete guidance.
