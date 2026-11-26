"""Record one standing campaign reading and queue one local investigation on failure."""

import json
from pathlib import Path
import re
import subprocess
import sys

CAMPAIGN = "cmp-spark-coordination-watch"
ROOT = Path(__file__).resolve().parents[3]


def campaign(*args):
    result = subprocess.run(["atris", "campaign", *args, "--as", "architect", "--json"],
                            cwd=ROOT, capture_output=True, text=True)
    try:
        data = json.loads(result.stdout)
    except ValueError:
        raise RuntimeError(result.stderr.strip() or "campaign returned no reading")
    if not data.get("ok"):
        raise RuntimeError(data.get("error", "campaign request failed"))
    return result.returncode, data


def main():
    state = campaign("show", CAMPAIGN)[1]["campaign"]
    if state["state"] in {"done", "paused", "out_of_budget"}:
        print("coordination watch is " + state["state"])
        return 0
    exit_code, data = campaign("judge", CAMPAIGN)
    reading = data["reading"]
    output = reading.get("output_tail", "")
    seeds = re.findall(r"replay this workload with --seed (\d+)", output)
    issues = []
    for line in output.splitlines():
        if line.startswith("coordination issues "):
            issues = json.loads(line.removeprefix("coordination issues "))
    if data["passed"]:
        print(reading["summary"], "seed " + (seeds[-1] if seeds else "unavailable"))
        return 0
    existing = [m for m in data["campaign"]["missions"] if m["status"] in {"proposed", "claimed", "running"}]
    mission = existing[0]["id"] if existing and existing[0]["status"] == "proposed" else None
    if not existing:
        counter = len(data["campaign"]["missions"]) + 1
        mission = f"m-spark-investigate-{counter}"
        command = "python3 -B atris/campaigns/cmp-coordination-spark/round.py"
        if issues and re.fullmatch(r"[0-9a-f]{64}", issues[0].get("case_id", "")):
            command += " --replay-case " + issues[0]["case_id"]
        elif issues:
            command += " --seed " + str(int(issues[0]["seed"]))
        elif seeds:
            command += " --seed " + seeds[-1]
        details = {"mission_id": mission, "member": "replay-lead",
                   "objective": "Reproduce the failed coordination check locally. Verify the receiver before proposing any change.",
                   "verify": command, "evidence": output}
        campaign("event", CAMPAIGN, "mission_proposed", "--data", json.dumps(details))
    if mission:
        campaign("event", CAMPAIGN, "mission_claimed", "--data",
                 json.dumps({"mission_id": mission, "claim_key": mission}))
    print("failed reading recorded; one local investigation is queued")
    return exit_code or 1


if __name__ == "__main__":
    sys.exit(main())
