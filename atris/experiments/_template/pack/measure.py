"""Return a machine-readable score for the experiment."""

import json


payload = {
    "score": 0.0,
    "passed": 0,
    "total": 0,
    "status": "fail",
}

print(json.dumps(payload))
