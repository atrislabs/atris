#!/usr/bin/env python3
"""Search for counterexamples to Gallai's path decomposition conjecture.

Engine: OR-tools CP-SAT (independent of verify.py's pysat engine).
decide(G, t): does a decomposition of E(G) into <= t simple paths exist?
Model: color each edge with one of t colors; per color: degree <= 2 at every
vertex, and |E_c| = |V_c| - nonempty_c (forces exactly one path component
once monochromatic cycles are eliminated by lazy cycle cuts, which are
globally valid).
"""
import sys, time, random, itertools
from math import ceil
import networkx as nx
from ortools.sat.python import cp_model


def components_of(edge_list):
    adj = {}
    for u, v in edge_list:
        adj.setdefault(u, []).append(v)
        adj.setdefault(v, []).append(u)
    seen, comps = set(), []
    for s in adj:
        if s in seen: continue
        stack, cv = [s], {s}
        seen.add(s)
        while stack:
            x = stack.pop()
            for y2 in adj[x]:
                if y2 not in seen:
                    seen.add(y2); cv.add(y2); stack.append(y2)
        ce = [(u, v) for (u, v) in edge_list if u in cv]
        comps.append((cv, ce))
    return comps


def decide_cpsat(G, t, time_limit=120):
    """Return decomposition (list of edge-lists) or None (proved UNSAT).
    Raises TimeoutError on solver timeout."""
    edges = [tuple(sorted(e)) for e in G.edges()]
    verts = sorted(G.nodes())
    m, n = len(edges), len(verts)
    eidx = {e: i for i, e in enumerate(edges)}
    banned_cycles = []  # list of edge-index-lists; no color may contain all
    deadline = time.time() + time_limit
    while True:
        model = cp_model.CpModel()
        y = [[model.NewBoolVar(f'y{e}_{c}') for c in range(t)] for e in range(m)]
        for e in range(m):
            model.AddExactlyOne(y[e])
        used = {}
        ne = []
        for c in range(t):
            ne_c = model.NewBoolVar(f'ne{c}')
            ne.append(ne_c)
            model.AddMaxEquality(ne_c, [y[e][c] for e in range(m)])
            vc_terms = []
            for v in verts:
                inc = [eidx[tuple(sorted((v, w)))] for w in G.neighbors(v)]
                model.Add(sum(y[e][c] for e in inc) <= 2)
                uv = model.NewBoolVar(f'u{v}_{c}')
                model.AddMaxEquality(uv, [y[e][c] for e in inc])
                vc_terms.append(uv)
            # E_c = V_c - nonempty_c
            model.Add(sum(y[e][c] for e in range(m)) ==
                      sum(vc_terms) - ne_c)
        # symmetry: class sizes nonincreasing (valid: relabel colors)
        for c in range(t - 1):
            model.Add(sum(y[e][c] for e in range(m)) >=
                      sum(y[e][c + 1] for e in range(m)))
        for cyc in banned_cycles:
            for c in range(t):
                model.AddBoolOr([y[e][c].Not() for e in cyc])
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = max(1.0, deadline - time.time())
        solver.parameters.num_search_workers = 4
        status = solver.Solve(model)
        if status == cp_model.INFEASIBLE:
            return None
        if status != cp_model.OPTIMAL and status != cp_model.FEASIBLE:
            raise TimeoutError(f"cpsat status {status}")
        classes = [[] for _ in range(t)]
        for e in range(m):
            for c in range(t):
                if solver.Value(y[e][c]):
                    classes[c].append(edges[e]); break
        new_cuts = 0
        for c in range(t):
            for cv, ce in components_of(classes[c]):
                if len(ce) >= len(cv):
                    banned_cycles.append([eidx[e] for e in ce])
                    new_cuts += 1
        if new_cuts == 0:
            return [cl for cl in classes if cl]


def path_number_bounds(G):
    odd = sum(1 for v in G.nodes() if G.degree(v) % 2 == 1)
    lb = max(1, odd // 2, max((ceil(G.degree(v) / 2) for v in G.nodes()), default=1))
    return lb


def exact_path_number(G, time_limit=300):
    """Exact minimum path decomposition size."""
    lb = path_number_bounds(G)
    t = lb
    while True:
        r = decide_cpsat(G, t, time_limit=time_limit)
        if r is not None:
            return t, r
        t += 1


def gallai_margin(G, time_limit=120):
    """Return (p(G) info). We only need: does decomposition into ceil(n/2) exist?
    Returns ('CE', None) if counterexample, ('tight', p) if p == bound,
    ('slack', p_upper_evidence) otherwise (p < bound)."""
    n = G.number_of_nodes()
    t = ceil(n / 2)
    r = decide_cpsat(G, t, time_limit=time_limit)
    if r is None:
        return ('CE', t)
    # check tightness: does t-1 work?
    if t - 1 >= 1:
        r2 = decide_cpsat(G, t - 1, time_limit=time_limit)
        if r2 is None:
            return ('tight', t)
    return ('slack', t)


def interesting_filter(G):
    """Known-proved classes excluded: keep only graphs that could be
    counterexamples given published results."""
    if max(dict(G.degree()).values()) <= 5:
        return False
    if nx.check_planarity(G)[0]:
        return False
    ev = [v for v in G.nodes() if G.degree(v) % 2 == 0]
    H = G.subgraph(ev)
    # E-subgraph must contain a cycle (not a forest)
    if H.number_of_edges() < H.number_of_nodes() - nx.number_connected_components(H) + 1:
        # forest check: forest iff m == n - c
        if H.number_of_edges() == H.number_of_nodes() - nx.number_connected_components(H):
            return False
    return True


def graph_summary(G):
    return f"n={G.number_of_nodes()} m={G.number_of_edges()} degs={sorted(dict(G.degree()).values())}"


def edges_str(G):
    return "; ".join(f"{u}-{v}" for u, v in sorted(tuple(sorted(e)) for e in G.edges()))


def save_certificate(G, fname):
    with open(fname, 'w') as f:
        for u, v in sorted(tuple(sorted(e)) for e in G.edges()):
            f.write(f"{u} {v}\n")


def run_family_sweep(log):
    """Structured families with extremal pressure."""
    cands = []
    # complete graphs (known tight) and perturbations
    for n in range(9, 15):
        cands.append((f"K{n}", nx.complete_graph(n)))
        Km = nx.complete_graph(n)
        Km.remove_edges_from([(2 * i, 2 * i + 1) for i in range(n // 2)])
        cands.append((f"K{n}-M", Km))
        Kh = nx.complete_graph(n)
        Kh.remove_edges_from([(i, (i + 1) % n) for i in range(n)])
        cands.append((f"K{n}-C{n}", Kh))
    # complete bipartite / multipartite
    for a, b in [(5, 5), (6, 6), (5, 6), (6, 7), (7, 7), (4, 8), (6, 8)]:
        cands.append((f"K{a},{b}", nx.complete_bipartite_graph(a, b)))
    for parts in [(4, 4, 4), (3, 3, 3, 3), (5, 5, 5), (2, 2, 2, 2, 2, 2), (4, 4, 4, 4)]:
        cands.append((f"K{parts}", nx.complete_multipartite_graph(*parts)))
    # circulants degree 6-8, n = 10..16 (Eulerian, vertex-transitive)
    for n in range(10, 17):
        for k in range(3, 5):
            for S in itertools.combinations(range(1, n // 2 + 1), k):
                if len(cands) > 4000: break
                G = nx.circulant_graph(n, S)
                if nx.is_connected(G) and min(dict(G.degree()).values()) >= 6:
                    cands.append((f"C{n}{S}", G))
    # blowups: G[2] lexicographic with empty 2-sets
    for base_name, base in [("C5", nx.cycle_graph(5)), ("K4", nx.complete_graph(4)),
                            ("Petersen", nx.petersen_graph()), ("K5", nx.complete_graph(5)),
                            ("C7", nx.cycle_graph(7)), ("K33", nx.complete_bipartite_graph(3, 3))]:
        for b in (2, 3):
            G = nx.lexicographic_product(base, nx.empty_graph(b))
            G = nx.convert_node_labels_to_integers(G)
            if G.number_of_nodes() <= 16:
                cands.append((f"{base_name}[{b}]", G))
    # named graphs
    cands.append(("Q4", nx.hypercube_graph(4)))
    cands.append(("K5xK3", nx.convert_node_labels_to_integers(
        nx.cartesian_product(nx.complete_graph(5), nx.complete_graph(3)))))
    cands.append(("compl-Petersen", nx.complement(nx.petersen_graph())))
    cands.append(("triangular-T6", nx.line_graph(nx.complete_graph(6))))
    cands.append(("Clebsch", nx.convert_node_labels_to_integers(
        nx.circulant_graph(16, [1, 3, 7]))))  # placeholder circulant, still Eulerian-ish

    seen_results = []
    for name, G in cands:
        G = nx.convert_node_labels_to_integers(G)
        if not nx.is_connected(G) or G.number_of_nodes() > 16:
            continue
        n = G.number_of_nodes()
        t = ceil(n / 2)
        try:
            start = time.time()
            r = decide_cpsat(G, t, time_limit=180)
            el = time.time() - start
        except TimeoutError:
            log(f"[family] {name} {graph_summary(G)} TIMEOUT at t={t}")
            continue
        if r is None:
            log(f"[family] *** COUNTEREXAMPLE *** {name} {graph_summary(G)}")
            save_certificate(G, f"certificate_{name}.txt")
            seen_results.append((name, 'CE'))
        else:
            # tightness probe
            tightness = ''
            try:
                r2 = decide_cpsat(G, t - 1, time_limit=60) if t > 1 else True
                tightness = 'TIGHT p=%d' % t if r2 is None else 'slack'
            except TimeoutError:
                tightness = 'tight? (t-1 timeout)'
            log(f"[family] {name} {graph_summary(G)} decomposes at t={t} ({tightness}) {el:.1f}s")
            seen_results.append((name, tightness))
    return seen_results


def random_even_graph(n, rng):
    """Random connected graph with all degrees even and >= 6 somewhere: take
    random graph, then fix parity by adding a T-join-ish set of edges."""
    p = rng.uniform(0.45, 0.85)
    G = nx.gnp_random_graph(n, p, seed=rng.randrange(1 << 30))
    if not nx.is_connected(G):
        return None
    odd = [v for v in G.nodes() if G.degree(v) % 2 == 1]
    rng.shuffle(odd)
    for i in range(0, len(odd) - 1, 2):
        u, v = odd[i], odd[i + 1]
        if G.has_edge(u, v):
            G.remove_edge(u, v)
        else:
            G.add_edge(u, v)
    if not nx.is_connected(G):
        return None
    if any(G.degree(v) % 2 for v in G.nodes()):
        return None
    return G


def run_random_sweep(log, seconds, seed=0, nmin=10, nmax=13):
    rng = random.Random(seed)
    t_end = time.time() + seconds
    tried = tight = 0
    while time.time() < t_end:
        n = rng.randrange(nmin, nmax + 1)
        mode = rng.random()
        if mode < 0.6:
            G = random_even_graph(n, rng)
        else:
            G = nx.gnp_random_graph(n, rng.uniform(0.4, 0.9), seed=rng.randrange(1 << 30))
            if not nx.is_connected(G):
                G = None
        if G is None or not interesting_filter(G):
            continue
        tried += 1
        t = ceil(n / 2)
        try:
            r = decide_cpsat(G, t, time_limit=90)
        except TimeoutError:
            log(f"[random] TIMEOUT {graph_summary(G)} edges: {edges_str(G)}")
            continue
        if r is None:
            log(f"[random] *** COUNTEREXAMPLE *** {graph_summary(G)}")
            log(f"  edges: {edges_str(G)}")
            save_certificate(G, "certificate_random.txt")
        else:
            try:
                r2 = decide_cpsat(G, t - 1, time_limit=45)
                if r2 is None:
                    tight += 1
                    log(f"[random] TIGHT p={t} {graph_summary(G)}")
                    with open('tight_instances.txt', 'a') as f:
                        f.write(f"n={n} p={t} edges: {edges_str(G)}\n")
            except TimeoutError:
                pass
    log(f"[random] tried {tried} filtered graphs, {tight} tight")


if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else 'family'
    def log(msg):
        print(msg, flush=True)
    if mode == 'family':
        run_family_sweep(log)
    elif mode == 'random':
        secs = int(sys.argv[2]) if len(sys.argv) > 2 else 600
        seed = int(sys.argv[3]) if len(sys.argv) > 3 else 1
        run_random_sweep(log, secs, seed=seed)
