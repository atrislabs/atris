#!/usr/bin/env python3
"""Exhaustive check: read graph6 lines on stdin (from nauty geng), for each
graph verify a cycle decomposition into <= t=floor((n-1)/2) cycles exists.
Heuristic first; CP-SAT escalation for survivors. Exit 42 on counterexample."""
import sys, random, time
import search

rng = random.Random(99)


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


def main():
    total = 0
    escal = 0
    hist = {}
    t0 = time.time()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        n, edges = parse_graph6(line)
        t = (n - 1) // 2
        best = search.heuristic_leq_t(n, edges, t, rng, restarts=200)
        total += 1
        hist[best] = hist.get(best, 0) + 1
        if best > t:
            escal += 1
            res = search.cpsat_leq_t(n, edges, t, timeout=600)
            print(f"ESCALATE #{total} {line} heuristic={best} cpsat={res}", flush=True)
            if res == "UNSAT":
                with open("certificate.txt", "w") as f:
                    f.write(f"# exhaustive counterexample graph6={line}\n")
                    for u, v in edges:
                        f.write(f"{u} {v}\n")
                print("*** COUNTEREXAMPLE", line)
                sys.exit(42)
        if total % 20000 == 0:
            print(f"progress {total} elapsed={time.time()-t0:.0f}s hist={hist} escal={escal}",
                  flush=True)
    print(f"DONE total={total} escalations={escal} hist={hist} "
          f"elapsed={time.time()-t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
