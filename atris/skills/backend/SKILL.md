---
name: atris-backend
description: Backend architecture policy. Use when building APIs, services, data access, or any backend work. Prevents over-engineering.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# atris-backend

Part of the Atris policy system. Prevents ai-generated backend from being over-engineered.

## Atris Integration

This skill uses the Atris workflow:
1. Check `atris/MAP.md` for existing patterns before building
2. Reference `atris/policies/atris-backend.md` for full guidance
3. After building, run `atris review` to validate against this policy

## Quick Reference

**Naming:** avoid `data`, `result`, `handler`, `manager`, `service`, `utils`. names reveal intent.

**Abstractions:** three concrete examples before you abstract. copy-paste until patterns emerge.

**Errors:** let errors bubble. include context: what were you doing? what input caused this?

**Data Access:** no n+1 queries. think about patterns upfront. batch when possible.

**API Design:** boring and consistent. same patterns everywhere.

## Before Shipping Checklist

Run through `atris/policies/atris-backend.md` "before shipping" section:
- can you explain this in one sentence?
- are abstractions earning their keep?
- do error messages help debugging?
- anything "just in case" you could delete?

## Atris Commands

```bash
atris            # load workspace context
atris plan       # break down backend task
atris do         # build with step-by-step validation
atris review     # validate against this policy
```

## Learn More

- Full policy: `atris/policies/atris-backend.md`
- Navigation: `atris/MAP.md`
- Workflow: `atris/PERSONA.md`
