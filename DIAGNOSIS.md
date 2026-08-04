# BCK-1369 diagnosis

## Finding

The blocking root cause is in the backend import contract, so no CLI code was changed.

`atris member push` sends the member as a raw Markdown body to the generic import endpoint. The request contains no business identifier (`commands/member.js:4338-4343`). The CLI does already have a working workspace-binding pattern: task sync resolves `.atris/business.json` from the workspace root and reads `business_id` (`commands/task.js:11072-11079`).

Resolving that ID in the CLI is not enough against the current backend:

- `backend/routers/agent/member.py:412-418` accepts only the request, authenticated user, file, and form content. There is no `business_id` parameter or business-membership authorization path.
- On update, the route writes an `update_data` object without `business_id` (`backend/routers/agent/member.py:533-545`).
- On create, it calls `Agent.initialize` without `business_id` (`backend/routers/agent/member.py:546-559`).
- `Agent.initialize` itself has no `business_id` argument, and its insert payload omits the column (`backend/agent.py:1224-1235`, `backend/agent.py:1249-1266`). The database therefore applies the nullable default.
- The GM member projection only selects agents whose `agents.business_id` equals the requested business (`backend/services/member_projection_service.py:552-588`), so imported agents with NULL are necessarily absent.
- The working business-agent creation flow proves the required persistence behavior by inserting `business_id` directly (`backend/routers/business/members.py:1468-1480`).

## Required backend change

Extend `/agent/import-member` to accept a business identifier, authorize the authenticated user against that business, and persist the validated ID on both create and update. The CLI can then reuse the workspace-root binding path demonstrated by task sync and send that ID with the member import. A regression should cover both a newly imported member and an existing imported member being bound to the selected business and appearing in the business member projection.
