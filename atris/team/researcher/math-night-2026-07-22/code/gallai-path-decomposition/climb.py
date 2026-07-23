#!/usr/bin/env python3
"""Hill-climb in the space of TIGHT instances (p(G) = ceil(n/2)).

Moves: toggle a random non-edge/edge, or 2-edge swap. Accept a move if the
graph stays connected and remains tight (p = ceil(n/2), i.e. t-1 is UNSAT).
Any graph with t UNSAT is a counterexample. The walk stays on the tight
ridge, which is the boundary where a counterexample would sit.
"""
import sys, time, random, re
import networkx as nx
from math import ceil
from search import decide_cpsat, graph_summary, edges_str, save_certificate


def parse_tight_file(path):
    graphs = []
    try:
        with open(path) as f:
            for line in f:
                m = re.search(r'edges: (.+)$', line.strip())
                if not m:
                    continue
                G = nx.Graph()
                for tok in m.group(1).split('; '):
                    u, v = tok.split('-')
                    G.add_edge(int(u), int(v))
                graphs.append(G)
    except FileNotFoundError:
        pass
    return graphs


def is_tight(G, t, lim=60):
    r = decide_cpsat(G, t, time_limit=lim)
    if r is None:
        return 'CE'
    r2 = decide_cpsat(G, t - 1, time_limit=lim)
    return 'tight' if r2 is None else 'slack'


def propose(G, rng):
    H = G.copy()
    nodes = list(H.nodes())
    move = rng.random()
    if move < 0.35:
        u, v = rng.sample(nodes, 2)
        if H.has_edge(u, v):
            H.remove_edge(u, v)
        else:
            H.add_edge(u, v)
    elif move < 0.7:
        # 2-swap preserving degrees
        edges = list(H.edges())
        for _ in range(20):
            (a, b), (c, d) = rng.sample(edges, 2)
            if len({a, b, c, d}) == 4 and not H.has_edge(a, c) and not H.has_edge(b, d):
                H.remove_edge(a, b); H.remove_edge(c, d)
                H.add_edge(a, c); H.add_edge(b, d)
                break
    else:
        # add one edge and remove another
        u, v = rng.sample(nodes, 2)
        if not H.has_edge(u, v):
            H.add_edge(u, v)
        e = rng.choice(list(H.edges()))
        H.remove_edge(*e)
    if not nx.is_connected(H):
        return None
    return H


def climb(seconds, seed):
    rng = random.Random(seed)
    seeds = parse_tight_file('tight_instances.txt')
    # fallback seeds: tight families found earlier
    if not seeds:
        seeds = [nx.complete_graph(11), nx.complete_multipartite_graph(3, 3, 3, 3)]
    end = time.time() + seconds
    steps = accepted = 0
    cur = rng.choice(seeds).copy()
    t = ceil(cur.number_of_nodes() / 2)
    stale = 0
    while time.time() < end:
        steps += 1
        H = propose(cur, rng)
        if H is None:
            continue
        try:
            v = is_tight(H, t, lim=45)
        except TimeoutError:
            continue
        if v == 'CE':
            print(f"*** COUNTEREXAMPLE *** {graph_summary(H)}", flush=True)
            print(f"edges: {edges_str(H)}", flush=True)
            save_certificate(H, f"certificate_climb_{seed}.txt")
            return
        if v == 'tight':
            cur = H
            accepted += 1
            stale = 0
        else:
            stale += 1
        if stale > 40:  # restart from a random tight seed
            cur = rng.choice(seeds).copy()
            t = ceil(cur.number_of_nodes() / 2)
            stale = 0
    print(f"climb done: {steps} proposals, {accepted} tight moves accepted, no CE", flush=True)


if __name__ == '__main__':
    climb(int(sys.argv[1]), int(sys.argv[2]))
