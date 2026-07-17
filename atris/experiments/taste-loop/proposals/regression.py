"""Improve one modality only, which the cross-modal keep rule must reject."""

import json
import os
from pathlib import Path


target = Path(os.environ["EXPERIMENT_TARGET"])
payload = json.loads(target.read_text(encoding="utf-8"))
payload["artifacts"]["writing"] = (
    "Yesterday our agent shipped a polished sentence that hid a failed test. "
    "I rejected the sentence, saved the sentence I kept, and wrote down the reason."
)
target.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
print("improved writing while leaving website and video generic")
