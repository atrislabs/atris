#!/usr/bin/env python3
"""
Counterexample search for Hajos' conjecture (cycle decompositions of Eulerian
graphs): find simple connected even-degree G on n=13..16 vertices with min
cycle decomposition size > floor((n-1)/2).

Pipeline per candidate graph:
  1. cheap randomized heuristic (Posa long-cycle peeling + Eulerian-circuit
     splitting) tries to exhibit a decomposition into <= t cycles;
  2. survivors escalate to exact CP-SAT decision (t cycle slots, AddCircuit);
  3. CP-SAT INFEASIBLE => counterexample; save certificate.

Usage: search.py <phase> [options]   phases: complements, circulants,
       random, hillclimb, regular
"""
import argparse
import itertools
import json
import os
import random
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results.jsonl")


# ---------------- graph utilities (adjacency-set representation) ----------
def edges_of(adj):
    return sorted((u, v) for u in adj for v in adj[u] if u < v)


def make_adj(n, edges):
    adj = {i: set() for i in range(n)}
    for u, v in edges:
        adj[u].add(v)
        adj[v].add(u)
    return adj


def connected(adj):
    verts = [v for v in adj if adj[v]]
    if not verts:
        return False
    seen = {verts[0]}
    st = [verts[0]]
    while st:
        x = st.pop()
        for y in adj[x]:
            if y not in seen:
                seen.add(y)
                st.append(y)
    return len(seen) == len(verts)


# ---------------- heuristic decomposition --------------------------------
def posa_long_cycle(adj, rng, tries=4):
    """Find a long cycle in the graph given by adj (on active vertices)
    using random greedy path growth + Posa rotations. Returns list of edges
    or None."""
    active = [v for v in adj if adj[v]]
    if not active:
        return None
    best = None
    for _ in range(tries):
        start = rng.choice(active)
        path = [start]
        inpath = {start}
        for _step in range(4 * len(active) * len(active)):
            end = path[-1]
            exts = [y for y in adj[end] if y not in inpath]
            if exts:
                y = rng.choice(exts)
                path.append(y)
                inpath.add(y)
                continue
            # try to close cycle
            if len(path) >= 3 and path[0] in adj[end]:
                cyc = path[:]
                if best is None or len(cyc) > len(best):
                    best = cyc
                break
            # rotate: end adjacent to some path[i], reverse path[i+1:]
            nbrs = [i for i in range(len(path) - 2) if path[i] in adj[end]]
            if not nbrs:
                break
            i = rng.choice(nbrs)
            path[i + 1:] = reversed(path[i + 1:])
        else:
            pass
        if best is not None and len(best) == len(active):
            break
    if best is None:
        return None
    return [(best[i], best[(i + 1) % len(best)]) for i in range(len(best))]


def euler_split(adj, rng):
    """Random Eulerian circuit per component, split into simple cycles.
    Returns list of cycles (each list of edges). Assumes all degrees even."""
    local = {v: list(adj[v]) for v in adj}
    for v in local:
        rng.shuffle(local[v])
    used = set()
    cycles = []
    for comp_start in list(adj):
        if not any((comp_start, y) not in used and (y, comp_start) not in used
                   for y in adj[comp_start]):
            continue
        # Hierholzer from comp_start over unused edges
        stack = [comp_start]
        circuit = []
        ptr = {v: 0 for v in local}
        while stack:
            x = stack[-1]
            found = False
            while ptr[x] < len(local[x]):
                y = local[x][ptr[x]]
                ptr[x] += 1
                ekey = (min(x, y), max(x, y))
                if ekey in used:
                    continue
                used.add(ekey)
                stack.append(y)
                found = True
                break
            if not found:
                circuit.append(stack.pop())
        circuit.reverse()
        # split circuit (vertex seq, consecutive = edges) into simple cycles
        pos = {}
        pathv = []
        for v in circuit:
            if v in pos:
                i = pos[v]
                cyc = pathv[i:] + [v]
                if len(cyc) >= 4:  # cycle with >=3 edges
                    cycles.append([(cyc[j], cyc[j + 1]) for j in range(len(cyc) - 1)])
                elif len(cyc) == 3:
                    cycles.append([(cyc[0], cyc[1]), (cyc[1], cyc[2])])  # shouldn't happen (2-cycle)
                for w in pathv[i + 1:]:
                    pos.pop(w, None)
                pathv = pathv[:i + 1]
            else:
                pos[v] = len(pathv)
                pathv.append(v)
    return cycles


def heuristic_leq_t(n, edges, t, rng, restarts=40):
    """Try to exhibit a decomposition into <= t cycles. Returns best count."""
    best = 10 ** 9
    for r in range(restarts):
        adj = make_adj(n, edges)
        count = 0
        # peel long cycles while dense-ish
        while True:
            m_rem = sum(len(adj[v]) for v in adj) // 2
            if m_rem == 0:
                break
            maxdeg = max(len(adj[v]) for v in adj)
            if maxdeg <= 2 or count > t:
                # finish with euler split
                cycles = euler_split(adj, rng)
                count += len(cycles)
                break
            cyc = posa_long_cycle(adj, rng)
            if cyc is None:
                cycles = euler_split(adj, rng)
                count += len(cycles)
                break
            for (u, v) in cyc:
                adj[u].discard(v)
                adj[v].discard(u)
            count += 1
        best = min(best, count)
        if best <= t:
            return best
    return best


# ---------------- exact CP-SAT decision ----------------------------------
def cpsat_leq_t(n, edges, t, timeout=120):
    from ortools.sat.python import cp_model
    m = len(edges)
    model = cp_model.CpModel()
    x = {}
    for s in range(t):
        arcs = []
        for i, (u, v) in enumerate(edges):
            a = model.NewBoolVar(f"a{s}_{i}")
            b = model.NewBoolVar(f"b{s}_{i}")
            arcs.append((u, v, a))
            arcs.append((v, u, b))
            xe = model.NewBoolVar(f"x{s}_{i}")
            model.Add(a + b == 1).OnlyEnforceIf(xe)
            model.Add(a + b == 0).OnlyEnforceIf(xe.Not())
            x[(s, i)] = xe
        for vtx in range(n):
            arcs.append((vtx, vtx, model.NewBoolVar(f"l{s}_{vtx}")))
        model.AddCircuit(arcs)
    for i in range(m):
        model.Add(sum(x[(s, i)] for s in range(t)) == 1)
    # symmetry breaking: edge 0 in slot 0; slot s+1 empty if slot s empty;
    # first-edge ordering across slots
    model.Add(x[(0, 0)] == 1)
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = timeout
    solver.parameters.num_search_workers = 8
    st = solver.Solve(model)
    if st in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return "SAT"
    if st == cp_model.INFEASIBLE:
        return "UNSAT"
    return "UNKNOWN"


# ---------------- candidate handling --------------------------------------
def log_result(rec):
    with open(RESULTS, "a") as f:
        f.write(json.dumps(rec) + "\n")


def process(n, edges, t, tag, rng, restarts=40, cpsat_timeout=120,
            stats=None):
    """Returns heuristic best count; escalates to CP-SAT if heuristic > t."""
    best = heuristic_leq_t(n, edges, t, rng, restarts=restarts)
    if stats is not None:
        stats["tested"] += 1
    if best <= t:
        return best
    # survivor: escalate
    res = cpsat_leq_t(n, edges, t, timeout=cpsat_timeout)
    rec = {"tag": tag, "n": n, "m": len(edges), "t": t,
           "heuristic_best": best, "cpsat": res, "edges": edges,
           "time": time.time()}
    log_result(rec)
    if res == "UNSAT":
        path = os.path.join(HERE, "certificate.txt")
        with open(path, "w") as f:
            f.write(f"# COUNTEREXAMPLE candidate tag={tag} n={n} m={len(edges)} t={t}\n")
            for u, v in edges:
                f.write(f"{u} {v}\n")
        print(f"\n*** UNSAT at t={t}! candidate counterexample saved: {path} tag={tag}\n",
              flush=True)
        sys.exit(42)
    elif res == "SAT":
        # tight-ish instance: heuristic failed but exact says feasible
        if stats is not None:
            stats["tight"] += 1
        print(f"  [tight] {tag}: heuristic {best} > t={t} but CP-SAT SAT", flush=True)
    else:
        print(f"  [UNKNOWN] {tag}: heuristic {best} > t={t}, CP-SAT timeout -- NEEDS LONGER RUN",
              flush=True)
    return best


# ---------------- phases ---------------------------------------------------
def sparse_even_graphs(n, extra_budget, rng):
    """Random sparse even graph H on subset of [n]: union of random cycles,
    XORed together. Returns edge set (may be empty)."""
    E = set()
    for _ in range(extra_budget):
        k = rng.randint(3, n)
        verts = rng.sample(range(n), k)
        for i in range(k):
            u, v = verts[i], verts[(i + 1) % k]
            e = (min(u, v), max(u, v))
            if e in E:
                E.discard(e)
            else:
                E.add(e)
    return E


def phase_complements(args, rng):
    """G = K_n - H for sparse even H, n odd (13,15): complement of even graph
    on odd n is even. Also K_n - PM - H for even n (14,16)."""
    stats = {"tested": 0, "tight": 0}
    deadline = time.time() + args.minutes * 60
    it = 0
    while time.time() < deadline:
        it += 1
        n = rng.choice(args.ns)
        t = (n - 1) // 2
        base = {(u, v) for u, v in itertools.combinations(range(n), 2)}
        if n % 2 == 0:
            pm = {(2 * i, 2 * i + 1) for i in range(n // 2)}
            base -= pm
        H = sparse_even_graphs(n, rng.randint(1, 4), rng)
        edges = sorted(base - H)
        # require H subset of base (edges we removed must have existed);
        # XOR construction may re-add pm edges -> parity break. recompute:
        adj = make_adj(n, edges)
        if any(len(adj[v]) % 2 for v in adj):
            continue
        if any(len(adj[v]) < 6 for v in adj):
            continue
        if not connected(adj):
            continue
        process(n, edges, t, f"compl-{n}-{it}", rng,
                restarts=args.restarts, cpsat_timeout=args.cpsat_timeout,
                stats=stats)
        if it % 50 == 0:
            print(f"[complements] it={it} tested={stats['tested']} tight={stats['tight']}",
                  flush=True)
    print(f"[complements] done: {stats}", flush=True)


def phase_circulants(args, rng):
    stats = {"tested": 0, "tight": 0}
    for n in args.ns:
        t = (n - 1) // 2
        half = n // 2
        conns = list(range(1, half + 1))
        for r in range(1, len(conns) + 1):
            for S in itertools.combinations(conns, r):
                # degree: 2*|S'| where wrap connection n/2 contributes 1
                deg = sum(1 if (n % 2 == 0 and s == half) else 2 for s in S)
                if deg % 2 or deg < 6:
                    continue
                edges = set()
                for v in range(n):
                    for s in S:
                        u = (v + s) % n
                        edges.add((min(v, u), max(v, u)))
                edges = sorted(edges)
                adj = make_adj(n, edges)
                if not connected(adj):
                    continue
                process(n, edges, t, f"circ-{n}-{S}", rng,
                        restarts=args.restarts, cpsat_timeout=args.cpsat_timeout,
                        stats=stats)
        print(f"[circulants] n={n} done: {stats}", flush=True)
    print(f"[circulants] done: {stats}", flush=True)


def phase_random(args, rng):
    """Random even graphs with degrees in [6, n-1], mixed density."""
    import networkx as nx
    stats = {"tested": 0, "tight": 0}
    deadline = time.time() + args.minutes * 60
    it = 0
    while time.time() < deadline:
        it += 1
        n = rng.choice(args.ns)
        t = (n - 1) // 2
        mode = rng.random()
        if mode < 0.5:
            d = rng.choice([d for d in (6, 8, 10, 12) if d < n])
            try:
                G = nx.random_regular_graph(d, n, seed=rng.randint(0, 10 ** 9))
            except nx.NetworkXError:
                continue
            edges = sorted((min(u, v), max(u, v)) for u, v in G.edges())
        else:
            # random even graph: XOR of many random cycles on all n vertices
            E = sparse_even_graphs(n, rng.randint(6, 14), rng)
            edges = sorted(E)
        adj = make_adj(n, edges) if edges else None
        if not edges or not connected(adj):
            continue
        if any(len(adj[v]) % 2 for v in adj):
            continue
        if any(len(adj[v]) < 6 for v in adj):
            continue
        process(n, edges, t, f"rand-{n}-{it}", rng,
                restarts=args.restarts, cpsat_timeout=args.cpsat_timeout,
                stats=stats)
        if it % 100 == 0:
            print(f"[random] it={it} tested={stats['tested']} tight={stats['tight']}",
                  flush=True)
    print(f"[random] done: {stats}", flush=True)


def phase_hillclimb(args, rng):
    """Local search maximizing heuristic hardness (best heuristic count)."""
    stats = {"tested": 0, "tight": 0}
    deadline = time.time() + args.minutes * 60
    restart_num = 0
    while time.time() < deadline:
        restart_num += 1
        n = rng.choice(args.ns)
        t = (n - 1) // 2
        # start from a dense complement-type graph
        base = {(u, v) for u, v in itertools.combinations(range(n), 2)}
        if n % 2 == 0:
            base -= {(2 * i, 2 * i + 1) for i in range(n // 2)}
        H = sparse_even_graphs(n, 2, rng)
        cur = sorted(base - H)
        adj = make_adj(n, cur)
        if any(len(adj[v]) % 2 for v in adj) or not connected(adj):
            continue
        cur_score = heuristic_leq_t(n, cur, t, rng, restarts=args.restarts)
        steps = 0
        while steps < args.steps and time.time() < deadline:
            steps += 1
            # move: XOR a random triangle
            a, b, c = rng.sample(range(n), 3)
            tri = [(min(a, b), max(a, b)), (min(b, c), max(b, c)),
                   (min(a, c), max(a, c))]
            E = set(cur)
            for e in tri:
                if e in E:
                    E.discard(e)
                else:
                    E.add(e)
            new = sorted(E)
            adj = make_adj(n, new)
            if any(len(adj[v]) < 6 for v in adj) or not connected(adj):
                continue
            sc = heuristic_leq_t(n, new, t, rng, restarts=args.restarts)
            if sc >= cur_score:
                cur, cur_score = new, sc
            if cur_score > t:
                process(n, cur, t, f"hill-{n}-r{restart_num}s{steps}", rng,
                        restarts=3 * args.restarts,
                        cpsat_timeout=args.cpsat_timeout, stats=stats)
                # after exact resolution, keep climbing from here
        print(f"[hillclimb] restart {restart_num} n={n} final_score={cur_score} (t={t})",
              flush=True)
    print(f"[hillclimb] done: {stats}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("phase", choices=["complements", "circulants", "random",
                                      "hillclimb"])
    ap.add_argument("--ns", type=int, nargs="+", default=[13, 14, 15, 16])
    ap.add_argument("--minutes", type=float, default=10)
    ap.add_argument("--restarts", type=int, default=40)
    ap.add_argument("--steps", type=int, default=200)
    ap.add_argument("--cpsat-timeout", type=float, default=120)
    ap.add_argument("--seed", type=int, default=None)
    args = ap.parse_args()
    rng = random.Random(args.seed)
    {"complements": phase_complements, "circulants": phase_circulants,
     "random": phase_random, "hillclimb": phase_hillclimb}[args.phase](args, rng)


if __name__ == "__main__":
    main()
