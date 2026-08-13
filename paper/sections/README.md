# Paper Sections

This directory contains the modularized sections of the "Verifiable Off-Chain Governance" paper.

## Structure

The paper has been split into 8 separate files for easier editing and collaboration:

1. **01-introduction.tex** - Introduction section
   - Overview of DAO governance challenges
   - Framework for three categories of governance innovation
   - High-level benefits and approach

2. **02-governance-bottleneck.tex** - The Governance Bottleneck: Smart Contracts
   - Computational constraints and their governance implications
   - Data isolation and cross-chain fragmentation
   - Synchronous execution and timing constraints
   - Requirements for breakthrough

3. **03-verifiable-services.tex** - Verifiable Services: Enabling New Governance Designs
   - Verifiable Services architecture and trust model
   - Zero-Knowledge Proofs for governance
   - Hybrid architecture combining both primitives
   - Security boundaries and implementation considerations

4. **04-attestation-governance.tex** - Attestation-based Governance Systems
   - Architecture of attestation-based governance
   - Use cases (liquid democracy, merit-based incentives, cross-DAO coordination)
   - Theoretical considerations and benefits

5. **05-collective-intelligence.tex** - Collective Intelligence through Verifiable Computation
   - Semantically rich preference expression
   - Deterministic processing pipelines
   - Preference learning and synthesis
   - Case study: proposal prioritization pipeline

6. **06-proactive-governance.tex** - From Reactive to Proactive Governance
   - Policy as Code architecture
   - Operational automation
   - Adaptive systems
   - Oversight mechanisms and theoretical limitations

7. **07-trustgraphs-synthesis.tex** - Synthesis: trustgraphs as Pioneering Implementation
   - Architecture realized in practice
   - Bootstrapping innovation
   - Collective intelligence validation
   - Quantitative success metrics and replication blueprint

8. **08-conclusion.tex** - Conclusion
   - Summary of framework and implications
   - Future directions

## Usage

These section files are included in the main `main.tex` file using `\input` commands:

```latex
\input{sections/01-introduction}
\input{sections/02-governance-bottleneck}
\input{sections/03-verifiable-services}
\input{sections/04-attestation-governance}
\input{sections/05-collective-intelligence}
\input{sections/06-proactive-governance}
\input{sections/07-trustgraphs-synthesis}
\input{sections/08-conclusion}
```

## Building the Paper

From the project root directory, run:

```bash
make
```

Or to clean and rebuild:

```bash
make clean && make
```

## Note

Each section file contains only the section content (starting with `\section{}`). The preamble, document setup, abstract, and bibliography commands remain in `main.tex`.
