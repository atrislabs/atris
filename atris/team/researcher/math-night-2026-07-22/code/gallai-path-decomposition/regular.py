#!/usr/bin/env python3
"""Even-regular (Eulerian) attack on Gallai's conjecture.

All-odd-degree graphs satisfy Gallai (Lovasz 1968), so the extremal pressure
is on graphs with many even-degree vertices; even-regular graphs on even n
have bound exactly n/2 and no odd-vertex lower bound. We enumerate d-regular
graphs as complements of (n-1-d)-regular graphs when the complement degree is
small (cubic), deduplicating by isomorphism, and solve each exactly.

mode 'enum d n seconds': sample random (n-1-d)-regular graphs, dedup by
   certificate, solve complement decision at t=n/2.
mode 'sample d n seconds': straight random d-regular sampling + solve.
"""
import sys, time, random
import networkx as nx
from math import ceil
from search import decide_cpsat, graph_summary, edges_str, save_certificate


def canon_cert(G):
    # weisfeiler_lehman is not a complete invariant but collisions are then
    # resolved with exact isomorphism against stored representatives
    return nx.weisfeiler_lehman_graph_hash(G, iterations=4)


def run(d, n, seconds, mode='enum', seed=5):
    rng = random.Random(seed)
    t = ceil(n / 2)
    seen = {}  # hash -> list of graphs (dedup)
    end = time.time() + seconds
    solved = tight = 0
    while time.time() < end:
        try:
            if mode == 'enum':
                H = nx.random_regular_graph(n - 1 - d, n, seed=rng.randrange(1 << 30))
                G = nx.complement(H)
            else:
                G = nx.random_regular_graph(d, n, seed=rng.randrange(1 << 30))
        except nx.NetworkXError:
            continue
        if not nx.is_connected(G):
            continue
        h = canon_cert(G)
        bucket = seen.setdefault(h, [])
        if any(nx.is_isomorphic(G, X) for X in bucket):
            continue
        bucket.append(G)
        solved += 1
        try:
            r = decide_cpsat(G, t, time_limit=240)
        except TimeoutError:
            print(f"TIMEOUT {graph_summary(G)} edges: {edges_str(G)}", flush=True)
            continue
        if r is None:
            print(f"*** COUNTEREXAMPLE *** {d}-regular {graph_summary(G)}", flush=True)
            print(f"edges: {edges_str(G)}", flush=True)
            save_certificate(G, f"certificate_{d}reg{n}.txt")
        else:
            try:
                r2 = decide_cpsat(G, t - 1, time_limit=60)
                if r2 is None:
                    tight += 1
                    print(f"TIGHT p={t} {d}-reg n={n} #{solved}", flush=True)
                    with open('tight_instances.txt', 'a') as f:
                        f.write(f"{d}-regular n={n} p={t} edges: {edges_str(G)}\n")
                else:
                    print(f"ok (p<={t-1}) {d}-reg n={n} #{solved}", flush=True)
            except TimeoutError:
                print(f"decomposes at t={t}; t-1 timeout. #{solved}", flush=True)
    print(f"done: {solved} non-isomorphic {d}-regular graphs on {n} vertices solved, {tight} tight", flush=True)


if __name__ == '__main__':
    mode = sys.argv[1]
    d, n, secs = int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
    seed = int(sys.argv[5]) if len(sys.argv) > 5 else 5
    run(d, n, secs, mode=mode, seed=seed)
