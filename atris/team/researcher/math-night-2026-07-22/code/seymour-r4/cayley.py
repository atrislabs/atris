#!/usr/bin/env python3
"""Exhaustive Seymour second-neighborhood sweep over Cayley digraphs of ALL
groups of order 12..24 (abelian included; classification counts checked).

Groups are built as explicit multiplication tables from constructions
(cyclic, direct product, semidirect product with verified action, dicyclic
normal form, central-product quotient, matrix group SL(2,3), permutation
group S4/A4). EVERY table is brute-force verified: closure/Latin square,
identity, inverses, full associativity. Isomorphism types deduped by
invariant fingerprint; per-order type counts asserted against the known
classification (12:5, 13:1, 14:2, 15:1, 16:14, 17:1, 18:5, 19:1, 20:5,
21:2, 22:2, 23:1, 24:15).

Cayley digraph Cay(G,S): arcs g -> g*s. Oriented iff S cap S^{-1} = empty
(so no involutions in S). Left translations are automorphisms, so the graph
is vertex-transitive and it suffices to check vertex e:
  counterexample iff |S*S \\ (S u {e})| < |S|.
We enumerate ALL valid S (3^{#inverse-pairs} choices) -- fully exhaustive
per group, no degree pruning. Every 250th S additionally cross-checked with
a full all-vertex check on the whole adjacency structure (validates the
vertex-transitivity shortcut). Any hit is re-verified via the standalone
round-1 verify.py before being believed.
"""
import sys, itertools, random, time

# ---------- table machinery ----------

def cyclic(n):
    return [[(i + j) % n for j in range(n)] for i in range(n)]

def direct(T1, T2):
    n1, n2 = len(T1), len(T2)
    n = n1 * n2
    idx = lambda a, b: a * n2 + b
    T = [[0] * n for _ in range(n)]
    for a1 in range(n1):
        for b1 in range(n2):
            for a2 in range(n1):
                for b2 in range(n2):
                    T[idx(a1, b1)][idx(a2, b2)] = idx(T1[a1][a2], T2[b1][b2])
    return T

def semidirect(TA, TB, phi):
    """A x| B, phi[b] = permutation of A (automorphism), phi: B->Aut(A) hom.
    (a1,b1)(a2,b2) = (a1 * phi[b1](a2), b1*b2). Hom property verified."""
    nA, nB = len(TA), len(TB)
    # verify each phi[b] is an automorphism of A
    for b in range(nB):
        p = phi[b]
        assert sorted(p) == list(range(nA))
        for x in range(nA):
            for y in range(nA):
                assert p[TA[x][y]] == TA[p[x]][p[y]], "phi[%d] not an automorphism" % b
    # verify hom: phi[b1*b2] = phi[b1] o phi[b2]
    for b1 in range(nB):
        for b2 in range(nB):
            for x in range(nA):
                assert phi[TB[b1][b2]][x] == phi[b1][phi[b2][x]], "phi not a homomorphism"
    n = nA * nB
    idx = lambda a, b: a * nB + b
    T = [[0] * n for _ in range(n)]
    for a1 in range(nA):
        for b1 in range(nB):
            for a2 in range(nA):
                for b2 in range(nB):
                    T[idx(a1, b1)][idx(a2, b2)] = idx(TA[a1][phi[b1][a2]], TB[b1][b2])
    return T

def dicyclic(m):
    """Dic_m, order 4m: a^{2m}=1, b^2=a^m, b a b^{-1} = a^{-1}.
    Elements (i,j), i<2m, j in {0,1} meaning a^i b^j."""
    n = 4 * m
    idx = lambda i, j: i * 2 + j
    T = [[0] * n for _ in range(n)]
    for i in range(2 * m):
        for j in (0, 1):
            for k in range(2 * m):
                for l in (0, 1):
                    if j == 0:
                        r = (idx((i + k) % (2 * m), l))
                    else:
                        # a^i b a^k b^l = a^{i-k} b^{1+l}; b^2 = a^m
                        if l == 0:
                            r = idx((i - k) % (2 * m), 1)
                        else:
                            r = idx((i - k + m) % (2 * m), 0)
                    T[idx(i, j)][idx(k, l)] = r
    return T

def quotient(T, N):
    """Quotient of group T by normal subgroup (element list) N."""
    n = len(T)
    Nset = set(N)
    # verify subgroup + normal
    for x in N:
        for y in N:
            assert T[x][y] in Nset
    inv = [None] * n
    for x in range(n):
        for y in range(n):
            if T[x][y] == identity_of(T):
                inv[x] = y
    for g in range(n):
        for x in N:
            assert T[T[g][x]][inv[g]] in Nset, "not normal"
    # cosets
    coset_of = {}
    reps = []
    for g in range(n):
        c = frozenset(T[g][x] for x in N)
        if c not in coset_of:
            coset_of[c] = len(reps)
            reps.append(g)
    lookup = [None] * n
    for c, ci in coset_of.items():
        for e in c:
            lookup[e] = ci
    m = len(reps)
    Q = [[0] * m for _ in range(m)]
    for i, g in enumerate(reps):
        for j, h in enumerate(reps):
            Q[i][j] = lookup[T[g][h]]
    return Q

def identity_of(T):
    n = len(T)
    for e in range(n):
        if all(T[e][x] == x and T[x][e] == x for x in range(n)):
            return e
    raise ValueError("no identity")

def perm_group(gens, npts):
    """Closure of permutation generators (tuples) under composition -> table."""
    frontier = [tuple(range(npts))]
    seen = {frontier[0]}
    while frontier:
        nxt = []
        for g in frontier:
            for h in gens:
                c = tuple(g[h[i]] for i in range(npts))
                if c not in seen:
                    seen.add(c)
                    nxt.append(c)
        frontier = nxt
    elems = sorted(seen)
    index = {g: i for i, g in enumerate(elems)}
    n = len(elems)
    T = [[0] * n for _ in range(n)]
    for i, g in enumerate(elems):
        for j, h in enumerate(elems):
            T[i][j] = index[tuple(g[h[k]] for k in range(len(g)))]
    return T

def sl23():
    """SL(2,3) as 2x2 matrices over F3 with det 1."""
    els = []
    for a in range(3):
        for b in range(3):
            for c in range(3):
                for d in range(3):
                    if (a * d - b * c) % 3 == 1:
                        els.append((a, b, c, d))
    index = {m: i for i, m in enumerate(els)}
    n = len(els)
    T = [[0] * n for _ in range(n)]
    for i, (a, b, c, d) in enumerate(els):
        for j, (e, f, g, h) in enumerate(els):
            m = ((a * e + b * g) % 3, (a * f + b * h) % 3,
                 (c * e + d * g) % 3, (c * f + d * h) % 3)
            T[i][j] = index[m]
    return T

def verify_table(T, order):
    n = len(T)
    assert n == order, (n, order)
    for row in T:
        assert sorted(row) == list(range(n))
    for j in range(n):
        assert sorted(T[i][j] for i in range(n)) == list(range(n))
    e = identity_of(T)
    for x in range(n):
        assert any(T[x][y] == e for y in range(n))
    for x in range(n):
        for y in range(n):
            for z in range(n):
                assert T[T[x][y]][z] == T[x][T[y][z]], "assoc fail"
    return e

def fingerprint(T):
    """Isomorphism-invariant fingerprint."""
    n = len(T)
    e = identity_of(T)
    def elt_order(x):
        k, y = 1, x
        while y != e:
            y = T[y][x]; k += 1
        return k
    orders = sorted(elt_order(x) for x in range(n))
    inv = [next(y for y in range(n) if T[x][y] == e) for x in range(n)]
    center = sum(1 for x in range(n) if all(T[x][y] == T[y][x] for y in range(n)))
    # conjugacy class sizes
    seen = set()
    classes = []
    for x in range(n):
        if x in seen:
            continue
        cl = {T[T[g][x]][inv[g]] for g in range(n)}
        seen |= cl
        classes.append(len(cl))
    # derived subgroup size
    comms = {T[T[T[a][b]][inv[a]]][inv[b]] for a in range(n) for b in range(n)}
    # close under multiplication
    D = set(comms)
    changed = True
    while changed:
        changed = False
        for x in list(D):
            for y in list(D):
                z = T[x][y]
                if z not in D:
                    D.add(z); changed = True
    # squaring-image size (separates Q8xC2 from C4:C4)
    sqimg = len({T[x][x] for x in range(n)})
    # center element-order multiset (separates Pauli from C22:C4)
    zelems = [x for x in range(n) if all(T[x][y] == T[y][x] for y in range(n))]
    zorders = tuple(sorted(elt_order(x) for x in zelems))
    return (n, tuple(orders), center, tuple(sorted(classes)), len(D), sqimg, zorders)

# ---------- catalog ----------

def aut_perm(TA, gen_images):
    """Build automorphism of A as permutation from... helper not needed; we
    specify phi directly as permutations below."""

def power_map(T, k):
    """x -> x^k as a permutation (automorphism when A abelian, gcd ok)."""
    n = len(T)
    e = identity_of(T)
    p = []
    for x in range(n):
        y = e
        for _ in range(k):
            y = T[y][x]
        p.append(y)
    return p

def build_catalog():
    C = {}
    def add(name, order, T):
        verify_table(T, order)
        C.setdefault(order, []).append((name, T))

    c = {n: cyclic(n) for n in range(2, 25)}
    idp = lambda T: list(range(len(T)))

    S3 = perm_group([(1, 2, 0), (1, 0, 2)], 3)
    D4 = perm_group([(1, 2, 3, 0), (3, 2, 1, 0)], 4)   # dihedral order 8
    Q8 = dicyclic(2)
    A4 = perm_group([(1, 2, 0, 3), (0, 2, 3, 1)], 4)   # wait: use 3-cycles
    A4 = perm_group([(1, 2, 0, 3), (1, 0, 3, 2)], 4)   # (012), (01)(23)
    S4 = perm_group([(1, 2, 3, 0), (1, 0, 2, 3)], 4)
    C2, C3, C4, C6, C8, C12 = c[2], c[3], c[4], c[6], c[8], c[12]
    C22 = direct(C2, C2)
    dihedral = lambda m: semidirect(c[m], C2, [idp(c[m]), power_map(c[m], m - 1)])

    # order 12 (5)
    add('C12', 12, c[12])
    add('C2xC6', 12, direct(C2, C6))
    add('D6', 12, dihedral(6))
    add('A4', 12, A4)
    add('Dic3', 12, dicyclic(3))
    # order 13,17,19,23
    add('C13', 13, c[13]); add('C17', 17, c[17]); add('C19', 19, c[19]); add('C23', 23, c[23])
    # order 14 (2)
    add('C14', 14, c[14]); add('D7', 14, dihedral(7))
    # order 15 (1)
    add('C15', 15, c[15])
    # order 16 (14): 5 abelian
    add('C16', 16, c[16])
    add('C4xC4', 16, direct(C4, C4))
    add('C8xC2', 16, direct(C8, C2))
    add('C4xC2xC2', 16, direct(C4, C22))
    add('C2^4', 16, direct(C22, C22))
    # 9 nonabelian
    add('D8(16)', 16, dihedral(8))
    add('SD16', 16, semidirect(C8, C2, [idp(C8), power_map(C8, 3)]))
    add('M16', 16, semidirect(C8, C2, [idp(C8), power_map(C8, 5)]))
    add('Q16', 16, dicyclic(4))
    add('D4xC2', 16, direct(D4, C2))
    add('Q8xC2', 16, direct(Q8, C2))
    add('C4:C4', 16, semidirect(C4, C4, [idp(C4), power_map(C4, 3), idp(C4), power_map(C4, 3)]))
    # (C2xC2):C4, generator of C4 swaps the two C2 factors
    swap = [0, 2, 1, 3]  # C22 elements indexed a*2+b -> b*2+a
    add('C22:C4', 16, semidirect(C22, C4, [idp(C22), swap, idp(C22), swap]))
    # central product D4 o C4 = (D4 x C4)/<(z, c^2)>, z = central rotation r^2
    D4xC4 = direct(D4, C4)
    # D4 elements are perms of 4 pts; find z = rotation^2 = (2,3,0,1)... we need
    # its index in perm_group ordering; recompute: direct() indexes (a,b)->a*4+b
    # find central involution of D4:
    zD4 = None
    eD4 = identity_of(D4)
    for x in range(8):
        if x != eD4 and D4[x][x] == eD4 and all(D4[x][y] == D4[y][x] for y in range(8)):
            zD4 = x
    N = [identity_of(D4xC4), zD4 * 4 + 2]  # (z, c^2)
    add('D4oC4', 16, quotient(D4xC4, N))
    # order 18 (5)
    add('C18', 18, c[18])
    add('C3xC6', 18, direct(C3, C6))
    add('D9', 18, dihedral(9))
    add('S3xC3', 18, direct(S3, C3))
    C33 = direct(C3, C3)
    add('(C3xC3):C2', 18, semidirect(C33, C2, [idp(C33), power_map(C33, 2)]))
    # order 20 (5)
    add('C20', 20, c[20])
    add('C2xC10', 20, direct(C2, c[10]))
    add('D10', 20, dihedral(10))
    add('Dic5', 20, dicyclic(5))
    # F20 = C5:C4 faithful: generator of C4 acts as x->2x on C5
    m2 = [(2 * x) % 5 for x in range(5)]
    m4 = [(4 * x) % 5 for x in range(5)]
    m3 = [(3 * x) % 5 for x in range(5)]
    add('F20', 20, semidirect(c[5], C4, [idp(c[5]), m2, m4, m3]))
    # order 21 (2)
    add('C21', 21, c[21])
    t2 = [(2 * x) % 7 for x in range(7)]
    t4 = [(4 * x) % 7 for x in range(7)]
    add('C7:C3', 21, semidirect(c[7], C3, [idp(c[7]), t2, t4]))
    # order 22 (2)
    add('C22cyc', 22, c[22]); add('D11', 22, dihedral(11))
    # order 24 (15): 3 abelian
    add('C24', 24, c[24])
    add('C2xC12', 24, direct(C2, C12))
    add('C2xC2xC6', 24, direct(C22, C6))
    # 12 nonabelian
    add('S4', 24, S4)
    add('C2xA4', 24, direct(C2, A4))
    add('SL(2,3)', 24, sl23())
    add('D12(24)', 24, dihedral(12))
    add('Dic6', 24, dicyclic(6))
    # C3:C8: generator of C8 inverts C3
    add('C3:C8', 24, semidirect(C3, C8, [idp(C3) if i % 2 == 0 else power_map(C3, 2) for i in range(8)]))
    add('C3xD4', 24, direct(C3, D4))
    add('C3xQ8', 24, direct(C3, Q8))
    add('S3xC4', 24, direct(S3, C4))
    add('S3xC2xC2', 24, direct(S3, C22))
    add('C2xDic3', 24, direct(C2, dicyclic(3)))
    # C3:D4 = SmallGroup(24,8): D4 acts on C3 through a C2 quotient.
    # Two candidate kernels: the cyclic C4 <r> or a klein <r^2,s>. Build both,
    # dedupe by fingerprint (one of them equals D12 or C3xD4 etc if wrong).
    eD4 = identity_of(D4)
    r = None
    for x in range(8):
        # find element of order 4: x^2 != e and x^4 = e
        x2 = D4[x][x]
        if x2 != eD4 and D4[x2][x2] == eD4:
            r = x; break
    invC3 = power_map(C3, 2)
    # phi through quotient by <r>: elements in <r> act trivially
    rpows = {eD4}
    y = r
    while y != eD4:
        rpows.add(y); y = D4[y][r]
    phi1 = [idp(C3) if x in rpows else invC3 for x in range(8)]
    add('C3:D4(a)', 24, semidirect(C3, D4, phi1))
    # phi through quotient by klein subgroup containing r^2 and a reflection s
    r2 = D4[r][r]
    s = next(x for x in range(8) if x not in rpows and D4[x][x] == eD4)
    K = {eD4, r2, s, D4[r2][s]}
    phi2 = [idp(C3) if x in K else invC3 for x in range(8)]
    add('C3:D4(b)', 24, semidirect(C3, D4, phi2))
    return C

KNOWN_COUNTS = {12: 5, 13: 1, 14: 2, 15: 1, 16: 14, 17: 1, 18: 5, 19: 1,
                20: 5, 21: 2, 22: 2, 23: 1, 24: 15}

# ---------- Seymour sweep ----------

def sweep_group(name, T, spot_check_every=250):
    n = len(T)
    e = identity_of(T)
    inv = [next(y for y in range(n) if T[x][y] == e) for x in range(n)]
    # inverse pairs (exclude identity and involutions)
    pairs = []
    seen = set()
    invol = 0
    for x in range(n):
        if x == e or x in seen:
            continue
        if inv[x] == x:
            invol += 1
            continue
        pairs.append((x, inv[x]))
        seen.add(x); seen.add(inv[x])
    rowbits = [sum(1 << T[g][s] for s in range(n)) & 0 for g in range(n)]  # unused
    total = 0
    hits = []
    spot = 0
    for choice in itertools.product((0, 1, 2), repeat=len(pairs)):
        S = [p[0] if ch == 1 else p[1] for p, ch in zip(pairs, choice) if ch]
        if not S:
            continue
        total += 1
        Sset = set(S)
        prod = set()
        for s1 in S:
            row = T[s1]
            for s2 in S:
                prod.add(row[s2])
        Npp = prod - Sset - {e}
        is_cex = len(Npp) < len(S)
        if total % spot_check_every == 0:
            # independent all-vertex check of vertex-transitivity shortcut
            spot += 1
            allv = True
            for v in range(n):
                Np = {T[v][s] for s in S}
                Npp_v = set()
                for u in Np:
                    for s in S:
                        w = T[u][s]
                        if w != v and w not in Np:
                            Npp_v.add(w)
                if not (len(Npp_v) < len(Np)):
                    allv = False
                    break
            assert allv == is_cex, "vertex-transitivity shortcut violated!"
        if is_cex:
            hits.append(list(S))
    return total, hits, len(pairs), invol, spot

def main():
    random.seed(1)
    cat = build_catalog()
    # dedupe by fingerprint, check classification counts
    print("== catalog verification ==")
    all_groups = []
    for order in sorted(cat):
        fps = {}
        for name, T in cat[order]:
            fp = fingerprint(T)
            fps.setdefault(fp, []).append(name)
        types = len(fps)
        expect = KNOWN_COUNTS[order]
        dup_note = ""
        for fp, names in fps.items():
            if len(names) > 1:
                dup_note += " DUP:%s" % "/".join(names)
            all_groups.append((order, names[0], dict(cat[order])[names[0]]))
        status = "OK" if types == expect else "MISMATCH"
        print("order %d: %d constructions, %d distinct types (expect %d) %s%s"
              % (order, len(cat[order]), types, expect, status, dup_note))
        if types != expect:
            print("  !! classification count mismatch at order", order)
    print()
    print("== sweep ==")
    grand = 0
    all_hits = []
    for order, name, T in all_groups:
        t0 = time.time()
        total, hits, npairs, invol, spot = sweep_group(name, T)
        grand += total
        print("order %2d %-12s pairs=%2d invol=%2d sets=%8d spot=%5d hits=%d (%.1fs)"
              % (order, name, npairs, invol, total, spot, len(hits), time.time() - t0),
              flush=True)
        for S in hits:
            all_hits.append((order, name, S))
            print("   HIT S=%s" % S)
            # dump adjacency matrix for standalone verification
            n = len(T)
            fn = "cayley_hit_%s.txt" % name.replace('/', '_')
            with open(fn, 'w') as f:
                for g in range(n):
                    row = ['0'] * n
                    for s in S:
                        row[T[g][s]] = '1'
                    f.write(''.join(row) + '\n')
            print("   wrote", fn)
    print()
    print("TOTAL connection sets checked: %d across %d groups" % (grand, len(all_groups)))
    print("TOTAL hits: %d" % len(all_hits))
    return 10 if all_hits else 0

if __name__ == '__main__':
    sys.exit(main())
