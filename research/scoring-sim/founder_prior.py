"""Which incoming vouch should earn a founder's starting balance? (D11)

The earned-founder-prior change says configuration names who MAY hold a founder's balance and the
graph says who actually does. That only works if "the graph says so" cannot be said by the founder
itself. This file is the security boundary for that rule, kept runnable so the claim survives the
conversation that produced it.

Three candidate rules, evaluated against the same graphs:

  R1  any non-self incoming vouch
  R2  an incoming vouch from an account reachable from any seed
  R3  an incoming vouch from a NON-SEED reachable from (seeds - candidate),
      by a path that does not pass through the candidate

Run: python3 founder_prior.py
"""

from collections import deque

A = lambda i: "0x" + format(i, "040x")


def reach(g, sources, banned=None):
    """Accounts reachable from `sources`, with `banned` deleted from the graph entirely."""
    seen, q = set(), deque()
    for s in sources:
        if s != banned:
            seen.add(s)
            q.append(s)
    while q:
        for n in g.get(q.popleft(), ()):
            if n != banned and n not in seen:
                seen.add(n)
                q.append(n)
    return seen


def incoming(g, target):
    return [a for a, es in g.items() if a != target and target in es]


def r1(g, seeds, c):
    return bool(incoming(g, c))


def r2(g, seeds, c):
    r = reach(g, seeds)
    return any(v in r for v in incoming(g, c))


def r3(g, seeds, c):
    others = seeds - {c}
    if not others:                      # vacuously false: nothing independent to appeal to
        return False
    r = reach(g, others, banned=c)
    return any(v not in seeds and v in r for v in incoming(g, c))


RULES = [("R1", r1), ("R2", r2), ("R3", r3)]
RULE_KEY = ("R1  any non-self incoming vouch",
            "R2  voucher is reachable from any seed",
            "R3  voucher is a non-seed reachable from (seeds - candidate), not via the candidate")


def build(edges):
    g = {}
    for a, b in edges:
        g.setdefault(A(a), set()).add(A(b))
    return g


def community(n_seeds, members=range(10, 18)):
    """Non-candidate seeds introduce members; members vouch among themselves. F0 is repudiated."""
    e = [(s, 10 + s) for s in range(1, n_seeds)]
    m = list(members)
    e += [(i, m[(k + 1) % len(m)]) for k, i in enumerate(m)]
    return e


def table(title, rows, cols):
    print(f"=== {title} ===\n")
    w = max(len(r[0]) for r in rows) + 2
    print(f"{'scenario':<{w}}" + "".join(f"{c:>12}" for c in cols))
    print("-" * (w + 12 * len(cols)))
    for label, vals in rows:
        print(f"{label:<{w}}" + "".join(f"{v:>12}" for v in vals))
    print()


def verdict(ok):
    return "EARNS" if ok else "no"


def main():
    seeds3 = {A(0), A(1), A(2)}
    base3 = community(3)

    # ── 1. the three rules against attack and legitimate scenarios ───────────────
    scenarios = [
        ("nobody vouches for F0", [], seeds3),
        ("ATTACK F0 mints X, X vouches back", [(0, 90), (90, 0)], seeds3),
        ("ATTACK F0 mints a chain X->Y->F0", [(0, 90), (90, 91), (91, 0)], seeds3),
        ("ATTACK founder F1 colludes via Y", [(1, 92), (92, 0)], seeds3),
        ("legitimate: a member vouches for F0", [(14, 0)], seeds3),
        ("ATTACK single seed, F0 mints X, X back", [(0, 90), (90, 0)], {A(0)}),
        ("legitimate: single seed, member vouches", [(0, 10), (14, 0)], {A(0)}),
    ]
    rows = []
    for label, extra, seeds in scenarios:
        edges = community(len(seeds)) + extra
        g = build(edges)
        rows.append((label, [verdict(f(g, seeds, A(0))) for _, f in RULES]))
    table("which rule earns a repudiated founder's prior?", rows, [n for n, _ in RULES])
    for line in RULE_KEY:
        print("  " + line)
    print()
    print("  Rows marked ATTACK: 'EARNS' is a failure. Rows marked legitimate: 'no' is a failure.")
    print("  R3 is the only survivor OF THESE THREE. That is a statement about the rules tested,")
    print("  not a proof that no other rule works.\n")

    # ── 2. the enforceable minimum seed count ───────────────────────────────────
    rows = []
    for n in range(1, 5):
        seeds = {A(i) for i in range(n)}
        honest = build(community(n) + [(14, 0)])
        attack = build(community(n) + [(0, 90), (90, 0)])
        rows.append((f"{n} configured seed{'s' if n > 1 else ''}",
                     [verdict(r3(honest, seeds, A(0))), verdict(r3(attack, seeds, A(0)))]))
    table("R3: minimum seed count", rows, ["honest vouch", "self-certified"])
    print("  One seed cannot qualify its founder even honestly, because (seeds - candidate) is")
    print("  empty. TWO is the mechanism minimum. The 3-5 founder recommendation is a separate")
    print("  matter (floor dilution) and must not be enforced here as if it were this one.\n")

    # ── 3. does founder count buy collusion resistance? ─────────────────────────
    rows = []
    for n in range(2, 6):
        seeds = {A(i) for i in range(n)}
        g = build(community(n) + [(1, 92), (92, 0)])   # exactly ONE other founder cooperates
        rows.append((f"{n} founders, 1 cooperates", [verdict(r3(g, seeds, A(0)))]))
    table("does adding founders resist collusion?", rows, ["R3"])
    print("  Flat. One cooperating founder defeats R3 at every size, so founder count trades")
    print("  against the founder floor and buys nothing against collusion. The advertised")
    print("  boundary is therefore: R3 blocks UNILATERAL self-certification and nothing more.")


if __name__ == "__main__":
    main()
