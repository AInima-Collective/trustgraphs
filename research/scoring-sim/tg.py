"""Faithful integer port of packages/pagerank-core/src/pagerank.rs::calculate_generic.

Written from the Rust, not from the memo's toy. All arithmetic is integer at scale S=1e18,
same operation order, same truncation points.
"""
from collections import deque

S = 10**18

def fp_mul(a, b, s=S): return (a * b) // s
def fp_div(a, b, s=S): return (a * s) // b

class Cfg:
    def __init__(self, damping=0.85, tolerance=1e-6, max_iterations=100,
                 trust_multiplier=2.0, trust_share=0.15, trust_decay=0.8,
                 seeds=(), f15=False, f5d=False, fix_multiplier=False, fix_seed_divisor=False):
        self.damping = int(damping * S)
        self.tolerance = int(tolerance * S)
        self.max_iterations = max_iterations
        self.trust_multiplier = int(trust_multiplier * S)
        self.trust_share = int(trust_share * S)
        self.trust_decay = int(trust_decay * S)
        self.seeds = set(seeds)
        self.f15 = f15                      # endowment only to seed-reachable nodes
        self.f5d = f5d                      # seed prior conditional on being vouched for
        self.fix_multiplier = fix_multiplier      # multiply the outflow denominator too
        self.fix_seed_divisor = fix_seed_divisor  # divide by PRESENT seeds only

def bfs_distances(outgoing, seeds):
    dist, q = {}, deque()
    for s in sorted(seeds):
        dist[s] = 0; q.append(s)
    while q:
        cur = q.popleft(); d = dist[cur]
        for nb in sorted(outgoing.get(cur, {})):
            if nb not in dist:
                dist[nb] = d + 1; q.append(nb)
    return dist

def decay_pow(base, dist):
    r = S
    for _ in range(dist): r = fp_mul(r, base)
    return r

def initialize_scores(nodes, cfg, outgoing, distances):
    n = len(nodes)
    if n == 0: return {}
    if not cfg.seeds:
        return {v: S // n for v in nodes}

    # who counts as a seed for endowment purposes
    eff_seeds = set(cfg.seeds)
    if cfg.f5d:
        # a seed only holds the prior if someone else vouches for it
        vouched = {t for a, es in outgoing.items() for t, w in es.items() if w > 0 and a != t}
        eff_seeds = {s for s in cfg.seeds if s in vouched}
        if not eff_seeds:                       # documented cliff: fall back to uniform
            return {v: S // n for v in nodes}
    if cfg.fix_seed_divisor:
        eff_seeds = {s for s in eff_seeds if s in nodes}
        if not eff_seeds:
            return {v: S // n for v in nodes}

    trusted_count = len(eff_seeds) if (cfg.f5d or cfg.fix_seed_divisor) else len(cfg.seeds)
    if cfg.f15:
        regulars = [v for v in nodes if v not in eff_seeds and v in distances]
    else:
        regulars = [v for v in nodes if v not in eff_seeds]
    regular_count = len(regulars)

    trusted_score = cfg.trust_share // trusted_count if trusted_count else 0
    regular_score = (S - cfg.trust_share) // regular_count if regular_count else 0
    out = {}
    for v in nodes:
        if v in eff_seeds: out[v] = trusted_score
        elif cfg.f15 and v not in distances: out[v] = 0
        else: out[v] = regular_score
    return out

def calculate(nodes, outgoing, cfg, return_iters=False):
    nodes = sorted(nodes)
    n = len(nodes)
    if n == 0: return ({}, 0) if return_iters else {}
    distances = bfs_distances(outgoing, cfg.seeds) if cfg.seeds else None
    initial = initialize_scores(nodes, cfg, outgoing, distances or {})
    current = dict(initial)
    base_teleport = S - cfg.damping
    iters_run = cfg.max_iterations
    converged = False

    for it in range(cfg.max_iterations):
        new_scores, max_delta = {}, 0
        for recipient in nodes:
            new_score = fp_mul(base_teleport, initial[recipient])
            if distances is not None and recipient not in distances:
                new_scores[recipient] = new_score
                continue
            for attester in nodes:
                if attester == recipient: continue
                edges = outgoing.get(attester)
                if not edges: continue
                total_base, to_recipient = 0, None
                for target in sorted(edges):
                    w = edges[target]
                    if target == attester or w == 0: continue
                    eff_w = w
                    if cfg.fix_multiplier and attester in cfg.seeds:
                        eff_w = fp_mul(w, cfg.trust_multiplier)
                    total_base += eff_w
                    if target == recipient: to_recipient = eff_w
                if total_base == 0: continue
                if to_recipient is None: continue
                if cfg.fix_multiplier:
                    eff = to_recipient
                else:
                    eff = fp_mul(to_recipient, cfg.trust_multiplier) if attester in cfg.seeds else to_recipient
                if distances is None: decay = S
                elif attester in distances: decay = decay_pow(cfg.trust_decay, distances[attester])
                else: decay = 0
                ratio = fp_div(eff, total_base)
                contribution = fp_mul(current[attester], ratio)
                contribution = fp_mul(contribution, decay)
                new_score += fp_mul(cfg.damping, contribution)
            prev = current[recipient]
            max_delta = max(max_delta, abs(new_score - prev))
            new_scores[recipient] = new_score
        current = new_scores
        if max_delta < cfg.tolerance:
            iters_run, converged = it + 1, True
            break

    total = sum(current.values())
    if total:
        current = {k: fp_div(v, total) for k, v in current.items()}
    return (current, iters_run, converged) if return_iters else current

def pct(x): return 100.0 * x / S

def graph_nodes(outgoing):
    ns = set()
    for a, es in outgoing.items():
        ns.add(a); ns.update(es)
    return sorted(ns)
