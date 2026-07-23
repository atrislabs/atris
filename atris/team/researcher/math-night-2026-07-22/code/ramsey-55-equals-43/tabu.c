/* Tabu search for a (5,5;43) Ramsey coloring (would disprove R(5,5)=43).
 * State: 2-coloring of K_43 as red bitrows R[43] (blue = complement).
 * Objective: total number of monochromatic K5s. Moves: single edge flips.
 * Delta for flipping (u,v): K5s through the edge in each color =
 * triangles inside the common neighborhood in that color (single-word bitsets,
 * N=43 fits in one u64).
 *
 * usage: ./tabu <seconds> <seed> [initfile]
 * initfile: optional 903-bit certificate to seed the first restart.
 * Writes best coloring to best_tabu_<seed>.txt; prints progress to stderr.
 * Exits immediately with certificate if objective hits 0.
 */
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define N 43
#define E (N*(N-1)/2)
typedef unsigned long long u64;
#define PC(x) __builtin_popcountll(x)
static const u64 FULL = (((u64)1 << N) - 1);

static u64 R[N]; /* red adjacency rows */
static int eu[E], ev[E];

static u64 rng_state;
static inline u64 rnd(void) { /* xorshift64* */
    rng_state ^= rng_state >> 12; rng_state ^= rng_state << 25;
    rng_state ^= rng_state >> 27; return rng_state * 2685821657736338717ULL;
}

static inline u64 blue_row(int i) { return (~R[i]) & FULL & ~((u64)1 << i); }

/* triangles of graph rows[] inside vertex set s (each counted once) */
static inline long tri_in_red(u64 s) {
    long c = 0; u64 rem = s;
    while (rem) {
        int a = __builtin_ctzll(rem); rem &= rem - 1;
        u64 t = R[a] & s & ~(((u64)1 << (a + 1)) - 1);
        while (t) {
            int b = __builtin_ctzll(t); t &= t - 1;
            c += PC(R[a] & R[b] & s & ~(((u64)1 << (b + 1)) - 1));
        }
    }
    return c;
}
static inline long tri_in_blue(u64 s) {
    long c = 0; u64 rem = s;
    while (rem) {
        int a = __builtin_ctzll(rem); rem &= rem - 1;
        u64 ba = blue_row(a);
        u64 t = ba & s & ~(((u64)1 << (a + 1)) - 1);
        while (t) {
            int b = __builtin_ctzll(t); t &= t - 1;
            c += PC(ba & blue_row(b) & s & ~(((u64)1 << (b + 1)) - 1));
        }
    }
    return c;
}

/* K5s through edge (u,v) in the color the edge currently has, and in the
 * opposite color if it were flipped */
static inline long k5_through_red(int u, int v) { return tri_in_red(R[u] & R[v]); }
static inline long k5_through_blue(int u, int v) { return tri_in_blue(blue_row(u) & blue_row(v)); }

static long total_k5(void) {
    /* sum over edges of K5-through-edge / 10 for each color */
    long s = 0;
    for (int i = 0; i < N; i++)
        for (int j = i + 1; j < N; j++) {
            if ((R[i] >> j) & 1) s += k5_through_red(i, j);
            else s += k5_through_blue(i, j);
        }
    return s / 10;
}

static void write_cert(const char *path) {
    FILE *f = fopen(path, "w");
    for (int i = 0; i < N; i++)
        for (int j = i + 1; j < N; j++)
            fputc((R[i] >> j) & 1 ? '1' : '0', f);
    fputc('\n', f);
    fclose(f);
}

static void flip(int u, int v) {
    R[u] ^= (u64)1 << v; R[v] ^= (u64)1 << u;
}

int main(int argc, char **argv) {
    double seconds = argc > 1 ? atof(argv[1]) : 60;
    rng_state = argc > 2 ? (u64)atoll(argv[2]) * 88172645463325252ULL + 1 : 88172645463325252ULL;
    const char *initfile = argc > 3 ? argv[3] : NULL;
    char outname[64];
    snprintf(outname, sizeof outname, "best_tabu_%s.txt", argc > 2 ? argv[2] : "0");

    int k = 0;
    for (int i = 0; i < N; i++)
        for (int j = i + 1; j < N; j++) { eu[k] = i; ev[k] = j; k++; }

    long tabu[E]; /* iteration until which edge is tabu */
    long globalBest = 1L << 60;
    u64 bestR[N];
    clock_t t0 = clock();
    long iterTotal = 0;
    int restart = 0;

    int haveIncumbent = 0;
    while ((double)(clock() - t0) / CLOCKS_PER_SEC < seconds) {
        /* ---- init restart: seed file / kick from incumbent / random ---- */
        memset(R, 0, sizeof R);
        if (initfile && restart == 0) {
            FILE *f = fopen(initfile, "r");
            if (!f) { fprintf(stderr, "cannot open %s\n", initfile); return 2; }
            int ch, idx = 0;
            while ((ch = fgetc(f)) != EOF && idx < E) {
                if (ch != '0' && ch != '1') continue;
                if (ch == '1') flip(eu[idx], ev[idx]);
                idx++;
            }
            fclose(f);
        } else if (haveIncumbent && (restart % 25 != 24)) {
            /* iterated local search: kick the incumbent */
            memcpy(R, bestR, sizeof R);
            int kicks = 6 + (int)(rnd() % 20);
            for (int t = 0; t < kicks; t++) {
                int e = (int)(rnd() % E);
                flip(eu[e], ev[e]);
            }
        } else {
            for (int e = 0; e < E; e++) if (rnd() & 1) flip(eu[e], ev[e]);
        }
        memset(tabu, 0, sizeof tabu);
        long cur = total_k5();
        long best = cur;
        long lastImprove = 0;
        long iter = 0;
        long maxStall = 25000;

        while (cur > 0 && iter - lastImprove < maxStall &&
               (double)(clock() - t0) / CLOCKS_PER_SEC < seconds) {
            iter++; iterTotal++;
            long bestDelta = 1L << 60;
            int cand[E], nc = 0;
            for (int e = 0; e < E; e++) {
                int u = eu[e], v = ev[e];
                long d;
                if ((R[u] >> v) & 1)
                    d = k5_through_blue(u, v) - k5_through_red(u, v);
                else
                    d = k5_through_red(u, v) - k5_through_blue(u, v);
                int isTabu = tabu[e] > iter;
                if (isTabu && cur + d >= best) continue; /* aspiration */
                if (d < bestDelta) { bestDelta = d; nc = 0; cand[nc++] = e; }
                else if (d == bestDelta && nc < E) cand[nc++] = e;
            }
            if (nc == 0) break;
            int e = cand[rnd() % nc];
            flip(eu[e], ev[e]);
            cur += bestDelta;
            tabu[e] = iter + 8 + (long)(rnd() % 32);
            if (cur < best) { best = cur; lastImprove = iter; }
            if (cur < globalBest) {
                globalBest = cur;
                memcpy(bestR, R, sizeof R);
                fprintf(stderr, "[seed %s] new global best: %ld mono K5s (restart %d, iter %ld)\n",
                        argc > 2 ? argv[2] : "0", cur, restart, iter);
                write_cert(outname);
                if (cur == 0) {
                    printf("ZERO FOUND -- certificate in %s\n", outname);
                    return 0;
                }
            }
        }
        restart++;
    }
    printf("done: best = %ld mono K5s over %d restarts, %ld iterations; cert in %s\n",
           globalBest, restart, iterTotal, outname);
    return 1;
}
