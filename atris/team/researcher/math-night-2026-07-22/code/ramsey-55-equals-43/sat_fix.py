#!/usr/bin/env python3
"""SAT escalation around a near-miss (5,5;43) coloring.

Reads a 903-bit certificate, finds its monochromatic K5s, frees all edges
incident to any vertex of a violating K5 (optionally + extra random vertices),
freezes the rest, and asks a CDCL solver (pysat Cadical) whether the free
edges can be recolored so no 5-subset is monochromatic. Widens the free
vertex set until timeout or SAT.

usage: python3 sat_fix.py cert.txt [extra_free_vertices] [conflict_budget]
On SAT: writes certificate.txt and prints SOLVED.
"""
import sys, random
from itertools import combinations
from pysat.solvers import Cadical195

n = 43


def load(path):
    bits = [c for c in open(path).read() if c in "01"]
    assert len(bits) == n * (n - 1) // 2
    adj = {}
    k = 0
    for i in range(n):
        for j in range(i + 1, n):
            adj[(i, j)] = bits[k] == "1"
            k += 1
    return adj


def mono_k5s(adj):
    out = []
    for S in combinations(range(n), 5):
        pairs = [adj[(a, b)] for a, b in combinations(S, 2)]
        if all(pairs) or not any(pairs):
            out.append(S)
    return out


def main():
    cert = sys.argv[1]
    extra = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    budget = int(sys.argv[3]) if len(sys.argv) > 3 else 10**7
    adj = load(cert)
    viol = mono_k5s(adj)
    print(f"input has {len(viol)} mono K5s: {viol}")
    if not viol:
        print("already a valid certificate")
        return
    core = sorted({v for S in viol for v in S})
    rng = random.Random(7)
    pool = [v for v in range(n) if v not in core]
    freeverts = set(core) | set(rng.sample(pool, min(extra, len(pool))))
    print(f"free vertices ({len(freeverts)}): {sorted(freeverts)}")

    # variable per edge; edges with an endpoint in freeverts are free
    var = {}
    for i in range(n):
        for j in range(i + 1, n):
            var[(i, j)] = len(var) + 1
    free = {e for e in var if e[0] in freeverts or e[1] in freeverts}
    print(f"free edges: {len(free)} / {len(var)}")

    cls = []
    for S in combinations(range(n), 5):
        pairs = list(combinations(S, 2))
        # not-all-red clause: OR over pairs of (edge is blue)
        if not any((not adj[e]) and e not in free for e in pairs):
            c = [-var[e] for e in pairs if e in free]
            cls.append(c)  # empty impossible unless frozen mono K5
        # not-all-blue
        if not any(adj[e] and e not in free for e in pairs):
            c = [var[e] for e in pairs if e in free]
            cls.append(c)
    # freeze assignments
    for e, v in var.items():
        if e not in free:
            cls.append([v] if adj[e] else [-v])
    print(f"clauses: {len(cls)}")
    if any(len(c) == 0 for c in cls):
        print("UNSAT trivially (frozen mono K5)")
        return
    with Cadical195(bootstrap_with=cls) as s:
        s.conf_budget(budget)
        res = s.solve_limited()
        print(f"solver result: {res}")
        if res is True:
            model = set(l for l in s.get_model() if l > 0)
            out = []
            for i in range(n):
                for j in range(i + 1, n):
                    out.append("1" if var[(i, j)] in model else "0")
            open("certificate.txt", "w").write("".join(out) + "\n")
            print("SOLVED -- wrote certificate.txt")
        elif res is False:
            print(f"UNSAT: no completion with these {len(free)} free edges")
        else:
            print("UNDECIDED within conflict budget")


if __name__ == "__main__":
    main()
