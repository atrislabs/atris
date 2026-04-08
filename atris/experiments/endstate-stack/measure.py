"""Return a machine-readable score for the Endstate stack pack.

Expected artifact contract: ../../features/endstate/artifact-schema.json
"""

import json


payload = {
    "score": 0.0,
    "passed": 0,
    "total": 4,
    "status": "draft",
    "track": "stack",
    "missing": ["runner artifact bundle not implemented yet"],
}

print(json.dumps(payload))
