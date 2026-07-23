/* Round-3 branch-and-bound DFS over orbit sign assignments for CW(n,k).
 *
 * Same input format as round2 dfs.c (gendfs/rundfs gen_input):
 *   n k m T
 *   sizes[m]
 *   T lines: t then m pairs (re, im) of orbit character sums at frequency t
 *   m lines: orbit i: cnt then positions
 *
 * New vs round2:
 *   - argv: [cap_cpu_s] [shard_depth D] [shard_id S in 0..3^D-1]
 *     idx < D branches are forced to digit d_i of S base 3 (0->0, 1->+1, 2->-1).
 *     Union over all S of the leaves visited == full tree (disjoint prefixes).
 *   - global sign canonicalization: first nonzero orbit sign is forced +1
 *     (solutions come in +-pairs; halves the tree; a shard whose first forced
 *     nonzero digit is -1 before any +1 is empty by construction).
 *   - exit codes: 0 complete, 3 time cap (incomplete).
 *
 * cc -O2 -o dfs2 dfs2.c -lm
 */
#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <string.h>
#include <time.h>

#define MAXM 72
#define MAXT 16
#define MAXN 256

static int n, k, m, T, sroot;
static int sizes[MAXM];
static double zre[MAXT][MAXM], zim[MAXT][MAXM];
static double zabs[MAXT][MAXM];
static double sufabs[MAXT][MAXM + 1];
static int sufw[MAXM + 1];
static int opos[MAXM][MAXN];
static int ocnt[MAXM];
static int cval[MAXM];
static int shard_depth = 0;
static int digits[MAXM]; /* 0 -> 0, 1 -> +1, 2 -> -1 */
static long long nodes = 0, leaves = 0, found = 0;
static double t_deadline = 0;
static FILE *out;

static void emit(void)
{
    int a[MAXN];
    memset(a, 0, sizeof(a));
    for (int i = 0; i < m; i++)
        if (cval[i])
            for (int j = 0; j < ocnt[i]; j++)
                a[opos[i][j]] = cval[i];
    for (int s = 1; s < n; s++) {
        long long p = 0;
        for (int i = 0; i < n; i++)
            p += (long long)a[i] * a[(i + s) % n];
        if (p != 0)
            return;
    }
    int nz = 0;
    for (int i = 0; i < n; i++)
        if (a[i]) nz++;
    if (nz != k)
        return;
    found++;
    fprintf(out, "%d %d\n", n, k);
    for (int i = 0; i < n; i++)
        fprintf(out, "%d ", a[i]);
    fprintf(out, "\n");
    fflush(out);
    fprintf(stderr, "*** SOLUTION FOUND ***\n");
}

static void dfs(int idx, int w, int rs, int hasnz, double fre[], double fim[])
{
    if (++nodes % 100000000LL == 0) {
        if (t_deadline > 0 && (double)clock() / CLOCKS_PER_SEC > t_deadline) {
            fprintf(stderr, "TIME CAP HIT (incomplete) nodes=%lld\n", nodes);
            fprintf(out, "# INCOMPLETE\n");
            fflush(out);
            exit(3);
        }
    }
    if (w == k) {
        /* remaining orbits are implicitly zero; if we are still inside the
         * forced-prefix region, this leaf belongs to exactly one shard: the
         * one whose remaining digits are all zero. */
        for (int j = idx; j < shard_depth; j++)
            if (digits[j] != 0)
                return;
        if (abs(rs) != sroot)
            return;
        for (int t = 0; t < T; t++) {
            double mag = sqrt(fre[t] * fre[t] + fim[t] * fim[t]);
            if (fabs(mag - sroot) > 1e-6)
                return;
        }
        leaves++;
        emit();
        return;
    }
    if (idx >= m || w + sufw[idx] < k)
        return;
    if (abs(rs) > sroot + sufw[idx])
        return;
    for (int t = 0; t < T; t++) {
        double mag = sqrt(fre[t] * fre[t] + fim[t] * fim[t]);
        double R = sufabs[t][idx];
        if (mag - R > sroot + 1e-9 || mag + R < sroot - 1e-9)
            return;
    }
    int forced = (idx < shard_depth) ? digits[idx] : -1; /* -1 = free */
    /* zero branch */
    if (forced == -1 || forced == 0) {
        cval[idx] = 0;
        dfs(idx + 1, w, rs, hasnz, fre, fim);
    }
    if (w + sizes[idx] <= k) {
        double nfre[MAXT], nfim[MAXT];
        /* +1 branch */
        if (forced == -1 || forced == 1) {
            for (int t = 0; t < T; t++) {
                nfre[t] = fre[t] + zre[t][idx];
                nfim[t] = fim[t] + zim[t][idx];
            }
            cval[idx] = 1;
            dfs(idx + 1, w + sizes[idx], rs + sizes[idx], 1, nfre, nfim);
        }
        /* -1 branch only after a +1 exists (sign canonicalization) */
        if (hasnz && (forced == -1 || forced == 2)) {
            for (int t = 0; t < T; t++) {
                nfre[t] = fre[t] - zre[t][idx];
                nfim[t] = fim[t] - zim[t][idx];
            }
            cval[idx] = -1;
            dfs(idx + 1, w + sizes[idx], rs - sizes[idx], 1, nfre, nfim);
        }
        cval[idx] = 0;
    }
}

int main(int argc, char **argv)
{
    double cap = argc > 1 ? atof(argv[1]) : 0;
    if (cap > 0)
        t_deadline = cap;
    shard_depth = argc > 2 ? atoi(argv[2]) : 0;
    long long shard_id = argc > 3 ? atoll(argv[3]) : 0;
    if (scanf("%d %d %d %d", &n, &k, &m, &T) != 4)
        return 2;
    if (m > MAXM || T > MAXT || n > MAXN) {
        fprintf(stderr, "limits exceeded m=%d T=%d n=%d\n", m, T, n);
        return 2;
    }
    if (shard_depth > m)
        shard_depth = m;
    for (int i = 0; i < shard_depth; i++) {
        digits[i] = (int)(shard_id % 3);
        shard_id /= 3;
    }
    sroot = (int)llround(sqrt((double)k));
    for (int i = 0; i < m; i++)
        scanf("%d", &sizes[i]);
    for (int t = 0; t < T; t++) {
        int tt;
        scanf("%d", &tt);
        for (int i = 0; i < m; i++) {
            scanf("%lf %lf", &zre[t][i], &zim[t][i]);
            zabs[t][i] = sqrt(zre[t][i] * zre[t][i] + zim[t][i] * zim[t][i]);
        }
    }
    for (int i = 0; i < m; i++) {
        scanf("%d", &ocnt[i]);
        for (int j = 0; j < ocnt[i]; j++)
            scanf("%d", &opos[i][j]);
    }
    for (int t = 0; t < T; t++) {
        sufabs[t][m] = 0;
        for (int i = m - 1; i >= 0; i--)
            sufabs[t][i] = sufabs[t][i + 1] + zabs[t][i];
    }
    sufw[m] = 0;
    for (int i = m - 1; i >= 0; i--)
        sufw[i] = sufw[i + 1] + sizes[i];
    out = fopen("dfs_out.txt", "a");
    double fre[MAXT] = {0}, fim[MAXT] = {0};
    dfs(0, 0, 0, 0, fre, fim);
    fprintf(stderr, "DONE nodes=%lld leaves=%lld found=%lld\n", nodes, leaves, found);
    fclose(out);
    return 0;
}
