"""
Weight-level keep/revert optimization — the intelligence-axis step.

The SUBJECT of optimization is the network WEIGHTS (changed by real gradient
descent), not a policy/prompt and not a heuristic. The keep/revert loop trains
candidate configs from scratch and keeps one only if it beats the incumbent on a
HELD-OUT eval (generalization, not memorization).

This is small-scale (a tiny MLP), so it is NOT AGI/ASI. But it is no longer
elicitation: the weights are the subject, gradient descent moves them, and
selection is on held-out generalization. That is the actual intelligence-axis
control loop, run on real weights.
"""
import numpy as np

def make_data(n, seed):
    rng = np.random.default_rng(seed)
    X = rng.uniform(-1, 1, size=(n, 2))
    # non-linear boundary: inside a circle of radius^2 = 0.5 → requires a hidden layer
    y = (X[:, 0] ** 2 + X[:, 1] ** 2 < 0.5).astype(np.float64).reshape(-1, 1)
    return X, y

Xtr, ytr = make_data(300, seed=0)
Xte, yte = make_data(200, seed=999)  # held-out: different draw

def sigmoid(z): return 1.0 / (1.0 + np.exp(-z))

def train_and_eval(hidden, lr, epochs, seed):
    rng = np.random.default_rng(seed)
    W1 = rng.normal(0, 0.8, size=(2, hidden)); b1 = np.zeros((1, hidden))
    W2 = rng.normal(0, 0.8, size=(hidden, 1)); b2 = np.zeros((1, 1))
    n = Xtr.shape[0]
    for _ in range(epochs):
        z1 = Xtr @ W1 + b1; a1 = np.tanh(z1)
        p = sigmoid(a1 @ W2 + b2)
        dz2 = (p - ytr) / n
        dW2 = a1.T @ dz2; db2 = dz2.sum(0, keepdims=True)
        da1 = dz2 @ W2.T; dz1 = da1 * (1 - a1 ** 2)
        dW1 = Xtr.T @ dz1; db1 = dz1.sum(0, keepdims=True)
        for P, dP in ((W1, dW1), (b1, db1), (W2, dW2), (b2, db2)):
            P -= lr * dP
        if not np.all(np.isfinite(W1)):  # diverged
            return 0.0
    a1 = np.tanh(Xte @ W1 + b1)
    pred = (sigmoid(a1 @ W2 + b2) > 0.5).astype(np.float64)
    return float((pred == yte).mean())  # HELD-OUT accuracy

# candidate weight-producing configs proposed in sequence
CONFIGS = [
    ("C0 H=1  lr=0.5  (underfit — can't bend the boundary)", dict(hidden=1,  lr=0.5, epochs=3000, seed=1)),
    ("C1 H=8  lr=0.5  (capacity to learn the curve)",        dict(hidden=8,  lr=0.5, epochs=3000, seed=1)),
    ("C2 H=8  lr=8.0  (lr too high — training diverges)",    dict(hidden=8,  lr=8.0, epochs=3000, seed=1)),
    ("C3 H=24 lr=0.7  (more capacity, tuned lr)",            dict(hidden=24, lr=0.7, epochs=4000, seed=1)),
]

best = -1.0; kept = None
print("weight-level keep/revert (subject = network weights; score = HELD-OUT accuracy)")
for name, cfg in CONFIGS:
    acc = train_and_eval(**cfg)
    keep = acc > best
    if keep: best = acc; kept = name
    bar = "#" * round(acc * 20)
    print(f"  {acc:.2f} {bar:<20} {'KEEP' if keep else 'REVERT':<7} {name}")
print(f"  kept: {kept}")
print(f"  held-out generalization: {CONFIGS[0][0].split()[0]}→best  {best:.2f}")
