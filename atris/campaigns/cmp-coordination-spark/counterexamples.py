"""Retain reproducible receiver violations and replay them on fresh fixtures."""
from contextlib import closing
from hashlib import sha256
import json
from pathlib import Path
import sqlite3


class Mismatch(Exception):
    """A semantic violation witnessed at a working receiver, with a stable oracle code."""

    def __init__(self, code, detail):
        if not isinstance(code, str) or not code.strip():
            raise ValueError("a receiver mismatch needs a stable code")
        self.code = code.strip().lower()
        super().__init__(detail)


def canonical(manifest):
    if not isinstance(manifest, dict) or type(manifest.get("seed")) is not int:
        raise ValueError("a workload requires an integer seed")
    return json.dumps(manifest, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(encoded):
    return sha256(encoded.encode("utf-8")).hexdigest()


def prepare(db):
    with db:
        db.execute("BEGIN IMMEDIATE")
        db.execute("""CREATE TABLE IF NOT EXISTS counterexamples (
            manifest TEXT PRIMARY KEY, case_id TEXT NOT NULL, code TEXT NOT NULL,
            detail TEXT NOT NULL, last_exercised INTEGER NOT NULL
        )""")
        if "case_id" not in {col[1] for col in db.execute("PRAGMA table_info(counterexamples)")}:
            db.execute("ALTER TABLE counterexamples ADD COLUMN case_id TEXT")
            for encoded, in db.execute("SELECT manifest FROM counterexamples").fetchall():
                db.execute("UPDATE counterexamples SET case_id = ? WHERE manifest = ?", (digest(encoded), encoded))
        db.execute("CREATE UNIQUE INDEX IF NOT EXISTS counterexample_id ON counterexamples(case_id)")
        db.execute("CREATE INDEX IF NOT EXISTS counterexample_exercised ON counterexamples(last_exercised, manifest)")


def load_case(database, case_id):
    """Read one retained sequence by its full content digest, without regenerating it."""
    path = Path(database).resolve()
    if not path.exists():
        return None
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
        columns = {col[1] for col in db.execute("PRAGMA table_info(counterexamples)")}
        if not columns:
            return None
        if "case_id" in columns:
            row = db.execute("SELECT manifest FROM counterexamples WHERE case_id = ?", (case_id,)).fetchone()
        else:
            # A read-only lookup also works before the first write upgrades an old store.
            row = next((r for r in db.execute("SELECT manifest FROM counterexamples") if digest(r[0]) == case_id), None)
        if row is None:
            return None
        if digest(row[0]) != case_id:
            raise sqlite3.DatabaseError("stored workload does not match its case ID")
        return json.loads(row[0])


def exercise(encoded, observe, source):
    # Decoding afresh prevents a fixture from mutating the confirmation or saved work.
    seed = json.loads(encoded)["seed"]
    result = {"seed": seed, "source": source}
    try:
        observation = observe(json.loads(encoded))
    except Mismatch as first:
        first_code, first_detail = first.code, str(first)
    except Exception as error:
        return {**result, "kind": "setup", "detail": f"{type(error).__name__}: {error}"}
    else:
        return {**result, "kind": "pass", "detail": str(observation) if observation is not None else "passed"}

    try:
        observe(json.loads(encoded))
    except Mismatch as second:
        if second.code == first_code:
            return {**result, "kind": "mismatch", "code": first_code,
                    "detail": f"first: {first_detail}; confirmed: {second}"}
        detail = f"{first_code} ({first_detail}) changed to {second.code} ({second}) on confirmation"
    except Exception as error:
        return {**result, "kind": "setup",
                "detail": f"confirmation of {first_code} failed: {type(error).__name__}: {error}"}
    else:
        detail = f"{first_code} ({first_detail}) passed on confirmation"
    return {**result, "kind": "inconclusive", "detail": detail}


def record(db, encoded, result):
    # Allocate a monotonic position inside the write transaction. Keep the original
    # evidence even when a retained case recovers or another watch finds it again.
    with db:
        db.execute("BEGIN IMMEDIATE")
        position = db.execute("SELECT COALESCE(MAX(last_exercised), 0) + 1 FROM counterexamples").fetchone()[0]
        case_id = digest(encoded)
        if result["kind"] == "mismatch":
            db.execute(
                """INSERT INTO counterexamples(manifest, case_id, code, detail, last_exercised)
                   VALUES (?, ?, ?, ?, ?) ON CONFLICT(manifest) DO UPDATE
                   SET last_exercised = excluded.last_exercised""",
                (encoded, case_id, result["code"], result["detail"], position))
        else:
            updated = db.execute("UPDATE counterexamples SET last_exercised = ? WHERE manifest = ?", (position, encoded))
            if not updated.rowcount:
                return
    result["case_id"] = case_id


def evaluate(manifest, observe, database=None, replay_limit=3):
    """Exercise retained cases before today's candidate. Only confirmed mismatches enter the store.

    observe(manifest) must start a fresh fixture on each call. A normal return is
    successful. Raise Mismatch only for a verified semantic difference. All other
    exceptions identify an evaluation failure and can never promote a workload.
    """
    encoded = canonical(manifest)
    if type(replay_limit) is not int or replay_limit < 0:
        raise ValueError("replay_limit must be a nonnegative integer")
    if database is None:
        return [exercise(encoded, observe, "candidate")]

    results = []
    try:
        Path(database).parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(database, timeout=15)) as db:
            prepare(db)
            retained = db.execute(
                """SELECT manifest FROM counterexamples WHERE manifest != ?
                   ORDER BY last_exercised, manifest LIMIT ?""", (encoded, replay_limit)).fetchall()
            for saved, in retained:
                result = exercise(saved, observe, "retained")
                results.append(result)
                record(db, saved, result)
            result = exercise(encoded, observe, "candidate")
            results.append(result)
            record(db, encoded, result)
    except (OSError, sqlite3.Error, ValueError, KeyError) as error:
        results.append({"seed": manifest["seed"], "source": "store", "kind": "setup",
                        "detail": f"counterexample store failed: {error}"})
    return results
