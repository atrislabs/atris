#!/usr/bin/env python3
"""Round-2 Gallai counterexample search.

Uses the round-1 CP-SAT decision engine (search.decide_cpsat) as the SEARCH
engine.  Any UNSAT hit at t = ceil(n/2) is written as a certificate file and
must then be confirmed by ../verify.py (independent pysat/Cadical engine).

Phases:
  A: perturbations of round-1 tight instances (dist-1 exhaustive add/remove,
     random dist-2 swaps, random dist-3 triples)
  B: odd/even-degree engineering (Eulerianize by odd-vertex pairing toggles,
     apex over odd vertices, universal-vertex join for odd n)
  C: blowups + joins (K7[2], K(3,3,3,3), K(2x6) perturbations; joins of
     tight instances; K13-family surgeries)

usage: search2.py <phase A|B|C> <shard> <nshards>
"""
import sys, os, time, random, itertools
from math import ceil
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import networkx as nx
from search import decide_cpsat  # round-1 independent engine

HERE = os.path.dirname(os.path.abspath(__file__))
TIGHT = os.path.join(os.path.dirname(HERE), 'tight_instances.txt')

CALLS = 0
UNSAT_HITS = []
TIMEOUTS = 0


def load_tight():
    graphs = []
    with open(TIGHT) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            estr = line.split('edges:')[1].strip()
            edges = []
            for tok in estr.split(';'):
                u, v = tok.strip().split('-')
                edges.append((int(u), int(v)))
            G = nx.Graph(edges)
            graphs.append(G)
    return graphs


def decide(G, tag, log, time_limit=45):
    """One budgeted SAT decision at t=ceil(n/2). Returns True if UNSAT (CE!)."""
    global CALLS, TIMEOUTS
    n = G.number_of_nodes()
    t = ceil(n / 2)
    CALLS += 1
    try:
        r = decide_cpsat(G, t, time_limit=time_limit)
    except TimeoutError:
        TIMEOUTS += 1
        log(f"TIMEOUT {tag} n={n} m={G.number_of_edges()}")
        return False
    if r is None:
        fname = os.path.join(HERE, f"CE_{tag.replace(' ','_').replace('/','_')}.txt")
        with open(fname, 'w') as f:
            for u, v in sorted(tuple(sorted(e)) for e in G.edges()):
                f.write(f"{u} {v}\n")
        log(f"*** UNSAT AT GALLAI BOUND *** {tag} n={n} m={G.number_of_edges()} -> {fname}")
        UNSAT_HITS.append(fname)
        return True
    return False


def canon(G):
    """cheap iso-dedup key"""
    return nx.weisfeiler_lehman_graph_hash(G, iterations=3)


def phase_A(shard, nshards, log):
    graphs = load_tight()
    seen = set()
    rng = random.Random(1000 + shard)
    for gi, G0 in enumerate(graphs):
        if gi % nshards != shard:
            continue
        n = G0.number_of_nodes()
        nodes = sorted(G0.nodes())
        E = [tuple(sorted(e)) for e in G0.edges()]
        NE = [tuple(sorted(p)) for p in itertools.combinations(nodes, 2)
              if not G0.has_edge(*p)]
        cands = []
        # dist-1 exhaustive
        for e in E:
            H = G0.copy(); H.remove_edge(*e)
            cands.append((H, f"t{gi}-del{e}"))
        for f_ in NE:
            H = G0.copy(); H.add_edge(*f_)
            cands.append((H, f"t{gi}-add{f_}"))
        # dist-2 swaps: sample 60
        pairs = [(e, f_) for e in E for f_ in NE]
        rng.shuffle(pairs)
        for e, f_ in pairs[:60]:
            H = G0.copy(); H.remove_edge(*e); H.add_edge(*f_)
            cands.append((H, f"t{gi}-swap{e}{f_}"))
        # dist-3: sample 40 random triples of toggles
        allp = E + NE
        for _ in range(40):
            trip = rng.sample(allp, 3)
            H = G0.copy()
            for p in trip:
                if H.has_edge(*p):
                    H.remove_edge(*p)
                else:
                    H.add_edge(*p)
            cands.append((H, f"t{gi}-d3-{trip}"))
        done = 0
        for H, tag in cands:
            if not nx.is_connected(H):
                continue
            k = canon(H)
            if k in seen:
                continue
            seen.add(k)
            decide(H, tag, log)
            done += 1
        log(f"[A] tight#{gi} n={n}: {done} perturbations decided (calls so far {CALLS}, timeouts {TIMEOUTS})")


def eulerianize(G0, rng):
    """Toggle edges between paired odd vertices until all degrees even."""
    G = G0.copy()
    for _ in range(30):
        odd = [v for v in G.nodes() if G.degree(v) % 2 == 1]
        if not odd:
            break
        rng.shuffle(odd)
        u, v = odd[0], odd[1]
        if G.has_edge(u, v):
            G.remove_edge(u, v)
        else:
            G.add_edge(u, v)
    if any(G.degree(v) % 2 for v in G.nodes()) or not nx.is_connected(G):
        return None
    return G


def phase_B(shard, nshards, log):
    graphs = load_tight()
    rng = random.Random(2000 + shard)
    seen = set()
    idx = 0
    for gi, G0 in enumerate(graphs):
        n = G0.number_of_nodes()
        odd = [v for v in G0.nodes() if G0.degree(v) % 2 == 1]
        # B1: Eulerianized variants (all-even degrees = fully uncovered family)
        for k in range(6):
            idx += 1
            if idx % nshards != shard:
                continue
            H = eulerianize(G0, rng)
            if H is None:
                continue
            key = canon(H)
            if key in seen:
                continue
            seen.add(key)
            decide(H, f"B1-t{gi}-eul{k}", log)
        # B2: apex over odd vertices (keeps them odd->even, new vtx deg=|odd|)
        idx += 1
        if idx % nshards == shard and odd:
            H = G0.copy()
            a = max(G0.nodes()) + 1
            for v in odd:
                H.add_edge(a, v)
            decide(H, f"B2-t{gi}-apexodd", log)
        # B3: universal vertex join (esp. odd n: bound stays)
        idx += 1
        if idx % nshards == shard:
            H = G0.copy()
            a = max(G0.nodes()) + 1
            for v in G0.nodes():
                H.add_edge(a, v)
            decide(H, f"B3-t{gi}-univ", log)
        # B4: two universal vertices for n<=11 (n+2 <= 13, bound +1)
        idx += 1
        if idx % nshards == shard and n <= 11:
            H = G0.copy()
            a, b = max(G0.nodes()) + 1, max(G0.nodes()) + 2
            for v in G0.nodes():
                H.add_edge(a, v); H.add_edge(b, v)
            H.add_edge(a, b)
            decide(H, f"B4-t{gi}-univ2", log)
    log(f"[B] done. calls {CALLS} timeouts {TIMEOUTS}")


def phase_C(shard, nshards, log):
    rng = random.Random(3000 + shard)
    cands = []
    # C1: K7[2] (n=14 tight) single-edge perturbations
    K72 = nx.convert_node_labels_to_integers(
        nx.lexicographic_product(nx.complete_graph(7), nx.empty_graph(2)))
    E = [tuple(sorted(e)) for e in K72.edges()]
    NE = [tuple(sorted(p)) for p in itertools.combinations(sorted(K72.nodes()), 2)
          if not K72.has_edge(*p)]
    for f_ in NE:
        H = K72.copy(); H.add_edge(*f_)
        cands.append((H, f"C1-K72+{f_}"))
    for e in rng.sample(E, 30):
        H = K72.copy(); H.remove_edge(*e)
        cands.append((H, f"C1-K72-{e}"))
    # C2: K(3,3,3,3) and K(2x6) perturbations (n=12 tight)
    for name, G0 in [("K3333", nx.complete_multipartite_graph(3, 3, 3, 3)),
                     ("K2x6", nx.complete_multipartite_graph(2, 2, 2, 2, 2, 2))]:
        G0 = nx.convert_node_labels_to_integers(G0)
        E0 = [tuple(sorted(e)) for e in G0.edges()]
        NE0 = [tuple(sorted(p)) for p in itertools.combinations(sorted(G0.nodes()), 2)
               if not G0.has_edge(*p)]
        for f_ in NE0:
            H = G0.copy(); H.add_edge(*f_)
            cands.append((H, f"C2-{name}+{f_}"))
        for e in E0:
            H = G0.copy(); H.remove_edge(*e)
            cands.append((H, f"C2-{name}-{e}"))
        for e, f_ in [(rng.choice(E0), rng.choice(NE0)) for _ in range(40)]:
            H = G0.copy()
            H.remove_edge(*e)
            if not H.has_edge(*f_):
                H.add_edge(*f_)
                cands.append((H, f"C2-{name}~{e}{f_}"))
    # C3: complement of C5[2] perturbations (n=10 tight)
    C52c = nx.complement(nx.convert_node_labels_to_integers(
        nx.lexicographic_product(nx.cycle_graph(5), nx.empty_graph(2))))
    E0 = [tuple(sorted(e)) for e in C52c.edges()]
    NE0 = [tuple(sorted(p)) for p in itertools.combinations(sorted(C52c.nodes()), 2)
           if not C52c.has_edge(*p)]
    for f_ in NE0:
        H = C52c.copy(); H.add_edge(*f_)
        cands.append((H, f"C3-cC52+{f_}"))
    for e in E0:
        H = C52c.copy(); H.remove_edge(*e)
        cands.append((H, f"C3-cC52-{e}"))
    # C4: joins of small tight instances / cliques, n<=13
    graphs = load_tight()
    small = [G for G in graphs if G.number_of_nodes() == 10][:4]
    joins = []
    for G0 in small:
        # join with K3 -> n=13, bound 7 (manual join: disjoint labels + all cross edges)
        A = nx.convert_node_labels_to_integers(G0)
        base = A.number_of_nodes()
        J = A.copy()
        for i in range(3):
            J.add_node(base + i)
        for i in range(3):
            for j in range(i + 1, 3):
                J.add_edge(base + i, base + j)
            for v in range(base):
                J.add_edge(base + i, v)
        joins.append(J)
    for i, J in enumerate(joins):
        cands.append((J, f"C4-join10K3-{i}"))
    # C5: K13 surgeries: remove small structured subgraphs
    K13 = nx.complete_graph(13)
    for k, name in [(nx.cycle_graph(13), 'C13'), (nx.cycle_graph(6), 'C6'),
                    (nx.complete_graph(4), 'K4'), (nx.star_graph(5), 'S5')]:
        H = K13.copy()
        H.remove_edges_from(k.edges())
        if nx.is_connected(H):
            cands.append((H, f"C5-K13-{name}"))
    for trial in range(25):
        H = K13.copy()
        rem = rng.sample(list(H.edges()), rng.randrange(2, 9))
        H.remove_edges_from(rem)
        if nx.is_connected(H):
            cands.append((H, f"C5-K13-rand{trial}"))
    # C6: odd blowups C7[2] complement-ish and K9 minus perfect-matching-like at n=13,14
    K14 = nx.complete_graph(14)
    M = [(2 * i, 2 * i + 1) for i in range(7)]
    H = K14.copy(); H.remove_edges_from(M)
    cands.append((H, "C6-K14-M"))
    H2 = K14.copy(); H2.remove_edges_from(nx.cycle_graph(14).edges())
    cands.append((H2, "C6-K14-C14"))

    seen = set()
    done = 0
    for i, (H, tag) in enumerate(cands):
        if i % nshards != shard:
            continue
        if not nx.is_connected(H):
            continue
        k = canon(H)
        if k in seen:
            continue
        seen.add(k)
        tl = 90 if H.number_of_nodes() >= 13 else 45
        decide(H, tag, log, time_limit=tl)
        done += 1
        if done % 20 == 0:
            log(f"[C] {done} decided, calls {CALLS}, timeouts {TIMEOUTS}")
    log(f"[C] done. decided {done}, calls {CALLS}, timeouts {TIMEOUTS}")


def main():
    phase, shard, nshards = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    t0 = time.time()

    def log(msg):
        print(f"[{time.time()-t0:7.1f}s] {msg}", flush=True)
    if phase == 'A':
        phase_A(shard, nshards, log)
    elif phase == 'B':
        phase_B(shard, nshards, log)
    elif phase == 'C':
        phase_C(shard, nshards, log)
    log(f"PHASE {phase} SHARD {shard}/{nshards} COMPLETE: "
        f"{CALLS} SAT calls, {TIMEOUTS} timeouts, {len(UNSAT_HITS)} UNSAT hits")
    for h in UNSAT_HITS:
        log(f"HIT: {h}")


if __name__ == '__main__':
    main()
