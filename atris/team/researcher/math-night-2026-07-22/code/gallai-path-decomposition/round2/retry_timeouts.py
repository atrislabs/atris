#!/usr/bin/env python3
"""Retry the two CP-SAT timeouts with the pysat/Cadical engine (exact, no timeout)."""
import sys, os, time
from math import ceil
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import networkx as nx
from verify import decide_path_decomposition
from search2 import load_tight

cases = []
# case 1: K7[2] + within-part edge (2,3)
K72 = nx.convert_node_labels_to_integers(
    nx.lexicographic_product(nx.complete_graph(7), nx.empty_graph(2)))
H1 = K72.copy(); H1.add_edge(2, 3)
assert H1.number_of_edges() == 85, H1.number_of_edges()
cases.append(("K72+(2,3)", H1))
# case 2: tight#46 + universal vertex
G = load_tight()[46]
H2 = G.copy()
a = max(G.nodes()) + 1
for v in G.nodes():
    H2.add_edge(a, v)
assert H2.number_of_nodes() == 14 and H2.number_of_edges() == 86, (H2.number_of_nodes(), H2.number_of_edges())
cases.append(("t46+univ", H2))

for name, H in cases:
    n = H.number_of_nodes()
    t = ceil(n / 2)
    edges = [tuple(sorted(e)) for e in H.edges()]
    t0 = time.time()
    r = decide_path_decomposition(set(H.nodes()), edges, t)
    el = time.time() - t0
    if r is None:
        print(f"*** UNSAT *** {name} n={n} m={len(edges)} t={t} ({el:.1f}s)", flush=True)
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               f"CE_retry_{name.replace(' ','')}.txt"), 'w') as f:
            for u, v in sorted(edges):
                f.write(f"{u} {v}\n")
    else:
        print(f"{name} n={n} m={len(edges)}: decomposes into {len(r)} <= {t} paths ({el:.1f}s)", flush=True)
print("RETRY COMPLETE", flush=True)
