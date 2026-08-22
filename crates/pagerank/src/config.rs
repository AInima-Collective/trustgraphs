use alloy_primitives::Address;
use std::collections::HashSet;
use wasm_bindgen::prelude::wasm_bindgen;

/// Trust configuration for Trust Aware PageRank
#[wasm_bindgen]
#[derive(Clone, Debug)]
pub struct TrustConfig {
    /// Set of trusted seed attestors (internal storage)
    #[wasm_bindgen(skip)]
    pub trusted_seeds: HashSet<Address>,
    /// Weight multiplier for attestations from trusted seeds (e.g., 2.0 = 2x weight)
    #[wasm_bindgen(js_name = trustMultiplier)]
    pub trust_multiplier: f64,
    /// Boost factor for initial scores of trusted seeds (0.0-1.0)
    #[wasm_bindgen(js_name = trustShare)]
    pub trust_share: f64,
    /// The decay factor for the trust distance degrees
    #[wasm_bindgen(js_name = trustDecay)]
    pub trust_decay: f64,
}

#[wasm_bindgen]
impl TrustConfig {
    /// Create a new TrustConfig for WASM
    #[wasm_bindgen(constructor)]
    pub fn new_wasm(
        trusted_seeds: Vec<String>,
        trust_multiplier: f64,
        trust_share: f64,
        trust_decay: f64,
    ) -> Self {
        let trusted_seeds =
            trusted_seeds.into_iter().map(|s| s.parse::<Address>().unwrap()).collect();
        Self { trusted_seeds, trust_multiplier, trust_share, trust_decay }
    }

    /// Set trusted seeds from a Vec of addresses (WASM-compatible)
    #[wasm_bindgen(js_name = setTrustedSeeds)]
    pub fn set_trusted_seeds_wasm(&mut self, seeds: Vec<String>) -> Result<(), String> {
        self.trusted_seeds.clear();
        for seed_str in seeds {
            let addr =
                seed_str.parse::<Address>().map_err(|e| format!("Invalid address: {}", e))?;
            self.trusted_seeds.insert(addr);
        }
        Ok(())
    }

    /// Get trusted seeds as a Vec of strings (WASM-compatible)
    #[wasm_bindgen(js_name = getTrustedSeeds)]
    pub fn get_trusted_seeds_wasm(&self) -> Vec<String> {
        self.trusted_seeds.iter().map(|addr| format!("{:?}", addr)).collect()
    }
}

impl Default for TrustConfig {
    fn default() -> Self {
        Self {
            trusted_seeds: HashSet::new(),
            trust_multiplier: 1.0, // No trust boost by default
            trust_share: 0.0,      // No initial share by default
            trust_decay: 0.0,      // No decay by default
        }
    }
}

impl TrustConfig {
    /// Create a new trust configuration with trusted seeds
    pub fn new(trusted_seeds: Vec<Address>) -> Self {
        Self {
            trusted_seeds: trusted_seeds.into_iter().collect(),
            trust_multiplier: 2.0, // Default 2x weight for trusted attestors
            trust_share: 0.15,     // Default 15% of total initial score goes to trusted seeds
            trust_decay: 0.8,      // Default 80% decay factor
        }
    }

    /// Set trust multiplier for attestations from trusted seeds
    pub fn with_trust_multiplier(mut self, multiplier: f64) -> Self {
        self.trust_multiplier = multiplier.max(1.0); // Ensure at least 1.0x
        self
    }

    /// Set trust share for initial scores (0.0-1.0)
    pub fn with_trust_share(mut self, share: f64) -> Self {
        self.trust_share = share.clamp(0.0, 1.0);
        self
    }

    /// Set trust decay for the trust distance degrees
    pub fn with_trust_decay(mut self, decay: f64) -> Self {
        self.trust_decay = decay.clamp(0.0, 1.0);
        self
    }

    /// Check if an address is a trusted seed
    pub fn is_trusted_seed(&self, address: &Address) -> bool {
        self.trusted_seeds.contains(address)
    }

    /// Add a trusted seed
    #[cfg(test)]
    pub fn add_trusted_seed(&mut self, address: Address) {
        self.trusted_seeds.insert(address);
    }

    /// Remove a trusted seed
    #[cfg(test)]
    pub fn remove_trusted_seed(&mut self, address: &Address) -> bool {
        self.trusted_seeds.remove(address)
    }

    /// Get all trusted seeds
    #[cfg(test)]
    pub fn get_trusted_seeds(&self) -> &HashSet<Address> {
        &self.trusted_seeds
    }
}

/// Configuration for the Trust Aware PageRank algorithm
#[wasm_bindgen]
#[derive(Clone, Debug)]
pub struct PageRankConfig {
    /// Damping factor (usually 0.85)
    #[wasm_bindgen(js_name = dampingFactor)]
    pub damping_factor: f64,
    /// Maximum number of iterations
    #[wasm_bindgen(js_name = maxIterations)]
    pub max_iterations: usize,
    /// Convergence threshold
    #[wasm_bindgen(js_name = tolerance)]
    pub tolerance: f64,
    /// Minimum weight value
    #[wasm_bindgen(js_name = minWeight)]
    pub min_weight: f64,
    /// Maximum weight value
    #[wasm_bindgen(js_name = maxWeight)]
    pub max_weight: f64,
    /// Trust configuration for Trust Aware PageRank (internal storage)
    #[wasm_bindgen(skip)]
    pub trust_config: TrustConfig,
}

impl Default for PageRankConfig {
    fn default() -> Self {
        Self {
            damping_factor: 0.85,
            max_iterations: 100,
            tolerance: 1e-6,
            min_weight: 0.0,
            max_weight: 100.0,
            trust_config: TrustConfig::default(),
        }
    }
}

impl PageRankConfig {
    /// Create configuration with trust settings
    pub fn with_trust_config(mut self, trust_config: TrustConfig) -> Self {
        self.trust_config = trust_config;
        self
    }

    /// Check if trust features are enabled
    pub fn has_trust_enabled(&self) -> bool {
        !self.trust_config.trusted_seeds.is_empty()
    }
}

#[wasm_bindgen]
impl PageRankConfig {
    /// Create a new PageRankConfig for WASM
    #[wasm_bindgen(constructor)]
    pub fn new_wasm(
        damping_factor: f64,
        max_iterations: usize,
        tolerance: f64,
        min_weight: f64,
        max_weight: f64,
        trust_config: TrustConfig,
    ) -> Self {
        Self { damping_factor, max_iterations, tolerance, min_weight, max_weight, trust_config }
    }

    /// Set trust configuration (WASM-compatible)
    #[wasm_bindgen(js_name = setTrustConfig)]
    pub fn set_trust_config_wasm(&mut self, trust_config: TrustConfig) -> Result<(), String> {
        self.trust_config = trust_config;
        Ok(())
    }

    /// Get trust configuration (WASM-compatible)
    #[wasm_bindgen(js_name = getTrustConfig)]
    pub fn get_trust_config_wasm(&self) -> TrustConfig {
        self.trust_config.clone()
    }
}
