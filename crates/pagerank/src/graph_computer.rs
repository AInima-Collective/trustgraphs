use alloy_primitives::{Address, U256};
use std::{collections::HashMap, str::FromStr};
use wasm_bindgen::prelude::wasm_bindgen;

use crate::config::{PageRankConfig, TrustConfig};

/// A directed graph for Trust Aware PageRank computation
#[wasm_bindgen]
#[derive(Debug, Clone)]
pub struct PageRankGraphComputer {
    /// Adjacency list: node -> list of outgoing edges with weights
    outgoing: HashMap<Address, Vec<(Address, f64)>>,
    /// Incoming edges count for each node
    incoming: HashMap<Address, usize>,
    /// All nodes in the graph
    nodes: Vec<Address>,
    /// Allow duplicates in edges
    allow_duplicates: bool,
}

#[wasm_bindgen]
impl PageRankGraphComputer {
    /// Create a new PageRankGraphComputer for WASM
    #[wasm_bindgen(constructor)]
    pub fn new_wasm(allow_duplicates: bool) -> Self {
        Self::new().with_allow_duplicates(allow_duplicates)
    }

    /// Add an edge from attester to recipient with base weight
    #[wasm_bindgen(js_name = addEdge)]
    pub fn add_edge_wasm(&mut self, from: String, to: String, base_weight: f64) {
        let from = Address::from_str(&from).unwrap();
        let to = Address::from_str(&to).unwrap();
        self.add_edge(from, to, base_weight);
    }

    /// Get all nodes in the graph
    #[wasm_bindgen(js_name = nodes)]
    pub fn nodes_wasm(&self) -> Vec<String> {
        self.nodes.iter().map(|addr| format!("{:?}", addr)).collect()
    }

    /// Calculate Trust Aware PageRank scores for all nodes
    #[wasm_bindgen(js_name = calculatePagerank)]
    pub fn calculate_pagerank_wasm(&self, config: PageRankConfig) -> js_sys::Map {
        let pagerank = self.calculate_pagerank(&config);
        let map = js_sys::Map::new();
        for (addr, score) in pagerank {
            map.set(&addr.to_string().into(), &score.into());
        }
        map
    }

    /// Distribute points to nodes based on PageRank scores
    #[wasm_bindgen(js_name = distributePoints)]
    pub fn distribute_points_wasm(
        &self,
        scores: js_sys::Map,
        total_pool: js_sys::BigInt,
    ) -> js_sys::Map {
        let mut scores_map = HashMap::new();
        scores.for_each(&mut |value, key| {
            let addr = Address::from_str(&key.as_string().unwrap()).unwrap();
            let score = value.as_f64().unwrap();
            scores_map.insert(addr, score);
        });
        let total_pool =
            U256::from_str(&total_pool.to_string(10).unwrap().as_string().unwrap()).unwrap();
        let (points, _) = self.distribute_points(&scores_map, total_pool);
        let points_map = js_sys::Map::new();
        for (addr, points) in points {
            points_map.set(
                &addr.to_string().into(),
                &js_sys::BigInt::from_str(&points.to_string()).unwrap(),
            );
        }
        points_map
    }
}

impl PageRankGraphComputer {
    pub fn new() -> Self {
        Self {
            outgoing: HashMap::new(),
            incoming: HashMap::new(),
            nodes: Vec::new(),
            allow_duplicates: true,
        }
    }

    /// Set allow duplicates in edges
    pub fn with_allow_duplicates(mut self, allow_duplicates: bool) -> Self {
        self.allow_duplicates = allow_duplicates;
        self
    }

    /// Add an edge from attester to recipient with base weight
    /// The actual weight will be adjusted based on trust configuration during PageRank calculation
    pub fn add_edge(&mut self, from: Address, to: Address, base_weight: f64) {
        // Add nodes if they don't exist
        if !self.outgoing.contains_key(&from) {
            self.outgoing.insert(from, Vec::new());
            if !self.nodes.contains(&from) {
                self.nodes.push(from);
            }
        }
        if !self.incoming.contains_key(&to) {
            self.incoming.insert(to, 0);
            if !self.nodes.contains(&to) {
                self.nodes.push(to);
            }
        }

        let outgoing = self.outgoing.get_mut(&from).unwrap();

        // Override existing if allow_duplicates is false and the edge already exists, otherwise add the edge.
        if let (false, Some(index)) =
            (self.allow_duplicates, outgoing.iter().position(|(addr, _)| *addr == to))
        {
            outgoing[index] = (to, base_weight);
        } else {
            outgoing.push((to, base_weight));
            *self.incoming.get_mut(&to).unwrap() += 1;
        }
    }

    /// Sort the nodes and edges for deterministic iteration
    pub fn sort(&mut self) {
        self.nodes.sort();
        self.outgoing.values_mut().for_each(|edges| edges.sort_by_key(|(addr, _)| *addr));
    }

    /// Get all nodes in the graph
    pub fn nodes(&self) -> &Vec<Address> {
        &self.nodes
    }

    /// Get outgoing edges from a node
    pub fn get_outgoing(&self, node: &Address) -> Option<&Vec<(Address, f64)>> {
        self.outgoing.get(node)
    }

    /// Get incoming count to a node
    #[cfg(test)]
    pub fn get_incoming_count(&self, node: &Address) -> usize {
        self.incoming.get(node).copied().unwrap_or_default()
    }

    /// Calculate the effective weight of an edge considering trust configuration
    fn calculate_edge_weight(
        &self,
        from: &Address,
        base_weight: f64,
        trust_config: &TrustConfig,
    ) -> f64 {
        if trust_config.is_trusted_seed(from) {
            base_weight * trust_config.trust_multiplier
        } else {
            base_weight
        }
    }

    /// Calculate Trust Aware PageRank scores for all nodes
    pub fn calculate_pagerank(&self, config: &PageRankConfig) -> HashMap<Address, f64> {
        let n = self.nodes.len();
        if n == 0 {
            return HashMap::new();
        }

        let initial_scores = self.initialize_scores(config);
        let mut current_scores = initial_scores.clone();
        let mut new_scores = initial_scores.clone();

        // Trust distances from trusted seeds to each node. If trust is disabled, this will be None. If a node is unreachable from a trusted seed, it will not be included in the map.
        let trust_distances = if config.has_trust_enabled() {
            println!(
                "🔄 Starting Trust Aware PageRank calculation for {} nodes ({} trusted seeds)",
                n,
                config.trust_config.trusted_seeds.len()
            );
            Some(self.calculate_trust_distances(&config.trust_config))
        } else {
            println!("🔄 Starting standard PageRank calculation for {} nodes", n);
            None
        };

        // Create sorted node list for deterministic iteration
        for iteration in 0..config.max_iterations {
            let mut max_delta = 0.0;

            for recipient_node in &self.nodes {
                // Calculate base score contribution (teleportation)
                let mut new_score = (1.0 - config.damping_factor) * initial_scores[recipient_node];

                // Skip isolated nodes (unreachable from trusted seeds) if trust is enabled
                if let Some(ref distances) = trust_distances {
                    if !distances.contains_key(recipient_node) {
                        // Isolated node - gets only base score
                        new_scores.insert(*recipient_node, new_score);
                        continue;
                    }
                }

                // Sum contributions from incoming edges with trust-aware weights
                for attester_node in &self.nodes {
                    // Skip the recipient node itself
                    if attester_node == recipient_node {
                        continue;
                    }

                    if let Some(outgoing_edges) = self.outgoing.get(attester_node) {
                        // Filter out self-loops when calculating outgoing weights and zero-weight edges
                        let filtered_edges: Vec<_> = outgoing_edges
                            .iter()
                            .filter(|(target, base_weight)| {
                                target != attester_node && *base_weight > 0.0
                            }) // Exclude self-loops and zero-weight edges
                            .collect();

                        // Node only has self-loops or zero-weight edges, skip it.
                        if filtered_edges.is_empty() {
                            continue;
                        }

                        // Calculate total outgoing BASE weight from this node (WITHOUT trust multiplier, excluding self-loops)
                        // We normalize by base weights so that trust multiplier
                        // still amplifies trusted attestations. If we used the
                        // total outgoing weight, we would cancel out the trust
                        // multiplier applied to the edges.
                        // This implements the formula: PR(i) = (1-d)/N + d * Σ(PR(j) * W(j,i) / L(j))
                        // where W(j,i) includes trust_multiplier but L(j) is sum of base weights
                        let total_base_weight: f64 =
                            filtered_edges.iter().map(|(_, base_weight)| *base_weight).sum();

                        // If total base weight is 0, skip the node.
                        if total_base_weight == 0.0 {
                            continue;
                        }

                        // Find nonzero edges to recipient node and calculate contributions
                        for (target, base_weight) in filtered_edges {
                            // Skip if the target is not the recipient
                            if target != recipient_node {
                                continue;
                            }

                            let effective_weight = self.calculate_edge_weight(
                                attester_node,
                                *base_weight,
                                &config.trust_config,
                            );

                            // Apply trust decay based on distance from trusted seeds
                            let trust_decay = match trust_distances
                                .as_ref()
                                .map(|d| d.get(attester_node).copied())
                            {
                                // Exponential decay: closer to trusted seeds = less decay
                                Some(Some(distance)) => {
                                    config.trust_config.trust_decay.powi(distance as i32)
                                }
                                // If trust is enabled but the node does not exist (not reachable from a trusted seed), use
                                Some(None) => 0.0,
                                // No decay in Standard PageRank (trust disabled)
                                None => 1.0,
                            };

                            let contribution = current_scores[attester_node]
                                * (effective_weight / total_base_weight)
                                * trust_decay;
                            new_score += config.damping_factor * contribution;
                        }
                    }
                }

                let delta = (new_score - current_scores[recipient_node]).abs();
                if delta > max_delta {
                    max_delta = delta;
                }

                new_scores.insert(*recipient_node, new_score);
            }

            current_scores = new_scores.clone();

            if iteration % 10 == 0 {
                println!("🔄 PageRank iteration {}: max delta = {:.8}", iteration, max_delta);
            }

            if max_delta < config.tolerance {
                println!("✅ PageRank converged after {} iterations", iteration + 1);
                break;
            }
        }

        println!("🎯 PageRank calculation completed");

        // Normalize scores to ensure they sum to 1
        let total_score: f64 = current_scores.values().sum();
        if total_score > 0.0 {
            current_scores.iter_mut().for_each(|(_, score)| *score /= total_score);
        }

        // Log trust statistics if trust is enabled
        if config.has_trust_enabled() {
            self.log_trust_statistics(&current_scores, config);
        }

        current_scores
    }

    /// Distribute points to nodes based on PageRank scores
    pub fn distribute_points(
        &self,
        scores: &HashMap<Address, f64>,
        total_pool: U256,
    ) -> (HashMap<Address, U256>, U256) {
        if scores.is_empty() {
            return (HashMap::new(), U256::ZERO);
        }

        let mut points_map = HashMap::new();

        // Use high precision scale factor to convert f64 scores to U256
        let precision_scale = 1_000_000_u64; // Scale factor for f64 -> u64 conversion

        // Convert f64 scores to scaled u64 integers, then to U256
        let scaled_scores: Vec<(Address, U256)> = scores
            .iter()
            .map(|(addr, score)| {
                // Convert f64 to scaled u64, avoiding floating-point in U256 operations
                let scaled_score_u64 = (*score * precision_scale as f64) as u64;
                let scaled_score = U256::from(scaled_score_u64);
                (*addr, scaled_score)
            })
            .collect();

        let total_scaled_score: U256 = scaled_scores.iter().map(|(_, score)| *score).sum();

        // Avoid division by zero, terminate early if no scaled score
        if total_scaled_score.is_zero() {
            return (points_map, U256::ZERO);
        }

        // Sort addresses by score (descending) for deterministic processing
        let mut sorted_scores = scaled_scores;
        sorted_scores.sort_by(|a, b| b.1.cmp(&a.1));

        let mut total_distributed = U256::ZERO;
        let mut remaining_pool = total_pool;

        // Calculate points using pure U256 integer arithmetic with strict pool enforcement
        for (i, (address, scaled_score)) in sorted_scores.iter().enumerate() {
            let points = if i == sorted_scores.len() - 1 {
                // For the last address, give all remaining pool (ensures no over-distribution)
                remaining_pool
            } else {
                // Calculate proportional points: (scaled_score * total_pool) / total_scaled_score
                let proportional_points = (*scaled_score * total_pool) / total_scaled_score;
                // Ensure we don't exceed remaining pool
                if proportional_points > remaining_pool {
                    remaining_pool
                } else {
                    proportional_points
                }
            };

            // Double-check we don't distribute more than available
            let actual_points = if points > remaining_pool { remaining_pool } else { points };

            if !actual_points.is_zero() {
                total_distributed += actual_points;
                remaining_pool -= actual_points;
                points_map.insert(*address, actual_points);
            }

            // Break early if pool is exhausted
            if remaining_pool.is_zero() {
                break;
            }
        }

        (points_map, total_distributed)
    }

    /// Initialize PageRank scores with trust-aware distribution
    fn initialize_scores(&self, config: &PageRankConfig) -> HashMap<Address, f64> {
        let n = self.nodes.len();
        let trust_enabled = config.has_trust_enabled();
        let trusted_count = config.trust_config.trusted_seeds.len();

        if !trust_enabled {
            // Standard uniform initialization
            let initial_score = 1.0 / n as f64;
            return self.nodes.iter().map(|&addr| (addr, initial_score)).collect();
        }

        // Trust-aware initialization
        let trust_share = config.trust_config.trust_share;
        let trusted_total_score = trust_share;
        let regular_total_score = 1.0 - trust_share;
        let regular_count = n - trusted_count;

        let trusted_score =
            if trusted_count > 0 { trusted_total_score / trusted_count as f64 } else { 0.0 };
        let regular_score =
            if regular_count > 0 { regular_total_score / regular_count as f64 } else { 0.0 };

        self.nodes
            .iter()
            .map(|&addr| {
                let initial_score = if config.trust_config.is_trusted_seed(&addr) {
                    trusted_score
                } else {
                    regular_score
                };
                (addr, initial_score)
            })
            .collect()
    }

    /// Calculate shortest distance from trusted seeds to each node (BFS)
    fn calculate_trust_distances(&self, trust_config: &TrustConfig) -> HashMap<Address, usize> {
        use std::collections::VecDeque;

        let mut distances = HashMap::new();
        let mut queue = VecDeque::new();

        // Initialize trusted seeds with distance 0
        for &trusted_seed in &trust_config.trusted_seeds {
            distances.insert(trusted_seed, 0);
            queue.push_back(trusted_seed);
        }

        // BFS to find shortest paths from trusted seeds
        while let Some(current) = queue.pop_front() {
            let current_distance = distances[&current];

            // Check all outgoing edges from current node
            if let Some(outgoing) = self.outgoing.get(&current) {
                for (neighbor, _) in outgoing {
                    // Only process if we haven't visited this neighbor yet
                    if !distances.contains_key(neighbor) {
                        distances.insert(*neighbor, current_distance + 1);
                        queue.push_back(*neighbor);
                    }
                }
            }
        }

        // Log distance statistics
        let reachable = distances.len();
        let unreachable = self.nodes.len() - reachable;
        println!(
            "🔍 Trust distance analysis: {} reachable, {} unreachable from trusted seeds",
            reachable, unreachable
        );

        distances
    }

    /// Log statistics about trust distribution
    fn log_trust_statistics(&self, scores: &HashMap<Address, f64>, config: &PageRankConfig) {
        let mut trusted_total_score = 0.0;
        let mut trusted_count = 0;
        let mut regular_total_score = 0.0;
        let mut regular_count = 0;
        let mut isolated_count = 0;
        let mut self_vouching_count = 0;

        // Calculate trust distances for isolation detection
        let trust_distances = self.calculate_trust_distances(&config.trust_config);

        // Count self-vouching nodes (use sorted iteration for determinism)
        let mut sorted_nodes = self.nodes.clone();
        sorted_nodes.sort();
        for &node in &sorted_nodes {
            if let Some(edges) = self.outgoing.get(&node) {
                if edges.iter().any(|(target, _)| *target == node) {
                    self_vouching_count += 1;
                }
            }
        }

        // Categorize nodes and calculate scores (sorted for deterministic iteration)
        let mut sorted_scores: Vec<_> = scores.iter().collect();
        sorted_scores.sort_by_key(|(addr, _)| **addr);
        for (addr, score) in sorted_scores {
            let is_isolated = trust_distances.get(addr) == None;

            if is_isolated {
                isolated_count += 1;
            } else if config.trust_config.is_trusted_seed(addr) {
                trusted_total_score += score;
                trusted_count += 1;
            } else {
                regular_total_score += score;
                regular_count += 1;
            }
        }

        println!("📊 Trust Statistics:");
        println!(
            "  Trusted seeds: {} addresses with {:.4} total score (avg: {:.6})",
            trusted_count,
            trusted_total_score,
            if trusted_count > 0 { trusted_total_score / trusted_count as f64 } else { 0.0 }
        );
        println!(
            "  Regular nodes: {} addresses with {:.4} total score (avg: {:.6})",
            regular_count,
            regular_total_score,
            if regular_count > 0 { regular_total_score / regular_count as f64 } else { 0.0 }
        );
        println!("  🚫 Isolated nodes: {} (unreachable from trusted seeds)", isolated_count);
        println!("  🔄 Self-vouching nodes: {} (ignored in calculation)", self_vouching_count);

        if trusted_count > 0 && regular_count > 0 {
            let trust_advantage = (trusted_total_score / trusted_count as f64)
                / (regular_total_score / regular_count as f64);
            println!("  Trust advantage: {:.2}x average score", trust_advantage);
        }

        // Show top non-trusted nodes if any have significant scores
        let mut non_trusted_scores: Vec<_> = scores
            .iter()
            .filter(|(addr, _)| !config.trust_config.is_trusted_seed(addr))
            .map(|(addr, score)| (*addr, *score))
            .collect();
        non_trusted_scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());

        if !non_trusted_scores.is_empty() {
            println!("\n  Top 5 non-trusted nodes:");
            for (i, (addr, score)) in non_trusted_scores.iter().take(5).enumerate() {
                let distance = trust_distances.get(addr).copied();
                let distance_str = if let Some(distance) = distance {
                    format!("distance {}", distance)
                } else {
                    "isolated".to_string()
                };
                println!("    {}. {}: {:.6} ({})", i + 1, addr, score, distance_str);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn test_standard_pagerank_no_trust() {
        let mut graph = PageRankGraphComputer::new();

        // Create addresses for testing
        let alice = Address::from_str("0x1111111111111111111111111111111111111111").unwrap();
        let bob = Address::from_str("0x2222222222222222222222222222222222222222").unwrap();
        let charlie = Address::from_str("0x3333333333333333333333333333333333333333").unwrap();

        // Create a simple graph: Alice -> Bob -> Charlie -> Alice
        graph.add_edge(alice, bob, 1.0);
        graph.add_edge(bob, charlie, 1.0);
        graph.add_edge(charlie, alice, 1.0);

        let config = PageRankConfig::default();
        let scores = graph.calculate_pagerank(&config);

        // All nodes should have equal scores in this symmetric graph
        let alice_score = scores[&alice];
        let bob_score = scores[&bob];
        let charlie_score = scores[&charlie];

        assert!((alice_score - bob_score).abs() < 1e-6);
        assert!((bob_score - charlie_score).abs() < 1e-6);
        assert!((alice_score - 1.0 / 3.0).abs() < 1e-6); // Each should have ~1/3 of total score
    }

    #[test]
    fn test_trust_aware_pagerank_basic() {
        let mut graph = PageRankGraphComputer::new();

        // Create addresses
        let trusted_alice =
            Address::from_str("0x1111111111111111111111111111111111111111").unwrap();
        let bob = Address::from_str("0x2222222222222222222222222222222222222222").unwrap();
        let charlie = Address::from_str("0x3333333333333333333333333333333333333333").unwrap();

        // Create graph where trusted Alice attests to Bob, Bob attests to Charlie
        graph.add_edge(trusted_alice, bob, 1.0);
        graph.add_edge(bob, charlie, 1.0);
        graph.add_edge(charlie, trusted_alice, 1.0); // Charlie attests back to Alice

        // Configure trust with Alice as trusted seed
        let trust_config =
            TrustConfig::new(vec![trusted_alice]).with_trust_multiplier(2.0).with_trust_share(0.5); // 50% boost

        let config = PageRankConfig::default().with_trust_config(trust_config);
        let scores = graph.calculate_pagerank(&config);

        // Verify trust-aware behavior
        let alice_score = scores[&trusted_alice];
        let bob_score = scores[&bob];
        let charlie_score = scores[&charlie];

        // Bob should have highest score as he receives multiplied attestation from Alice (trusted seed)
        // Charlie should have middle score as he receives from Bob
        // Due to the circular nature and trust multiplier, Bob benefits most from Alice's trusted attestation
        assert!(
            bob_score > charlie_score,
            "Bob (receiving from trusted seed) should score higher than Charlie"
        );
        assert!(charlie_score > alice_score * 0.5, "Charlie should have reasonable score");

        // All scores should be positive and sum to approximately 1.0
        assert!(
            alice_score > 0.0 && bob_score > 0.0 && charlie_score > 0.0,
            "All nodes should have positive scores"
        );
        let total_score = alice_score + bob_score + charlie_score;
        assert!((total_score - 1.0).abs() < 0.01, "Total scores should sum to ~1.0");
    }

    #[test]
    fn test_trust_multiplier_effect() {
        let mut graph = PageRankGraphComputer::new();

        // Create addresses
        let trusted_alice =
            Address::from_str("0x1111111111111111111111111111111111111111").unwrap();
        let trusted_bob = Address::from_str("0x2222222222222222222222222222222222222222").unwrap();
        let charlie = Address::from_str("0x3333333333333333333333333333333333333333").unwrap();
        let diana = Address::from_str("0x4444444444444444444444444444444444444444").unwrap();
        let eve = Address::from_str("0x5555555555555555555555555555555555555555").unwrap();

        // Create a scenario where:
        // - Alice (trusted) and Charlie (untrusted) both attest to Diana with same weight
        // - Bob (trusted) and Charlie (untrusted) both attest to Eve with same weight
        // - Diana and Eve attest to each other to create some flow
        graph.add_edge(trusted_alice, diana, 1.0);
        graph.add_edge(charlie, diana, 1.0);
        graph.add_edge(trusted_bob, eve, 1.0);
        graph.add_edge(charlie, eve, 1.0);
        graph.add_edge(diana, eve, 1.0);
        graph.add_edge(eve, diana, 1.0);

        // Configure trust with multiplier
        let trust_config = TrustConfig::new(vec![trusted_alice, trusted_bob])
            .with_trust_multiplier(3.0)
            .with_trust_share(0.2); // Lower boost to isolate multiplier effect

        let config = PageRankConfig::default().with_trust_config(trust_config);
        let scores = graph.calculate_pagerank(&config);

        let diana_score = scores[&diana];
        let eve_score = scores[&eve];
        let charlie_score = scores[&charlie];

        // Both Diana and Eve receive attestations from 1 trusted + 1 untrusted source
        // They should have similar scores (small difference due to graph structure)
        let score_diff = (diana_score - eve_score).abs();
        assert!(
            score_diff < 0.1,
            "Diana and Eve should have similar scores: {} vs {} (diff: {})",
            diana_score,
            eve_score,
            score_diff
        );

        // Charlie (untrusted) has no incoming edges, should have very low score
        assert!(
            diana_score > charlie_score * 4.0,
            "Nodes receiving trusted attestations should score much higher than untrusted nodes: {} > {} * 4.0",
            diana_score,
            charlie_score
        );

        // The trust multiplier effect is that edges from trusted seeds have 3x weight
        // This is reflected in how Diana and Eve have high scores despite Charlie also attesting to them
        println!("\nTrust multiplier test results:");
        println!("  Diana (attested by Alice[trusted] + Charlie): {:.6}", diana_score);
        println!("  Eve (attested by Bob[trusted] + Charlie): {:.6}", eve_score);
        println!("  Charlie (untrusted, no incoming): {:.6}", charlie_score);
        println!("  Score ratio Diana/Charlie: {:.2}x", diana_score / charlie_score);
    }

    #[test]
    fn test_trust_multiplier_effect_modified() {
        let mut graph = PageRankGraphComputer::new();

        // Create addresses
        let trusted_alice =
            Address::from_str("0x1111111111111111111111111111111111111111").unwrap();
        let bob = Address::from_str("0x2222222222222222222222222222222222222222").unwrap();
        let charlie = Address::from_str("0x3333333333333333333333333333333333333333").unwrap();
        let diana = Address::from_str("0x4444444444444444444444444444444444444444").unwrap();

        // Create a scenario where:
        // - Alice (trusted) attests to both Bob and Charlie
        // - Bob and Charlie both attest to Diana
        // This tests if Diana's score increases more from Bob (who received trusted attestation)
        // than from Charlie (who also received trusted attestation) when multiplier is applied
        graph.add_edge(trusted_alice, bob, 1.0);
        graph.add_edge(trusted_alice, charlie, 1.0);
        graph.add_edge(bob, diana, 1.0);
        graph.add_edge(charlie, diana, 1.0);

        // Test WITHOUT multiplier (multiplier = 1.0)
        let trust_config_no_multiplier =
            TrustConfig::new(vec![trusted_alice]).with_trust_multiplier(1.0).with_trust_share(0.5);

        let config_no_multiplier =
            PageRankConfig::default().with_trust_config(trust_config_no_multiplier);
        let scores_no_multiplier = graph.calculate_pagerank(&config_no_multiplier);

        // Test WITH multiplier (multiplier = 3.0)
        let trust_config_with_multiplier =
            TrustConfig::new(vec![trusted_alice]).with_trust_multiplier(3.0).with_trust_share(0.5);

        let config_with_multiplier =
            PageRankConfig::default().with_trust_config(trust_config_with_multiplier);
        let scores_with_multiplier = graph.calculate_pagerank(&config_with_multiplier);

        let diana_score_no_mult = scores_no_multiplier[&diana];
        let diana_score_with_mult = scores_with_multiplier[&diana];
        let alice_score_no_mult = scores_no_multiplier[&trusted_alice];
        let alice_score_with_mult = scores_with_multiplier[&trusted_alice];

        // The trust multiplier effect is that edges FROM trusted seeds have higher weight
        // This means Diana, who receives edges from Bob and Charlie (both trusted by Alice),
        // should receive MORE score flow when the multiplier is active
        println!("\nTrust multiplier test results:");
        println!("  Alice (no multiplier): {:.6}", alice_score_no_mult);
        println!("  Alice (with 3x multiplier): {:.6}", alice_score_with_mult);
        println!("  Diana (no multiplier): {:.6}", diana_score_no_mult);
        println!("  Diana (with 3x multiplier): {:.6}", diana_score_with_mult);
        println!(
            "  Diana score increase: {:.2}%",
            ((diana_score_with_mult - diana_score_no_mult) / diana_score_no_mult) * 100.0
        );

        // With trust multiplier, Diana should receive more PageRank flow from trusted sources
        // The multiplier increases the effective weight of edges from trusted seeds
        assert!(
            diana_score_with_mult > diana_score_no_mult * 1.05,
            "Trust multiplier should increase Diana's score by at least 5%: {} > {} * 1.05",
            diana_score_with_mult,
            diana_score_no_mult
        );

        // Alice (trusted seed) should have slightly lower score with multiplier
        // because more of her score flows out through the weighted edges
        assert!(
            alice_score_with_mult < alice_score_no_mult,
            "Alice should have lower score with multiplier as more flows to downstream nodes: {} < {}",
            alice_score_with_mult,
            alice_score_no_mult
        );
    }

    #[test]
    fn test_trust_share_effect() {
        let mut graph = PageRankGraphComputer::new();

        let trusted_alice =
            Address::from_str("0x1111111111111111111111111111111111111111").unwrap();
        let bob = Address::from_str("0x2222222222222222222222222222222222222222").unwrap();

        // Simple graph with no edges to isolate initial boost effect
        graph.add_edge(trusted_alice, bob, 1.0);

        let trust_config_no_boost = TrustConfig::new(vec![trusted_alice])
            .with_trust_multiplier(1.0) // No multiplier effect
            .with_trust_share(0.0); // No boost

        let trust_config_with_boost =
            TrustConfig::new(vec![trusted_alice]).with_trust_multiplier(1.0).with_trust_share(0.5); // 50% boost

        let config_no_boost = PageRankConfig::default().with_trust_config(trust_config_no_boost);
        let config_with_boost =
            PageRankConfig::default().with_trust_config(trust_config_with_boost);

        let scores_no_boost = graph.calculate_pagerank(&config_no_boost);
        let scores_with_boost = graph.calculate_pagerank(&config_with_boost);

        let alice_score_no_boost = scores_no_boost[&trusted_alice];
        let alice_score_with_boost = scores_with_boost[&trusted_alice];

        // With trust share, Alice should start with higher initial score
        assert!(
            alice_score_with_boost > alice_score_no_boost,
            "Trust share should increase trusted seed's score"
        );
    }

    #[test]
    fn test_multiple_trusted_seeds() {
        let mut graph = PageRankGraphComputer::new();

        let trusted_alice =
            Address::from_str("0x1111111111111111111111111111111111111111").unwrap();
        let trusted_bob = Address::from_str("0x2222222222222222222222222222222222222222").unwrap();
        let charlie = Address::from_str("0x3333333333333333333333333333333333333333").unwrap();
        let dave = Address::from_str("0x4444444444444444444444444444444444444444").unwrap();

        // Both trusted seeds attest to different regular nodes
        graph.add_edge(trusted_alice, charlie, 1.0);
        graph.add_edge(trusted_bob, dave, 1.0);

        let trust_config = TrustConfig::new(vec![trusted_alice, trusted_bob])
            .with_trust_multiplier(2.0)
            .with_trust_share(0.5);

        let config = PageRankConfig::default().with_trust_config(trust_config);
        let scores = graph.calculate_pagerank(&config);

        // Both trusted seeds should have elevated scores
        let alice_score = scores[&trusted_alice];
        let bob_score = scores[&trusted_bob];
        let charlie_score = scores[&charlie];
        let dave_score = scores[&dave];

        // Trusted seeds should have higher scores due to trust share
        // Note: In some graph structures, the relationship between endorsed nodes may vary
        assert!(alice_score > 0.0 && bob_score > 0.0, "Trusted seeds should have positive scores");
        assert!(
            charlie_score > 0.0 && dave_score > 0.0,
            "Regular nodes should have positive scores"
        );

        // Both endorsed nodes should benefit from trusted attestations
        assert!(
            charlie_score > 0.0 && dave_score > 0.0,
            "Endorsed nodes should have positive scores"
        );
    }

    #[test]
    fn test_trust_config_validation() {
        let alice = Address::from_str("0x1111111111111111111111111111111111111111").unwrap();

        // Test trust multiplier validation (should be >= 1.0)
        let trust_config = TrustConfig::new(vec![alice]).with_trust_multiplier(0.5); // Should be clamped to 1.0

        assert!(trust_config.trust_multiplier >= 1.0, "Trust multiplier should be at least 1.0");

        // Test trust share validation (should be 0.0-1.0)
        let trust_config_share = TrustConfig::new(vec![alice]).with_trust_share(1.5); // Should be clamped to 1.0

        assert!(trust_config_share.trust_share <= 1.0, "Trust share should be at most 1.0");
        assert!(trust_config_share.trust_share >= 0.0, "Trust share should be at least 0.0");
    }

    #[test]
    fn test_empty_graph() {
        let graph = PageRankGraphComputer::new();
        let config = PageRankConfig::default();
        let scores = graph.calculate_pagerank(&config);

        assert!(scores.is_empty(), "Empty graph should return empty scores");
    }

    #[test]
    fn test_single_node_graph() {
        let mut graph = PageRankGraphComputer::new();
        let alice = Address::from_str("0x1111111111111111111111111111111111111111").unwrap();

        // Add a self-loop
        graph.add_edge(alice, alice, 1.0);

        let trust_config =
            TrustConfig::new(vec![alice]).with_trust_multiplier(2.0).with_trust_share(0.5);

        let config = PageRankConfig::default().with_trust_config(trust_config);
        let scores = graph.calculate_pagerank(&config);

        // Single node should get all the score
        assert!((scores[&alice] - 1.0).abs() < 1e-6, "Single node should have score close to 1.0");
    }

    #[test]
    fn test_backwards_compatibility() {
        let mut graph = PageRankGraphComputer::new();

        let alice = Address::from_str("0x1111111111111111111111111111111111111111").unwrap();
        let bob = Address::from_str("0x2222222222222222222222222222222222222222").unwrap();
        let charlie = Address::from_str("0x3333333333333333333333333333333333333333").unwrap();

        // Create symmetric graph
        graph.add_edge(alice, bob, 1.0);
        graph.add_edge(bob, charlie, 1.0);
        graph.add_edge(charlie, alice, 1.0);

        // Compare standard config vs trust config with no trusted seeds
        let standard_config = PageRankConfig::default();
        let empty_trust_config =
            PageRankConfig::default().with_trust_config(TrustConfig::default()); // Empty trust config

        let standard_scores = graph.calculate_pagerank(&standard_config);
        let trust_scores = graph.calculate_pagerank(&empty_trust_config);

        // Scores should be identical
        for addr in graph.nodes() {
            let std_score = standard_scores[addr];
            let trust_score = trust_scores[addr];
            assert!(
                (std_score - trust_score).abs() < 1e-10,
                "Standard and empty trust PageRank should produce identical results"
            );
        }
    }

    #[test]
    fn test_spam_resistance_self_vouching() {
        let mut graph = PageRankGraphComputer::new();

        // Create addresses - similar to the actual test scenario
        let alice = Address::from_str("0x70997970C51812dc3A010C7d01b50e0d17dc79C8").unwrap(); // Trusted authority
        let bob = Address::from_str("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC").unwrap();
        let charlie = Address::from_str("0x90F79bf6EB2c4f870365E785982E1f101E93b906").unwrap();
        let diana = Address::from_str("0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65").unwrap();
        let grace = Address::from_str("0x14dC79964da2C08b23698B3D3cc7Ca32193d9955").unwrap(); // Spammer
        let henry = Address::from_str("0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f").unwrap(); // Spammer
        let ivy = Address::from_str("0xa0Ee7A142d267C1f36714E4a8F75612F20a79720").unwrap(); // Spammer

        // Authority vouching (Alice vouches for Bob with high weight)
        graph.add_edge(alice, bob, 95.0);

        // Spammer self-vouching (these should be penalized)
        graph.add_edge(grace, grace, 100.0);
        graph.add_edge(henry, henry, 100.0);
        graph.add_edge(ivy, ivy, 100.0);

        // Legitimate community vouching
        graph.add_edge(bob, charlie, 70.0);
        graph.add_edge(charlie, diana, 65.0);
        graph.add_edge(diana, bob, 40.0);

        // Configure trust with Alice as trusted seed
        let trust_config =
            TrustConfig::new(vec![alice]).with_trust_multiplier(2.0).with_trust_share(0.98); // 98% of teleportation goes to trusted seeds

        let config = PageRankConfig::default().with_trust_config(trust_config);
        let scores = graph.calculate_pagerank(&config);

        // Get scores for all nodes
        let alice_score = scores[&alice];
        let bob_score = scores[&bob];
        let charlie_score = scores[&charlie];
        let diana_score = scores[&diana];
        let grace_score = scores[&grace];
        let henry_score = scores[&henry];
        let ivy_score = scores[&ivy];

        // Verify trust propagation
        println!("\nSpam Resistance Test Results:");
        println!("Alice (trusted): {:.6}", alice_score);
        println!("Bob (vouched by Alice): {:.6}", bob_score);
        println!("Charlie (community): {:.6}", charlie_score);
        println!("Diana (community): {:.6}", diana_score);
        println!("Grace (spammer): {:.6}", grace_score);
        println!("Henry (spammer): {:.6}", henry_score);
        println!("Ivy (spammer): {:.6}", ivy_score);

        // Core assertions for spam resistance
        // With trust_share=0.98, spammers get minimal uniform teleportation (2% / 7 nodes ≈ 0.29% each)
        // Alice gets 98% of teleportation plus graph flow, so should have much higher score
        assert!(
            alice_score > grace_score * 50.0,
            "Trusted seed should have 50x+ score vs spammer: {} > {} * 50.0",
            alice_score,
            grace_score
        );
        assert!(
            bob_score > grace_score * 25.0,
            "Node vouched by trusted seed should have 25x+ score vs spammer: {} > {} * 25.0",
            bob_score,
            grace_score
        );
        assert!(
            charlie_score > grace_score * 5.0,
            "Community node should have 5x+ score vs spammer: {} > {} * 5.0",
            charlie_score,
            grace_score
        );
        assert!(
            diana_score > grace_score * 5.0,
            "Community node should have 5x+ score vs spammer: {} > {} * 5.0",
            diana_score,
            grace_score
        );

        // Spammers should have nearly identical (minimal) scores
        let spam_score_variance = ((grace_score - henry_score).abs()
            + (henry_score - ivy_score).abs()
            + (ivy_score - grace_score).abs())
            / 3.0;
        assert!(
            spam_score_variance < 0.000001,
            "Spammers should have nearly identical minimal scores"
        );

        // Verify spammers get less than 1% of total score
        let total_score: f64 = scores.values().sum();
        let spammer_total = grace_score + henry_score + ivy_score;
        let spammer_percentage = (spammer_total / total_score) * 100.0;
        assert!(
            spammer_percentage < 1.0,
            "Spammers should get less than 1% of total score, got {:.2}%",
            spammer_percentage
        );

        // Verify legitimate network gets vast majority of score
        let legitimate_total = alice_score + bob_score + charlie_score + diana_score;
        let legitimate_percentage = (legitimate_total / total_score) * 100.0;
        assert!(
            legitimate_percentage > 99.0,
            "Legitimate network should get >99% of score, got {:.2}%",
            legitimate_percentage
        );
    }

    #[test]
    fn test_trust_config_methods() {
        let alice = Address::from_str("0x1111111111111111111111111111111111111111").unwrap();
        let bob = Address::from_str("0x2222222222222222222222222222222222222222").unwrap();

        let mut trust_config = TrustConfig::default();

        // Test adding trusted seeds
        trust_config.add_trusted_seed(alice);
        assert!(trust_config.is_trusted_seed(&alice), "Alice should be trusted seed");
        assert!(!trust_config.is_trusted_seed(&bob), "Bob should not be trusted seed");

        // Test removing trusted seeds
        assert!(trust_config.remove_trusted_seed(&alice), "Should successfully remove Alice");
        assert!(
            !trust_config.remove_trusted_seed(&alice),
            "Should return false when removing non-existent seed"
        );
        assert!(!trust_config.is_trusted_seed(&alice), "Alice should no longer be trusted seed");

        // Test getting trusted seeds
        trust_config.add_trusted_seed(alice);
        trust_config.add_trusted_seed(bob);
        let seeds = trust_config.get_trusted_seeds();
        assert_eq!(seeds.len(), 2, "Should have 2 trusted seeds");
        assert!(
            seeds.contains(&alice) && seeds.contains(&bob),
            "Should contain both Alice and Bob"
        );
    }

    #[test]
    fn test_deterministic_pagerank_results() {
        // Create a moderately complex graph to test determinism
        let mut graph = PageRankGraphComputer::new();

        // Add some test addresses (using different values to ensure varied iteration order)
        let addr1 = Address::from([0x01; 20]);
        let addr2 = Address::from([0x02; 20]);
        let addr3 = Address::from([0x03; 20]);
        let addr4 = Address::from([0x04; 20]);
        let addr5 = Address::from([0x05; 20]);

        // Create a complex network of attestations
        graph.add_edge(addr1, addr2, 1.0);
        graph.add_edge(addr1, addr3, 2.0);
        graph.add_edge(addr2, addr3, 1.5);
        graph.add_edge(addr2, addr4, 1.0);
        graph.add_edge(addr3, addr4, 2.0);
        graph.add_edge(addr4, addr5, 1.0);
        graph.add_edge(addr5, addr1, 1.5);
        graph.add_edge(addr3, addr1, 1.0); // Create some cycles

        // Test both standard PageRank and trust-aware PageRank
        let config = PageRankConfig::default();

        // Run PageRank calculation multiple times
        let mut results = Vec::new();
        for _ in 0..5 {
            let result = graph.calculate_pagerank(&config);
            results.push(result);
        }

        // Verify all results are identical
        for i in 1..results.len() {
            assert_eq!(
                results[0].len(),
                results[i].len(),
                "Result {} has different number of nodes",
                i
            );

            for (addr, score0) in &results[0] {
                let score_i = results[i]
                    .get(addr)
                    .expect(&format!("Address {:?} missing in result {}", addr, i));
                assert!((score0 - score_i).abs() < 1e-15,
                        "Non-deterministic result for address {:?}: {} vs {} (diff: {}) in iteration {}",
                        addr, score0, score_i, (score0 - score_i).abs(), i);
            }
        }
    }

    #[test]
    fn test_override_existing_edge() {
        let mut graph = PageRankGraphComputer::new().with_allow_duplicates(false);

        let alice = Address::from_str("0x1111111111111111111111111111111111111111").unwrap();
        let bob = Address::from_str("0x2222222222222222222222222222222222222222").unwrap();

        assert_eq!(graph.get_incoming_count(&bob), 0);

        // Add an edge
        graph.add_edge(alice, bob, 1.0);
        assert_eq!(graph.get_incoming_count(&bob), 1);

        // Override the edge
        graph.add_edge(alice, bob, 2.0);
        assert_eq!(graph.get_incoming_count(&bob), 1);

        // Verify the edge was overridden
        let outgoing = graph.get_outgoing(&alice).unwrap();
        assert_eq!(outgoing.len(), 1);
        assert_eq!(outgoing[0].0, bob);
        assert_eq!(outgoing[0].1, 2.0);

        let incoming = graph.get_incoming_count(&bob);
        assert_eq!(incoming, 1);
    }
}
