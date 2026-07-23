/* Exhaustive enumeration of all symmetric circulant 2-colorings of K_43.
 * Connection set S subset of {1..21} (difference d and 43-d paired), so
 * 2^21 = 2,097,152 red graphs; blue = complementary circulant.
 * For each, exact count of mono K5s via vertex-transitivity:
 *   #K5(G) = 43 * #K4(G[N(0)]) / 5.
 * Track the minimum total and report top candidates. If any total==0,
 * print the certificate bitstring (would disprove R(5,5)=43).
 */
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>

#define N 43
typedef unsigned long long u64;
#define PC(x) __builtin_popcountll(x)

static u64 rowmask = ((u64)1 << N) - 1;

/* count K4s in graph given by rows adj[] restricted to vertex set s */
static long count_k4_in(const u64 *adj, u64 s) {
    long cnt = 0;
    u64 rem = s;
    while (rem) {
        int a = __builtin_ctzll(rem); rem &= rem - 1;
        u64 nb = adj[a] & s & ~(((u64)1 << (a + 1)) - 1); /* b > a */
        u64 t = nb;
        while (t) {
            int b = __builtin_ctzll(t); t &= t - 1;
            u64 c2 = adj[a] & adj[b] & s & ~(((u64)1 << (b + 1)) - 1); /* c > b */
            u64 t2 = c2;
            while (t2) {
                int c = __builtin_ctzll(t2); t2 &= t2 - 1;
                cnt += PC(adj[a] & adj[b] & adj[c] & s &
                          ~(((u64)1 << (c + 1)) - 1)); /* d > c */
            }
        }
    }
    return cnt;
}

int main(void) {
    long bestTotal = 1L << 60;
    unsigned bestMask = 0;
    long zeroFound = 0;
    /* precompute difference bit rows for row 0: bit j set iff diff(0,j) in S */
    for (unsigned mask = 0; mask < (1u << 21); mask++) {
        /* build row0 for red */
        u64 row0r = 0;
        for (int d = 1; d <= 21; d++)
            if (mask & (1u << (d - 1))) {
                row0r |= (u64)1 << d;
                row0r |= (u64)1 << (N - d);
            }
        u64 row0b = (~row0r) & rowmask & ~(u64)1; /* blue row 0, no loop */
        /* full adjacency rows by rotation */
        u64 adjr[N], adjb[N];
        for (int i = 0; i < N; i++) {
            /* rotate row0 left by i (cyclic on N bits) */
            u64 r = ((row0r << i) | (row0r >> (N - i))) & rowmask;
            u64 b = ((row0b << i) | (row0b >> (N - i))) & rowmask;
            adjr[i] = r; adjb[i] = b;
        }
        long k4r = count_k4_in(adjr, adjr[0]); /* K4 inside N_red(0) */
        long k4b = count_k4_in(adjb, adjb[0]);
        long total = (43 * (k4r + k4b)) / 5; /* each K5 has 5 vertices */
        if (total < bestTotal) {
            bestTotal = total;
            bestMask = mask;
            fprintf(stderr, "new best: mask=%07x  totalK5=%ld (redK5=%ld blueK5=%ld)\n",
                    mask, total, 43 * k4r / 5, 43 * k4b / 5);
        }
        if (total == 0) zeroFound++;
    }
    printf("enumerated all 2^21 symmetric circulant colorings of K_43\n");
    printf("minimum total mono-K5 count = %ld at mask=%07x\n", bestTotal, bestMask);
    printf("zero-count colorings found = %ld\n", zeroFound);
    /* dump best certificate bitstring for inspection/seeding */
    {
        u64 row0r = 0;
        for (int d = 1; d <= 21; d++)
            if (bestMask & (1u << (d - 1))) {
                row0r |= (u64)1 << d; row0r |= (u64)1 << (N - d);
            }
        u64 adjr[N];
        for (int i = 0; i < N; i++)
            adjr[i] = ((row0r << i) | (row0r >> (N - i))) & rowmask;
        FILE *f = fopen("best_circulant.txt", "w");
        for (int i = 0; i < N; i++)
            for (int j = i + 1; j < N; j++)
                fputc((adjr[i] >> j) & 1 ? '1' : '0', f);
        fputc('\n', f);
        fclose(f);
        printf("best circulant written to best_circulant.txt (connection set:");
        for (int d = 1; d <= 21; d++)
            if (bestMask & (1u << (d - 1))) printf(" %d", d);
        printf(")\n");
    }
    return 0;
}
