#!/usr/bin/env python3
"""Exhaustive sweep: geng -> cheap filters -> randomized greedy decomposition
-> CP-SAT exact decision only for greedy failures.

usage: exhaustive.py n [--eulerian] [--maxsec S]

Filters justified by published results (a counterexample must fail all):
  - connected (geng -c)
  - max degree >= 6           (proved for maxdeg <= 5)
  - nonplanar                 (proved for planar)
  - E-subgraph contains cycle (proved when even-degree vertices induce forest)
If --eulerian: keep only all-even-degree graphs (E-subgraph = G, cyclic).
"""
import sys, subprocess, random, time
from math import ceil
import networkx as nx
from search import decide_cpsat, graph_summary, edges_str, save_certificate


def graph6_to_adj(line):
    return nx.from_graph6_bytes(line.strip().encode())


def greedy_decompose(G, t, tries=30, rng=None):
    """Randomized greedy: repeatedly peel simple paths. True if <= t achieved."""
    rng = rng or random
    edges0 = list(G.edges())
    adj0 = {v: set(G.neighbors(v)) for v in G.nodes()}
    best = None
    for _ in range(tries):
        adj = {v: set(s) for v, s in adj0.items()}
        remaining = len(edges0)
        paths = 0
        while remaining:
            # prefer odd-degree start
            odd = [v for v in adj if len(adj[v]) % 2 == 1]
            pool = odd if odd else [v for v in adj if adj[v]]
            start = rng.choice(pool)
            cur = start
            visited = {start}
            plen = 0
            while True:
                nbrs = [w for w in adj[cur] if w not in visited]
                if not nbrs:
                    break
                nxt = rng.choice(nbrs)
                adj[cur].discard(nxt)
                adj[nxt].discard(cur)
                visited.add(nxt)
                cur = nxt
                plen += 1
            if plen == 0:
                # stuck: pick any remaining edge as a length-1 path
                v = next(v for v in adj if adj[v])
                w = next(iter(adj[v]))
                adj[v].discard(w); adj[w].discard(v)
                plen = 1
            remaining -= plen
            paths += 1
            if paths > t:
                break
        if remaining == 0 and paths <= t:
            return True
        if best is None or paths < best:
            best = paths
    return False


def main():
    n = int(sys.argv[1])
    eulerian = '--eulerian' in sys.argv
    maxsec = 36000
    for a in sys.argv:
        if a.startswith('--maxsec='):
            maxsec = int(a.split('=')[1])
    t = ceil(n / 2)
    rng = random.Random(42)
    cmd = ['geng', '-c', '-q', '-d2', str(n)]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True, bufsize=1 << 20)
    total = kept = greedy_ok = sat_solved = 0
    t0 = time.time()
    hard = []
    for line in proc.stdout:
        total += 1
        if time.time() - t0 > maxsec:
            print(f"TIME LIMIT after {total} graphs", flush=True)
            proc.kill()
            break
        G = graph6_to_adj(line)
        degs = dict(G.degree())
        if max(degs.values()) < 6:
            continue
        if eulerian and any(d % 2 for d in degs.values()):
            continue
        # E-subgraph cyclic
        ev = [v for v in G.nodes() if degs[v] % 2 == 0]
        H = G.subgraph(ev)
        if H.number_of_edges() == H.number_of_nodes() - nx.number_connected_components(H):
            continue  # forest -> proven
        if nx.check_planarity(G)[0]:
            continue
        kept += 1
        if greedy_decompose(G, t, tries=25, rng=rng):
            greedy_ok += 1
            continue
        # greedy failed: exact decision
        sat_solved += 1
        try:
            r = decide_cpsat(G, t, time_limit=120)
        except TimeoutError:
            hard.append(edges_str(G))
            print(f"SAT TIMEOUT: {graph_summary(G)} edges: {edges_str(G)}", flush=True)
            continue
        if r is None:
            print(f"*** COUNTEREXAMPLE *** {graph_summary(G)}", flush=True)
            print(f"edges: {edges_str(G)}", flush=True)
            save_certificate(G, f"certificate_exhaustive_n{n}.txt")
        if kept % 5000 == 0:
            print(f"progress: total={total} kept={kept} greedy_ok={greedy_ok} sat={sat_solved} "
                  f"({time.time()-t0:.0f}s)", flush=True)
    print(f"DONE n={n} eulerian={eulerian}: scanned={total} passed_filters={kept} "
          f"greedy_ok={greedy_ok} needed_exact={sat_solved} hard={len(hard)} "
          f"({time.time()-t0:.0f}s)", flush=True)


if __name__ == '__main__':
    main()
