# TrustAwarePageRank: Spam-Resistant Reputation Systems

> **Scope:** this is the *algorithm* spec — the trust-aware PageRank variant itself, kept
> deliberately implementation-agnostic. How the system runs it today (fixed-point arithmetic,
> epochs, the SP1 zero-knowledge proof) is summarized in the closing section and detailed in
> [`research/ZK_ARCHITECTURE.md`](../../research/ZK_ARCHITECTURE.md). The canonical
> implementation is `packages/pagerank-core`.

## Abstract

TrustAwarePageRank is an extension of the traditional PageRank algorithm designed to create spam-resistant reputation systems in decentralized networks. By incorporating trusted seed attestors, this approach prevents Sybil attacks and spam manipulation while maintaining the distributed nature of reputation computation.

## Table of Contents

- [Introduction](#introduction)
- [The Spam Problem in Traditional PageRank](#the-spam-problem-in-traditional-pagerank)
- [TrustAwarePageRank Solution](#trustawarepagerank-solution)
- [Algorithm Details](#algorithm-details)
- [Implementation Architecture](#implementation-architecture)
- [How this runs today](#how-this-runs-today)
- [Future Work](#future-work)
- [References](#references)

## Introduction

Traditional reputation systems face a fundamental challenge: how to bootstrap trust in a network where anyone can create multiple identities (Sybil attack). While PageRank provides an elegant solution for ranking web pages based on link authority, applying it directly to attestation networks creates vulnerabilities that malicious actors can exploit.

TrustAwarePageRank addresses these vulnerabilities by introducing the concept of **trusted seed attestors** - a carefully curated set of entities whose attestations carry additional weight and authority in the reputation computation.

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

1. **Trusted Seeds**: Designate a set of trusted attestors whose endorsements carry additional weight
2. **Weighted Attestations**: Attestations from trusted seeds receive higher weight in score computation
3. **Trust Propagation**: Higher initial scores for trusted seeds allow trust to flow through the network
4. **Spam Isolation**: Spam networks become isolated from trusted pathways, reducing their influence

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
  (`trust_share`) is reserved for the trusted seeds and only the remainder spreads over
  everyone else (TrustRank-style personalization). With a uniform `1/N` teleport, the
  seeds' initial boost would wash out at convergence and Sybil isolation would fail.
- `W(j,i)` = weight of attestation from j to i
- `L(j)` = total outgoing attestation weight from j

The exact fixed-point recurrence (including rounding order) is defined by the
implementation of record, `packages/pagerank-core` — where this document and the code
disagree, the code governs.

### Weight Assignment

```
W(j,i) = {
    W_trust * base_weight  if j ∈ TrustedSeeds
    base_weight           otherwise
}
```

### Initial Score Distribution

```
Initial_PR(i) = {
    trust_share / |TrustedSeeds|  if i ∈ TrustedSeeds
    (1 - trust_share) / (N - |TrustedSeeds|)  otherwise
}
```

Exact isolation of a component that is unreachable from the trusted seeds requires
`trust_share = 1`: then its teleport term is zero as well as its incoming trust flow. At
any lower value, non-seed accounts divide `1 - trust_share` and therefore keep a positive
baseline even when they are unreachable. The create form defaults to `1` and warns before
a community chooses a lower value.

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
  `BTreeMap` iteration, so every runner reproduces the same bytes (`packages/pagerank-core`,
  the single source of truth compiled into the SP1 guest, the host, and the browser port).
- **Epochs** — attestations fold into an on-chain accumulator; anyone freezes a checkpoint
  (`MerkleSnapshot.trigger()`), and scores are computed over exactly that frozen input set.
- **Zero-knowledge proof** — the `{account → score}` merkle root is proven correct in the SP1
  zkVM and verified on-chain (`submitProof`), so consumers trust the math, not the machine
  that ran it. See [`research/ZK_ARCHITECTURE.md`](../../research/ZK_ARCHITECTURE.md) and the
  per-program operations docs indexed in [networks and programs](./networks-and-programs.md).

## Future Work

### 1. Temporal Dynamics

- Time-decay functions for aging attestations
- Periodic trust seed rotation
- Historical reputation tracking
- Seasonal adjustment mechanisms

### 2. Multi-Schema Support

- Multiple attestation types with different weights
- Cross-schema reputation aggregation
- Domain-specific trust metrics
- Hierarchical trust structures

### 3. Advanced Trust Propagation

- Personalized PageRank variants
- Trust transitivity analysis
- Multi-hop trust validation
- Dynamic trust threshold adjustment

### 4. Scalability Optimizations

- Incremental computation updates
- Distributed computation sharding
- Advanced merkle tree structures
- Real-time score approximations

## References

1. Page, L., Brin, S., Motwani, R., & Winograd, T. (1999). The PageRank Citation Ranking: Bringing Order to the Web
2. Gyöngyi, Z., Garcia-Molina, H., & Pedersen, J. (2004). Combating Web Spam with TrustRank
3. Kamvar, S. D., Schlosser, M. T., & Garcia-Molina, H. (2003). The Eigentrust Algorithm for Reputation Management in P2P Networks
4. Douceur, J. R. (2002). The Sybil Attack
5. EIP-712: Ethereum Typed Structured Data Hashing and Signing
6. Ethereum Attestation Service (EAS) Documentation

---

_This document is the algorithm specification. The implementation of record is `packages/pagerank-core`; where mechanics differ (fixed-point, epochs, ZK proving), that crate and the docs above govern._
