#!/usr/bin/env python3
"""
Randomized + hill-climbing search for a Barnette counterexample beyond the
verified frontier (66-120 vertices).

Growth operation (preserves cubic, planar, bipartite, 3-connected):
  pick a face F (even cycle), two distinct non-adjacent edges e1=(a,b), e2=(c,d)
  on F, oriented by the face traversal, with col(a)==col(c).
  Subdivide e1 -> a-x1-x2-b, e2 -> c-y1-y2-d, add chords x1-y2 and x2-y1
  (nested, drawn inside F). Adds 4 vertices.

We maintain the planar embedding as a rotation system (clockwise neighbor
order) so faces can be traced combinatorially; planarity is preserved by
construction and re-verified by networkx on samples and on any candidate.

Fitness for hill-climbing = ham2 search-tree nodes (hardness proxy).
NONHAM verdict = candidate counterexample -> dump certificate, stop.
"""
import os, random, subprocess, sys, time
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
HAM2 = os.path.join(HERE, "ham2v")
PLANTRI = os.path.join(HERE, "plantri")

# ---------- embedding: rot[v] = list of neighbors in cyclic order ----------

def plantri_seeds(tri_n, count=200, slice_=None):
    """Random-ish seeds: read plantri -bd stream (planar_code has embedding)."""
    args = [PLANTRI, "-bd", str(tri_n)]
    if slice_: args.append(slice_)
    p = subprocess.run(args, capture_output=True)
    data = p.stdout
    graphs = []
    i = 0
    if data.startswith(b'>>'):
        i = data.index(b'<<') + 2
    while i < len(data):
        n = data[i]; i += 1
        rot = []
        for v in range(n):
            nb = []
            while data[i] != 0:
                nb.append(data[i]-1); i += 1
            i += 1
            rot.append(nb)
        graphs.append(rot)
        if len(graphs) >= 500000: break
    random.shuffle(graphs)
    return graphs[:count]

def faces_of(rot):
    """Trace faces of the embedding. Returns list of faces; each face is a list
    of directed edges (u,v) in order."""
    nxt = {}
    for u, nbs in enumerate(rot):
        deg = len(nbs)
        for idx, v in enumerate(nbs):
            # face-tracing: successor of dart (u,v) is (v, w) where w follows u
            # in rot[v] (using the convention: w = neighbor after u in cyclic order)
            j = rot[v].index(u)
            w = rot[v][(j+1) % len(rot[v])]
            nxt[(u, v)] = (v, w)
    seen = set()
    faces = []
    for d in nxt:
        if d in seen: continue
        face = []
        cur = d
        while cur not in seen:
            seen.add(cur)
            face.append(cur)
            cur = nxt[cur]
        faces.append(face)
    return faces

def two_color(rot):
    n = len(rot)
    col = [-1]*n
    col[0] = 0
    stack = [0]
    while stack:
        v = stack.pop()
        for w in rot[v]:
            if col[w] == -1:
                col[w] = 1-col[v]; stack.append(w)
            elif col[w] == col[v]:
                return None
    return col

def expand(rot, rng):
    """Apply one random expansion. Returns new rot or None if no valid choice."""
    col = two_color(rot)
    if col is None: return None
    faces = faces_of(rot)
    # prefer larger faces a bit
    weights = [len(f)**2 for f in faces]
    f = rng.choices(faces, weights=weights)[0]
    L = len(f)
    if L < 4: return None
    # face darts f[0..L-1]; pick i<j darts e1=f[i]=(a,b), e2=f[j]=(c,d),
    # need col(a)==col(c), edges vertex-disjoint
    idxs = list(range(L))
    rng.shuffle(idxs)
    pick = None
    for ii in range(L):
        for jj in range(ii+1, L):
            i1, j1 = idxs[ii], idxs[jj]
            (a, b), (c, d) = f[i1], f[j1]
            if len({a, b, c, d}) != 4: continue
            if col[a] != col[c]: continue
            pick = (f[i1], f[j1]); break
        if pick: break
    if not pick: return None
    (a, b), (c, d) = pick
    n = len(rot)
    x1, x2, y1, y2 = n, n+1, n+2, n+3
    rot = [list(nb) for nb in rot] + [None]*4
    # subdivide a-b with x1,x2: a's rot: replace b by x1; b's: replace a by x2
    rot[a][rot[a].index(b)] = x1
    rot[b][rot[b].index(a)] = x2
    rot[c][rot[c].index(d)] = y1
    rot[d][rot[d].index(c)] = y2
    # The face F is traversed ...a->b...c->d... (darts (a,b),(c,d) on F).
    # New chords x1-y2 and x2-y1 nested inside F.
    # Path a-x1-x2-b. In the face traversal a->b, the face interior is on a fixed
    # side. Rotation orders (any planar-consistent choice):
    # x1: neighbors a, x2, y2  ; x2: neighbors x1, b, y1
    # y1: neighbors c, y2, x2  ; y2: neighbors y1, d, x1
    # Orient so that chords lie inside F. Face traversal in 'nxt' convention:
    # going a->b along the face, interior on the left(under our convention either
    # side, planarity checked after).
    V, E = n + 4, 3*n//2 + 6
    for orient in range(2):
        if orient == 0:
            rot[x1] = [a, y2, x2]; rot[x2] = [x1, y1, b]
            rot[y1] = [c, x2, y2]; rot[y2] = [y1, x1, d]
        else:
            rot[x1] = [a, x2, y2]; rot[x2] = [x1, b, y1]
            rot[y1] = [c, y2, x2]; rot[y2] = [y1, d, x1]
        F = len(faces_of(rot))
        if V - E + F == 2:   # genuine planar embedding (Euler)
            return rot
    return None

def rot_to_pc(rot):
    n = len(rot)
    out = bytes([n])
    for nb in rot:
        out += bytes(w+1 for w in nb) + b'\x00'
    return out

def check_class(rot):
    """Full class check with networkx (planar, bipartite, cubic, 3-connected)."""
    import networkx as nx
    n = len(rot)
    G = nx.Graph()
    G.add_nodes_from(range(n))
    for v, nb in enumerate(rot):
        if len(nb) != 3 or len(set(nb)) != 3: return False, "not simple cubic"
        for w in nb: G.add_edge(v, w)
    if not all(G.degree(v) == 3 for v in G): return False, "degree"
    if not nx.is_bipartite(G): return False, "bipartite"
    ok, _ = nx.check_planarity(G)
    if not ok: return False, "planar"
    if nx.node_connectivity(G) != 3: return False, "3conn"
    return True, "ok"

def ham2_batch(rots, budget=5_000_000):
    """Run ham2 on a list of embeddings; return list of (verdict, nodes)."""
    pc = b''.join(rot_to_pc(r) for r in rots)
    surv = os.path.join(HERE, "search_survivors.pc")
    p = subprocess.run([HAM2, surv, str(budget), "verbose"], input=pc,
                       capture_output=True)
    res = []
    for line in p.stdout.decode().splitlines():
        if line.startswith("G "):
            parts = line.split()
            verdict = parts[3].split('=')[1]
            nodes = int(parts[4].split('=')[1])
            res.append((verdict, nodes))
    return res

def save_certificate(rot, path):
    with open(path, "w") as f:
        f.write(f"{len(rot)}\n")
        for v, nb in enumerate(rot):
            f.write(f"{v}: {' '.join(map(str, sorted(nb)))}\n")

def main():
    rng = random.Random(20260722)
    t0 = time.time()
    time_budget = float(sys.argv[1]) if len(sys.argv) > 1 else 1800
    target_min, target_max = 66, 92
    print("collecting plantri seeds (tri orders 20-24 -> 36-44 vertices)...")
    seeds = []
    seeds += plantri_seeds(20, 150)
    seeds += plantri_seeds(22, 150, "7/100")
    seeds += plantri_seeds(24, 150, "13/2000")
    print(f"{len(seeds)} seeds")
    # sanity: expansion preserves the class
    r = seeds[0]
    for _ in range(10):
        r2 = expand(r, rng)
        if r2 is not None: r = r2
    ok, msg = check_class(r)
    print(f"sanity expansion check ({len(r)} verts): {ok} {msg}")
    if not ok:
        print("EXPANSION OP BROKEN — abort"); sys.exit(1)

    best = []   # (nodes, rot) hardest instances
    pop = []
    # init population: grow seeds to random size in [66,120]
    total_checked = 0
    ham_all = True
    gen = 0
    while time.time() - t0 < time_budget:
        gen += 1
        batch = []
        for _ in range(40):
            if pop and rng.random() < 0.6:
                base = rng.choice(pop)[1]
            else:
                base = rng.choice(seeds)
            r = [list(x) for x in base]
            tgt = rng.randrange(target_min, target_max+1, 2)
            guard = 0
            while len(r) < tgt and guard < 500:
                guard += 1
                r2 = expand(r, rng)
                if r2 is not None: r = r2
            if len(r) >= target_min:
                batch.append(r)
        if not batch: continue
        res = ham2_batch(batch)
        total_checked += len(res)
        for rot, (verdict, nodes) in zip(batch, res):
            if verdict in ("NONHAM", "BUDGET"):
                # candidate! verify class, save, report
                ok, msg = check_class(rot)
                path = os.path.join(HERE, f"candidate_{len(rot)}_{int(time.time())}.txt")
                save_certificate(rot, path)
                print(f"!!! {verdict} candidate n={len(rot)} class_ok={ok}({msg}) saved {path}")
                if verdict == "NONHAM" and ok:
                    save_certificate(rot, os.path.join(HERE, "certificate.txt"))
                    print("CERTIFICATE SAVED — run verify.py")
                    sys.exit(0)
            pop.append((nodes, rot))
        pop.sort(key=lambda t: -t[0])
        pop = pop[:30]
        if gen % 5 == 0:
            top = [(t[0], len(t[1])) for t in pop[:5]]
            print(f"gen {gen}: checked={total_checked} elapsed={int(time.time()-t0)}s top(nodes,n)={top}")
    print(f"done: {total_checked} graphs in [{target_min},{target_max}] checked, all Hamiltonian")
    top = [(t[0], len(t[1])) for t in pop[:10]]
    print(f"hardest: {top}")
    # save hardest few for the Kelmans prong
    for i, (nodes, rot) in enumerate(pop[:10]):
        save_certificate(rot, os.path.join(HERE, f"hard_{i}_n{len(rot)}_nodes{nodes}.txt"))

if __name__ == "__main__":
    main()
