#!/usr/bin/env python3
"""Scan structured families for small min(s+,s-)-(n-1) margins."""
import itertools, random
import numpy as np
import networkx as nx

def marg(G):
    n = G.number_of_nodes()
    ev = np.linalg.eigvalsh(nx.to_numpy_array(G))
    sp = float(np.sum(np.where(ev > 1e-9, ev, 0.0)**2))
    sm = float(np.sum(np.where(ev < -1e-9, ev, 0.0)**2))
    return sp-(n-1), sm-(n-1), n

best = []
def rec(name, G):
    if G.number_of_nodes() < 3 or not nx.is_connected(G): return
    mp, mm, n = marg(G)
    m = min(mp, mm)
    best.append((m, mp, mm, n, name))

rng = random.Random(7)
# circulants: n up to 24, random connection sets + all sets for n<=13
for n in range(5, 14):
    ks = list(range(1, n//2+1))
    for r in range(1, len(ks)+1):
        for S in itertools.combinations(ks, r):
            rec(f'circ({n},{S})', nx.circulant_graph(n, S))
for n in range(14, 33):
    ks = list(range(1, n//2+1))
    for _ in range(150):
        S = tuple(sorted(rng.sample(ks, rng.randrange(1, min(6, len(ks))+1))))
        rec(f'circ({n},{S})', nx.circulant_graph(n, S))
# kneser
for m in range(5, 12):
    for k in range(2, m//2+1):
        G = nx.kneser_graph(m, k)
        if G.number_of_nodes() <= 500: rec(f'kneser({m},{k})', G)
# complete multipartite: all partitions of n<=16
def parts(n, mx=None):
    if n == 0: yield []
    for i in range(min(n, mx or n), 0, -1):
        for p in parts(n-i, i): yield [i]+p
for n in range(3, 17):
    for p in parts(n):
        if len(p) >= 2: rec(f'K{p}', nx.complete_multipartite_graph(*p))
# complements of trees, random graphs' complements
for n in range(6, 34, 2):
    for _ in range(30):
        T = nx.random_labeled_tree(n)
        rec(f'cotree(n={n})', nx.complement(T))
# wheels, books, friendship, cones over cycles
for n in range(4, 40):
    rec(f'wheel({n})', nx.wheel_graph(n))
for k in range(2, 20):
    G = nx.windmill_graph(k, 3); rec(f'friendship({k})', G)
# blowups of C5 and Petersen (balanced)
def blowup(G, t):
    return nx.complement(nx.tensor_product(nx.complement(G), nx.complete_graph(t))) if False else nx.Graph(
        ((u,i),(v,j)) for u,v in G.edges() for i in range(t) for j in range(t))
for t in range(1, 7):
    rec(f'C5[{t}]', blowup(nx.cycle_graph(5), t))
for t in range(1, 4):
    rec(f'Pet[{t}]', blowup(nx.petersen_graph(), t))
# line graphs of random graphs
for n in range(6, 16):
    for _ in range(20):
        G = nx.gnp_random_graph(n, rng.uniform(0.2, 0.7), seed=rng.randrange(1<<30))
        if nx.is_connected(G):
            L = nx.line_graph(G)
            if 3 <= L.number_of_nodes() <= 60: rec(f'line(G({n}))', L)
# strongly-regular-ish: Paley graphs
for q in [5, 9, 13, 17, 25, 29, 37, 41]:
    try: rec(f'paley({q})', nx.paley_graph(q))
    except Exception: pass

best.sort()
print('tightest 25 (min margin, s+ margin, s- margin, n, name):')
for m, mp, mm, n, name in best[:25]:
    print(f'  {m:+.6e}  s+m={mp:+.4e} s-m={mm:+.4e} n={n:3d}  {name}')
neg = [b for b in best if b[0] < -1e-7]
print('violations:', len(neg))
