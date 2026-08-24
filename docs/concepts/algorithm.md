# TrustAwarePageRank: Spam-Resistant Reputation Systems

> **Scope:** this is the *algorithm* spec — the trust-aware PageRank variant itself, kept
> deliberately implementation-agnostic. How the system runs it today (fixed-point arithmetic,
> epochs, and the SP1 zero-knowledge proof) is summarized in the closing section. The canonical
> implementation is `crates/pagerank-core`.

## Abstract

TrustAwarePageRank is an extension of the traditional PageRank algorithm designed to create spam-resistant reputation systems in decentralized networks. By incorporating trusted seed attestors, this approach prevents Sybil attacks and spam manipulation while maintaining the distributed nature of reputation computation.

## Table of Contents

- [Introduction](#introduction)
- [The Spam Problem in Traditional PageRank](#the-spam-problem-in-traditional-pagerank)
- [TrustAwarePageRank Solution](#trustawarepagerank-solution)
- [Algorithm Details](#algorithm-details)
- [Implementation Architecture](#implementation-architecture)
- [How this runs today](#how-this-runs-today)
- [References](#references)

## Introduction

Traditional reputation systems face a fundamental challenge: how to bootstrap trust in a network where anyone can create multiple identities (Sybil attack). While PageRank provides an elegant solution for ranking web pages based on link authority, applying it directly to attestation networks creates vulnerabilities that malicious actors can exploit.

TrustAwarePageRank addresses these vulnerabilities by introducing **trusted seed
attestors**: a carefully curated set of entities that receive the starting
endowment and define the directed reachability boundary for the computation.

## The Spam Problem in Traditional PageRank

### Vulnerability Overview

In a standard PageRank implementation applied to attestation networks:

1. **Equal Treatment**: All attestations are treated equally, regardless of the attester's reputation
2. **Bootstrap Problem**: New networks have no inherent trust structure
3. **Sybil Attacks**: Malicious actors can create numerous fake identities that attest to each other
4. **Spam Rings**: Coordinated networks of fake attestors can artificially inflate target scores

### Attack Vector Example

```
Legitimate Network:
Alice -> Bob -> Charlie -> Alice (natural attestation cycle)

Spam Network:
Spammer1 -> SpamTarget
Spammer2 -> SpamTarget
Spammer3 -> SpamTarget
Spammer1 -> Spammer2 -> Spammer3 -> Spammer1 (artificial boost cycle)
```

**Result**: SpamTarget can achieve higher PageRank scores than legitimate entities despite having no real endorsements.

## TrustAwarePageRank Solution

### Core Principles

1. **Trusted Seeds**: designate the accounts that split the configured starting share.
2. **Reachability Gate**: accounts with no directed path from a seed receive zero score.
3. **Trust Propagation**: seed standing flows through weighted vouches and the damping recurrence.
4. **Distance Decay**: an attester's outgoing influence falls with its distance from a seed.

### Trust Mechanics

The algorithm incorporates trust through three mechanisms:

1. **Attestation Weight Multiplier**: Trusted attestor endorsements receive weight `W_trust > 1`
2. **Initial Score Boost**: Trusted seeds start with higher initial PageRank scores
3. **Damping Factor Application**: Trust flows through the network via the standard PageRank damping mechanism

## Algorithm Details

### Modified PageRank Formula

```
PR(i) = (1-d) * T(i) + d * Σ(PR(j) * W(j,i) / L(j))
```

Where:

- `PR(i)` = PageRank score of node i
- `d` = damping factor (typically 0.85)
- `T(i)` = the **teleport vector** — and this is the load-bearing difference from vanilla
  PageRank. It is *seed-biased*, not uniform: a configured share of teleport mass
  (`trust_share`) is reserved for the trusted seeds and the remainder spreads only over
  seed-reachable non-seeds (TrustRank-style personalization). With a uniform `1/N`
  teleport, disconnected Sybil components would receive standing by construction.
- `W(j,i)` = weight of attestation from j to i
- `L(j)` = total outgoing attestation weight from j

The exact fixed-point recurrence (including rounding order) is defined by the
implementation of record, `crates/pagerank-core` — where this document and the code
disagree, the code governs.

`W(j,i) / L(j)` is always the vouch's base weight divided by the sum of the
attester's eligible outgoing base weights. The retired founder multiplier used
to multiply only the numerator. That created standing, diluted founders, left
downstream ratios unchanged, and could prevent convergence; schema v3 removes it.

Before damping, contributions from an attester at seed distance `k` are also
multiplied by `trust_decay^k`. An attester outside the seed-reachable set cannot
contribute.

### Initial Score Distribution

```
Initial_PR(i) = {
    trust_share / |TrustedSeeds|  if i ∈ TrustedSeeds
    (1 - trust_share) / |ReachableNonSeeds|  if i is seed-reachable and not a seed
    0                                      otherwise
}
```

Configured seeds are ranked nodes even when they have no live edges. This prevents an
absent seed's share from disappearing. After the fixed-point recurrence, scores are
normalised to exactly the precision scale with the remainder assigned in canonical account
order; a non-empty output therefore always totals 100%.

An unreachable component receives zero at every starting-share setting. Adding, removing,
or rewiring it cannot change any reachable account's score or payout. The create form still
defaults `trust_share` to 1 because that keeps the entire starting endowment with the seeds.

## Implementation Architecture

### System Components

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Attestation   │    │   Trust Seed    │    │   PageRank      │
│   Collection    │───▶│   Validation    │───▶│   Computation   │
│                 │    │                 │    │                 │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                        │                        │
         ▼                        ▼                        ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Graph Storage │    │   Trust Config  │    │   Score Storage │
│   (Adjacency)   │    │   Management    │    │   (Merkle Tree) │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

### Computation Pipeline

1. **Attestation Ingestion**: Collect attestations from various sources
2. **Trust Validation**: Verify attestor identities against trusted seed list
3. **Graph Construction**: Build weighted adjacency matrix
4. **Score Computation**: Execute TrustAwarePageRank algorithm
5. **Merkle Tree Storage**: Store scores in verifiable data structure
6. **On-Chain Commitment**: Publish merkle root for verification

## How this runs today

The implementation of record departs from this spec in mechanics, never in semantics:

- **Fixed-point, deterministic** — all arithmetic is integer fixed-point (1e18 scale) with
  `BTreeMap` iteration, so every runner reproduces the same bytes (`crates/pagerank-core`,
  the single source of truth compiled into the SP1 guest, the host, and the browser port).
- **Epochs** — attestations fold into an on-chain accumulator; anyone freezes a checkpoint
  (`MerkleSnapshot.trigger()`), and scores are computed over exactly that frozen input set.
- **Zero-knowledge proof** — the `{account → score}` merkle root is proven correct in the SP1
  zkVM and verified on-chain (`submitProof`), so consumers trust the math, not the machine
  that ran it. See the program overviews indexed in
  [networks and programs](./networks-and-programs.md).

## References

1. Page, L., Brin, S., Motwani, R., & Winograd, T. (1999). The PageRank Citation Ranking: Bringing Order to the Web
2. Gyöngyi, Z., Garcia-Molina, H., & Pedersen, J. (2004). Combating Web Spam with TrustRank
3. Kamvar, S. D., Schlosser, M. T., & Garcia-Molina, H. (2003). The Eigentrust Algorithm for Reputation Management in P2P Networks
4. Douceur, J. R. (2002). The Sybil Attack
5. EIP-712: Ethereum Typed Structured Data Hashing and Signing
6. Ethereum Attestation Service (EAS) Documentation

---

_This document is the algorithm specification. The implementation of record is `crates/pagerank-core`; where mechanics differ (fixed-point, epochs, ZK proving), that crate and the docs above govern._
