#!/usr/bin/env python3
"""Round-4 exhaustive sweep worker for Hajos cycle-decomposition conjecture.

Reads graph6 lines on stdin. Modes:
  raw        : test the graph as-is
  complement : test the complement of the input graph
  apex       : add one new vertex adjacent to ALL input vertices (join K1+H)

For each resulting graph G (must be simple, connected, even degrees):
  t = floor((n-1)/2)
  1. randomized long-cycle-peeling heuristic tries to exhibit a decomposition
     into <= t cycles; every claimed decomposition is VALIDATED as an exact
     edge partition into simple cycles via verify.check_decomposition
     (the independently verified checker). Invalid claims are discarded.
  2. survivors escalate to exact CP-SAT decision (search.cpsat_leq_t).
  3. CP-SAT UNSAT -> write certificate, exit 42 (then verify.py must confirm).

Exit 0: sweep complete, no counterexample. Exit 42: candidate counterexample.
Any UNKNOWN escalations are reported and make the sweep inconclusive.
"""
import argparse
import random
import sys
import time

import search   # cpsat_leq_t only (exact engine)
import verify   # check_decomposition (verified partition checker)


def parse_graph6(line):
    data = [ord(c) - 63 for c in line.strip()]
    n = data[0]
    bits = []
    for x in data[1:]:
        for k in range(5, -1, -1):
            bits.append((x >> k) & 1)
    edges = []
    idx = 0
    for j in range(1, n):
        for i in range(j):
            if bits[idx]:
                edges.append((i, j))
            idx += 1
    return n, edges


def transform(n, edges, mode):
    if mode == "raw":
        return n, edges
    if mode == "complement":
        eset = set(edges)
        comp = [(i, j) for j in range(1, n) for i in range(j)
                if (i, j) not in eset]
        return n, comp
    if mode == "apex":
        apex = n
        out = list(edges) + [(v, apex) for v in range(n)]
        return n + 1, out
    raise ValueError(mode)


# ---------------- validated heuristic ------------------------------------
def long_cycle(adj, rng, tries=3):
    """Random path growth + Posa rotations; return vertex list of a long
    simple cycle, or None."""
    active = [v for v in adj if adj[v]]
    if not active:
        return None
    best = None
    for _ in range(tries):
        start = rng.choice(active)
        path = [start]
        inpath = {start}
        limit = 6 * len(active) * len(active)
        for _step in range(limit):
            end = path[-1]
            exts = [y for y in adj[end] if y not in inpath]
            if exts:
                y = rng.choice(exts)
                path.append(y)
                inpath.add(y)
                continue
            if len(path) >= 3 and path[0] in adj[end]:
                if best is None or len(path) > len(best):
                    best = path[:]
                break
            rot = [i for i in range(len(path) - 2) if path[i] in adj[end]]
            if not rot:
                break
            i = rng.choice(rot)
            path[i + 1:] = reversed(path[i + 1:])
        if best is not None and len(best) == len(active):
            break
    return best


def peel_cycles(n, edges, rng):
    """One randomized attempt: peel long cycles; when max degree <= 2 the
    remainder is a disjoint union of simple cycles, extract them.
    Returns list of cycles (each list of edges) or None on failure."""
    adj = {i: set() for i in range(n)}
    for u, v in edges:
        adj[u].add(v)
        adj[v].add(u)
    cycles = []
    while True:
        rem = sum(len(adj[v]) for v in adj) // 2
        if rem == 0:
            return cycles
        maxdeg = max(len(adj[v]) for v in adj)
        if maxdeg <= 2:
            # remainder = vertex-disjoint simple cycles (even degrees 0/2)
            seen = set()
            for s in adj:
                if len(adj[s]) == 2 and s not in seen:
                    walk = [s]
                    seen.add(s)
                    prev = None
                    cur = s
                    while True:
                        nxts = [y for y in adj[cur] if y != prev]
                        if not nxts:
                            return None  # degree-1 vertex: broken state
                        nxt = nxts[0]
                        if nxt == s:
                            break
                        if nxt in seen:
                            return None
                        walk.append(nxt)
                        seen.add(nxt)
                        prev, cur = cur, nxt
                    cycles.append([(walk[i], walk[(i + 1) % len(walk)])
                                   for i in range(len(walk))])
            return cycles
        cyc = long_cycle(adj, rng)
        if cyc is None:
            return None
        for i in range(len(cyc)):
            u, v = cyc[i], cyc[(i + 1) % len(cyc)]
            adj[u].discard(v)
            adj[v].discard(u)
        cycles.append([(cyc[i], cyc[(i + 1) % len(cyc)])
                       for i in range(len(cyc))])


def heuristic_decompose(n, edges, t, rng, restarts):
    """Return validated cycle count <= t, or None if all restarts fail."""
    for _ in range(restarts):
        cycles = peel_cycles(n, edges, rng)
        if cycles is None or len(cycles) > t:
            continue
        if verify.check_decomposition(n, sorted(edges), cycles):
            return len(cycles)
        # invalid claim: treat as failure (do not trust)
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["raw", "complement", "apex"],
                    default="raw")
    ap.add_argument("--restarts", type=int, default=200)
    ap.add_argument("--cpsat-timeout", type=float, default=600)
    ap.add_argument("--label", default="sweep")
    ap.add_argument("--seed", type=int, default=99)
    args = ap.parse_args()
    rng = random.Random(args.seed)

    total = 0
    escal = 0
    unknown = 0
    hist = {}
    t0 = time.time()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        n0, e0 = parse_graph6(line)
        n, edges = transform(n0, e0, args.mode)
        edges = sorted((min(u, v), max(u, v)) for u, v in edges)
        t = (n - 1) // 2
        total += 1
        # sanity: even degrees (guaranteed by class choice, but check)
        deg = [0] * n
        for u, v in edges:
            deg[u] += 1
            deg[v] += 1
        if any(d % 2 for d in deg):
            print(f"SKIP odd-degree graph #{total} {line}", flush=True)
            continue
        c = heuristic_decompose(n, edges, t, rng, args.restarts)
        if c is not None:
            hist[c] = hist.get(c, 0) + 1
        else:
            escal += 1
            res = search.cpsat_leq_t(n, edges, t, timeout=args.cpsat_timeout)
            print(f"ESCALATE #{total} g6={line} mode={args.mode} cpsat={res}",
                  flush=True)
            if res == "UNSAT":
                cert = f"certificate_{args.label}.txt"
                with open(cert, "w") as f:
                    f.write(f"# candidate counterexample label={args.label} "
                            f"mode={args.mode} graph6={line}\n")
                    for u, v in edges:
                        f.write(f"{u} {v}\n")
                print(f"*** CANDIDATE COUNTEREXAMPLE -> {cert}", flush=True)
                sys.exit(42)
            elif res == "SAT":
                hist["cpsat_sat"] = hist.get("cpsat_sat", 0) + 1
            else:
                unknown += 1
        if total % 20000 == 0:
            print(f"[{args.label}] progress {total} "
                  f"elapsed={time.time()-t0:.0f}s hist={hist} "
                  f"escal={escal} unknown={unknown}", flush=True)
    status = "CLEAN" if unknown == 0 else "INCONCLUSIVE"
    print(f"[{args.label}] DONE {status} total={total} escal={escal} "
          f"unknown={unknown} hist={hist} elapsed={time.time()-t0:.0f}s",
          flush=True)
    sys.exit(0 if unknown == 0 else 3)


if __name__ == "__main__":
    main()
