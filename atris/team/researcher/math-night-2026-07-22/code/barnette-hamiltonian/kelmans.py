#!/usr/bin/env python3
"""
Kelmans prong: Barnette's conjecture is equivalent (Kelmans 1994) to the
statement that for every graph in the class and every two edges e1, e2 on a
common face, there is a Hamiltonian cycle through e1 avoiding e2.
A single graph+face+pair failure would refute the stronger local property and
be a major lead (and building block) toward a counterexample.

Usage: kelmans.py cert1.txt [cert2.txt ...]
Tests ALL face edge-pairs of each graph with a SAT Hamiltonicity query
(forced edge e1 IN, e2 OUT). Reports any failing pair.
"""
import sys
from itertools import combinations
import verify  # read_graph, structure
import networkx as nx
from pysat.solvers import Glucose3

def faces(adj, n):
    G = nx.Graph((v, w) for v in adj for w in adj[v])
    ok, emb = nx.check_planarity(G)
    assert ok
    seen = set()
    out = []
    for v in range(n):
        for w in adj[v]:
            if (v, w) in seen: continue
            face = emb.traverse_face(v, w, mark_half_edges=seen)
            out.append(face)
    return out

def ham_with(n, adj, force_in, force_out):
    edges = sorted(set(tuple(sorted((v, w))) for v in adj for w in adj[v]))
    evar = {e: i+1 for i, e in enumerate(edges)}
    cnf = []
    for v in range(n):
        inc = [evar[tuple(sorted((v, w)))] for w in adj[v]]
        for a, b in combinations(inc, 2): cnf.append([a, b])
        cnf.append([-x for x in inc])
    for e in force_in: cnf.append([evar[tuple(sorted(e))]])
    for e in force_out: cnf.append([-evar[tuple(sorted(e))]])
    s = Glucose3(bootstrap_with=cnf)
    while True:
        if not s.solve(): return False
        model = set(l for l in s.get_model() if l > 0)
        chosen = [e for e in edges if evar[e] in model]
        nbr = {v: [] for v in range(n)}
        for a, b in chosen: nbr[a].append(b); nbr[b].append(a)
        # cycle extraction
        seen = set(); cycles = []
        for v in range(n):
            if v in seen: continue
            cyc = [v]; seen.add(v); prev, cur = None, v
            while True:
                nxt = [w for w in nbr[cur] if w != prev][0]
                if nxt == v: break
                cyc.append(nxt); seen.add(nxt); prev, cur = cur, nxt
            cycles.append(cyc)
        if len(cycles) == 1: return True
        cyc = min(cycles, key=len)
        s.add_clause([-evar[tuple(sorted((cyc[i], cyc[(i+1) % len(cyc)])))]
                      for i in range(len(cyc))])

def main():
    total_pairs = 0; failures = 0
    for path in sys.argv[1:]:
        n, adj = verify.read_graph(path)
        fs = faces(adj, n)
        graph_pairs = 0
        for face in fs:
            L = len(face)
            fedges = [tuple(sorted((face[i], face[(i+1) % L]))) for i in range(L)]
            for e1, e2 in combinations(fedges, 2):
                for a, b in ((e1, e2), (e2, e1)):
                    graph_pairs += 1
                    if not ham_with(n, adj, [a], [b]):
                        failures += 1
                        print(f"KELMANS FAILURE in {path}: no HC through {a} avoiding {b}")
        total_pairs += graph_pairs
        print(f"{path}: n={n}, {len(fs)} faces, {graph_pairs} ordered pairs tested, failures so far {failures}")
    print(f"TOTAL: {total_pairs} pairs, {failures} failures")

if __name__ == "__main__":
    main()
