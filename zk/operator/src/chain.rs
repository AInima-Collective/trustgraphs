//! The RPC side: reads that build an `InstanceState`, and the two writes that cost money.
//!
//! Everything here is mechanical. Every decision is in `operator-core`.

use alloy_primitives::{keccak256, Address, B256, U256};
use alloy_sol_types::{sol, SolCall, SolEvent, SolValue};
use anyhow::{anyhow, bail, Context, Result};
use operator_core::catalog::{
    CatalogEntry, ChainReader, CompositionControllerParams, ContributionsControllerParams,
    ControllerParams, CreatedParams, RegistryRecord, SignerSyncDescriptor,
    VersionedCompositionParams, WeightedControllerParams, WeightedCreatedParams,
};
use operator_core::types::{CheckpointRef, Commitments};
use pagerank_core::{Params, SelectionParams};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::fmt;

sol! {
    /// Mirror of `ParamsCodec.Params` (params schema v2 — 17 fields, order FROZEN).
    struct SolParams {
        uint256 dampingFp; uint256 toleranceFp; uint32 maxIterations; uint256 minWeightFp;
        uint256 maxWeightFp; uint256 trustShareFp; uint256 trustDecayFp;
        address[] trustedSeeds; uint256 totalPool; uint256 precisionScale; bytes32 schemaUid;
        uint32 weightFieldIndex; bytes32[] envelope0DomainSeparators; uint64 lane2MaxHeadAge;
        address accumulator; uint64 chainId;
    }

    struct SolContributionsParams {
        uint256 dampingFp; uint256 toleranceFp; uint32 maxIterations; uint256 minWeightFp;
        uint256 maxWeightFp; uint256 trustShareFp; uint256 trustDecayFp;
        address[] trustedSeeds; uint256 precisionScale; uint32 weightFieldIndex;
        uint64 roundStart; uint64 roundEnd; uint256 unacceptedMultFp; uint256 collaboratorMultFp;
        uint256 minRaterRepFp; uint32 evaluatorCarveoutBps; uint256 totalPool;
        bytes32 claimSchemaUid; bytes32 responseSchemaUid; bytes32 valuationSchemaUid;
    }

    /// Mirror of `WeightedPriorParamsCodec.Params` (isolated V1, 13 static fields, order FROZEN).
    struct SolWeightedParams {
        uint32 version; uint64 dampingFp; uint64 toleranceFp; uint32 maxIterations;
        uint64 minWeight; uint64 maxWeight; bytes32 priorRoot; uint32 priorCount;
        bytes32 manifestSha256; bytes32 schemaUid; uint32 weightFieldIndex;
        address accumulator; uint64 chainId;
    }

    /// Mirror of `TrustComposeParamsCodec.Params` (isolated V1, 20 frozen words).
    struct SolCompositionParams {
        uint32 version; bytes32 programId; bytes32 scopeHash; bytes32 identityDomain;
        bytes32 outputKind; bytes32 outputDomain; bytes32 admittedProgramId; uint64 weightScale;
        uint128 outputPool; bytes32 sourcePolicyRoot; uint8 sourceCount;
        bytes32 policyManifestSha256; uint8 maxSources; uint32 maxEntriesPerSource;
        uint32 maxAggregateEntries; uint32 maxUnionAccounts; uint32 maxAggregateBlobBytes;
        uint64 maxSourceAgeBlocks; address accumulator; uint64 chainId;
    }

    event InstanceCreated(
        bytes32 indexed instanceId, address indexed creator, address indexed admin,
        string name, string metadataURI, address resolver, bytes32 schemaUid, address snapshot,
        address distributor, address distributorToken, uint64 epochLength, SolParams params
    );

    event WeightedInstanceCreated(
        bytes32 indexed instanceId, address indexed creator, address indexed admin,
        string name, string metadataURI, address resolver, bytes32 schemaUid, address snapshot,
        address distributor, address distributorToken, uint64 epochLength,
        bytes32 metadataDigest, SolWeightedParams params
    );

    /// `SignerSyncModuleDeployer`: emitted in the same governed creation receipt.
    event SignerSyncModuleConfigured(
        bytes32 indexed instanceId, address indexed safe, address indexed signerSyncModule,
        bytes32 operatorInstanceId, address scoreSnapshot, address activitySource,
        address accumulator, address verifier,
        bytes32 programVKey, bytes32 selectionParamsHash, uint32 topN, uint32 minThreshold,
        uint32 targetThresholdBps, uint64 maxInactiveBlocks, uint32 minActivityWitnesses
    );

    struct Instance {
        bytes32 program; address snapshot; address verifier;
        address registryOrAccumulator; bytes32 paramsHash;
    }
    event InstanceRegistered(
        bytes32 indexed instanceId, bytes32 indexed program, address snapshot, address verifier,
        address registryOrAccumulator, bytes32 paramsHash
    );
    function getInstanceIds() external view returns (bytes32[]);
    function getInstance(bytes32 instanceId) external view returns (Instance);
    function paramsAuthority(bytes32 instanceId) external view returns (address);

    /// `TrustgraphsParamsController`.
    function instanceId() external view returns (bytes32);
    function snapshot() external view returns (address);
    function version() external view returns (uint64);
    function currentParamsHash() external view returns (bytes32);
    function getCurrentParams() external view returns (SolParams);
    event ParamsUpdated(
        bytes32 indexed instanceId, uint64 indexed version, bytes32 indexed paramsHash,
        bytes32 previousParamsHash, SolParams params, string evidenceURI
    );

    /// `ContributionsParamsController`.
    function eas() external view returns (address);
    function getContributionsParams() external view returns (SolContributionsParams);
    event ContributionsParamsUpdated(
        bytes32 indexed instanceId, uint64 indexed version, bytes32 indexed paramsHash,
        bytes32 previousParamsHash, SolContributionsParams params, string evidenceURI
    );

    event InitialPriorPublished(
        bytes32 indexed instanceId, uint64 indexed version, bytes32 indexed paramsHash,
        bytes32 metadataDigest, SolWeightedParams params
    );
    event PriorProposed(
        bytes32 indexed instanceId, uint64 indexed version, bytes32 indexed proposalId,
        bytes32 priorRoot, uint32 priorCount, bytes32 manifestSha256, bytes32 metadataDigest,
        bytes32 paramsHash, uint48 readyAt
    );
    event PriorActivated(
        bytes32 indexed instanceId, uint64 indexed version, bytes32 indexed paramsHash,
        bytes32 previousParamsHash, bytes32 proposalId, bytes32 metadataDigest,
        SolWeightedParams params
    );

    event InitialPolicyPublished(
        bytes32 indexed instanceId, uint64 indexed version, bytes32 indexed paramsHash,
        bytes32 adapterSetHash, bytes32 metadataDigest, SolCompositionParams params
    );
    event PolicyActivated(
        bytes32 indexed instanceId, uint64 indexed version, bytes32 indexed paramsHash,
        bytes32 previousParamsHash, bytes32 proposalId, bytes32 adapterSetHash,
        bytes32 metadataDigest, SolCompositionParams params
    );
    struct SolPendingPrior {
        uint64 version; uint48 readyAt; bytes32 proposalId; bytes32 priorRoot;
        uint32 priorCount; bytes32 manifestSha256; bytes32 metadataDigest; bytes32 paramsHash;
    }
    function getPendingPrior() external view returns (SolPendingPrior);

    /// Transaction-input recovery selectors. Solidity names are intentionally unique here; the
    /// encoded selectors are supplied explicitly where their return type would otherwise collide.
    struct WeightedCreateArgs {
        string name; string metadataURI; SolWeightedParams params; bytes manifest;
        bytes32 metadataDigest; address admin; uint64 epochLength; bool withDistributor;
        address distributorToken; bytes32 salt;
    }
    struct WeightedInitialPolicy {
        uint64 minPaidIntervalBlocks; uint96 maxPerRootUsd;
    }
    struct WeightedSignerSyncConfig {
        bool enabled; uint32 topN; uint32 minThreshold; uint32 targetThresholdBps;
    }
    function createInstance(WeightedCreateArgs args)
        external payable returns (bytes32, address, address, address, bytes32);
    function createGovernedInstance(
        WeightedCreateArgs requested,
        WeightedInitialPolicy policy,
        WeightedSignerSyncConfig signerSync
    ) external payable returns (bytes32, address, address, address);
    function proposePrior(bytes manifest, bytes32 metadataDigest)
        external returns (uint64, bytes32, uint48);

    /// `MerkleSnapshot` — journal v3.
    function paramsHash() external view returns (bytes32);
    function checkpointParamsHash(uint256 checkpointId) external view returns (bytes32);
    function checkpointRecipient(uint256 checkpointId) external view returns (address);
    function epochLength() external view returns (uint64);
    function lastTriggerBlock() external view returns (uint64);
    function hasAppliedCheckpoint() external view returns (bool);
    function lastAppliedCheckpoint() external view returns (uint256);
    function zkVerifier() external view returns (address);
    function accumulator() external view returns (address);
    function anchorRegistry() external view returns (address);
    function anchorCheckpoints(uint256 checkpointId) external view returns (bytes32 anchorAcc, uint64 anchorCount);
    function checkpointWorkCount(uint256 checkpointId) external view returns (uint64);
    function instanceDomain() external view returns (bytes32);
    function trigger() external returns (uint256);
    function submitProof(
        uint256 checkpointId, bytes32 outputRoot, bytes32 ipfsHash, string ipfsHashCid,
        uint256 totalValue, bytes32 skippedDigest, address recipient, bytes proof
    ) external;
    struct MerkleState {
        uint256 blockNumber; uint256 timestamp; bytes32 root; bytes32 ipfsHash;
        string ipfsHashCid; uint256 totalValue;
    }
    function getStateAtBlock(uint256 blockNumber) external view returns (MerkleState);
    event MerkleProofSubmitted(
        uint256 indexed checkpointId, bytes32 indexed root, address indexed prover,
        address recipient
    );

    /// `SignerSyncZkModule` reads/writes.
    function paused() external view returns (bool);
    function selectionParamsHash() external view returns (bytes32);
    function scoreSnapshot() external view returns (address);
    function submitSignerProof(
        uint256 checkpointId, uint256 activityCheckpointId, address[] signers,
        uint256 targetThreshold, bytes proof
    ) external;

    /// `AttestationAccumulator`.
    struct Checkpoint { bytes32 acc; uint64 leafCount; uint64 blockNumber; }
    function leafCount() external view returns (uint64);
    function checkpointCount() external view returns (uint256);
    function getCheckpoint(uint256 id) external view returns (Checkpoint);
    function acc() external view returns (bytes32);
    function getCaptureManifest(uint256 checkpointId) external view returns (bytes);
    function currentCaptureManifest() external view returns (bytes);

    /// `AnchorRegistry`.
    function anchorAcc() external view returns (bytes32);
    function anchorCount() external view returns (uint64);
    function workCount() external view returns (uint64);
    function maxTotalInputs() external view returns (uint64);

    /// `TrustgraphsFactory`.
    function EAS() external view returns (address);

    /// `SP1JournalVerifier`.
    function programVKey() external view returns (bytes32);

    /// `ProvingVault` — the funded path. Mirrors `IProvingVault.SubmitArgs` exactly.
    struct SubmitArgs {
        uint256 checkpointId; bytes32 outputRoot; bytes32 ipfsHash; string ipfsHashCid;
        uint256 totalValue; bytes32 skippedDigest; address recipient; bytes proof;
        uint256 minPayoutUsd;
    }
    function submitAndClaim(bytes32 instanceId, SubmitArgs args)
        external returns (uint256 feeUsd, uint256 gasUsd);
}

pub struct Rpc {
    client: reqwest::blocking::Client,
    url: String,
    /// One factory `EAS()` read serves every instance it minted.
    eas_cache: RefCell<BTreeMap<Address, Address>>,
}

/// A JSON-RPC response error kept structured long enough for the transaction adapter to tell an
/// EVM execution revert from a provider/transport failure. Most reads still treat both as an
/// ordinary `anyhow::Error`; only submit preflight needs the distinction.
#[derive(Debug)]
pub(crate) struct RpcResponseError {
    method: String,
    code: Option<i64>,
    message: String,
    data: Value,
}

impl RpcResponseError {
    pub(crate) fn is_execution_revert(&self) -> bool {
        // Geth uses code 3 for execution errors, including custom-error reverts whose only useful
        // detail is hex data. Other clients commonly use -32000/-32015 and a textual marker.
        if self.code == Some(3) {
            return true;
        }
        let text = format!("{} {}", self.message, self.data).to_ascii_lowercase();
        text.contains("execution reverted")
            || text.contains("execution error")
            || text.contains("vm execution error")
            || text.contains("revert reason")
            || text.contains(" reverted")
    }
}

impl fmt::Display for RpcResponseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} RPC error (code {}): {}{}",
            self.method,
            self.code.map_or_else(|| "unknown".to_string(), |c| c.to_string()),
            self.message,
            if self.data.is_null() { String::new() } else { format!("; data={}", self.data) }
        )
    }
}

impl std::error::Error for RpcResponseError {}

/// How long a single JSON-RPC round trip may take before the tick gives up on it.
///
/// There has to be a limit, and the default has to be finite. reqwest imposes none, and a
/// provider that accepts the connection and never answers — which is what an overloaded one
/// actually does, rather than refusing — then stops the daemon permanently: no tick, no
/// `tick_failed`, no alert, no recovery, until a human notices and restarts it. A timeout turns
/// that into an ordinary failed tick, which the loop already handles by re-reading everything
/// from chain on the next pass.
pub const DEFAULT_RPC_TIMEOUT_SECONDS: u64 = 30;

impl Rpc {
    pub fn with_timeout(url: String, timeout: std::time::Duration) -> Self {
        let client = reqwest::blocking::Client::builder()
            .timeout(timeout)
            // Separate from the overall budget on purpose: a host that is simply unreachable
            // should fail in seconds, not sit out the whole request timeout.
            .connect_timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        Self { client, url, eas_cache: RefCell::new(BTreeMap::new()) }
    }

    /// One JSON-RPC round trip. `pub(crate)` because `tx.rs` extends `Rpc` with the write-side
    /// methods and needs the same transport rather than a second one.
    pub(crate) fn call(&self, method: &str, params: Value) -> Result<Value> {
        let body = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
        let resp: Value = self
            .client
            .post(&self.url)
            .json(&body)
            .send()?
            .json()
            .with_context(|| format!("{method}: response was not JSON"))?;
        if let Some(e) = resp.get("error").filter(|e| !e.is_null()) {
            return Err(RpcResponseError {
                method: method.to_string(),
                code: e.get("code").and_then(Value::as_i64),
                message: e
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("unspecified JSON-RPC error")
                    .to_string(),
                data: e.get("data").cloned().unwrap_or(Value::Null),
            }
            .into());
        }
        Ok(resp.get("result").cloned().unwrap_or(Value::Null))
    }

    fn hex_u64(v: &Value) -> Result<u64> {
        let s = v.as_str().ok_or_else(|| anyhow!("expected a hex string, got {v}"))?;
        Ok(u64::from_str_radix(s.trim_start_matches("0x"), 16)?)
    }

    pub fn eth_chain_id(&self) -> Result<u64> {
        Self::hex_u64(&self.call("eth_chainId", json!([]))?)
    }

    pub fn block_number(&self) -> Result<u64> {
        Self::hex_u64(&self.call("eth_blockNumber", json!([]))?)
    }

    /// Head basefee, in wei. Absent (pre-1559 or a chain that omits it) reads as zero, which can
    /// only make the basefee gate more permissive — and on such a chain the gate is meaningless
    /// anyway.
    pub fn basefee(&self) -> Result<u128> {
        let b = self.call("eth_getBlockByNumber", json!(["latest", false]))?;
        match b.get("baseFeePerGas").and_then(|v| v.as_str()) {
            Some(s) => Ok(u128::from_str_radix(s.trim_start_matches("0x"), 16)?),
            None => Ok(0),
        }
    }

    pub fn block_hash(&self, number: u64) -> Result<Option<B256>> {
        let b = self.call("eth_getBlockByNumber", json!([format!("0x{number:x}"), false]))?;
        Ok(b.get("hash").and_then(|v| v.as_str()).and_then(|s| {
            s.trim_start_matches("0x").parse::<B256>().ok().or_else(|| {
                hex::decode(s.trim_start_matches("0x"))
                    .ok()
                    .and_then(|b| (b.len() == 32).then(|| B256::from_slice(&b)))
            })
        }))
    }

    pub fn eth_call(&self, to: Address, data: Vec<u8>) -> Result<Vec<u8>> {
        let params = json!([{ "to": to, "data": format!("0x{}", hex::encode(&data)) }, "latest"]);
        let r = self.call("eth_call", params)?;
        let s = r.as_str().ok_or_else(|| anyhow!("eth_call returned no data"))?;
        Ok(hex::decode(s.trim_start_matches("0x"))?)
    }

    /// Simulate a state-changing call from `from`. A revert here is a hold, not a broadcast: it is
    /// the difference between noticing a paused instance and paying to discover it.
    ///
    /// `gas` is the limit the REAL transaction will carry (H-3): without it a node simulates at
    /// its own cap, so a call that only reverts because our limit is too small passes simulation
    /// and then burns the full limit on-chain.
    pub fn simulate(
        &self,
        from: Address,
        to: Address,
        data: &[u8],
        gas: Option<u64>,
    ) -> Result<()> {
        let mut obj = json!({ "from": from, "to": to, "data": format!("0x{}", hex::encode(data)) });
        if let Some(g) = gas {
            obj["gas"] = json!(format!("0x{g:x}"));
        }
        self.call("eth_call", json!([obj, "latest"])).map(|_| ())
    }

    /// `eth_estimateGas` for a call from `from`. A revert during estimation is an `Err` — the
    /// same hold-not-broadcast semantics as [`Self::simulate`] (H-3: the estimate is also what
    /// keeps a hard-coded limit from either under-gassing a revert or over-paying a griefed one).
    pub fn estimate_gas(&self, from: Address, to: Address, data: &[u8]) -> Result<u64> {
        let params = json!([
            { "from": from, "to": to, "data": format!("0x{}", hex::encode(data)) },
            "latest"
        ]);
        Self::hex_u64(&self.call("eth_estimateGas", params)?)
    }

    pub fn logs(
        &self,
        address: Address,
        topic0: B256,
        from: u64,
        to: u64,
        chunk: u64,
    ) -> Result<Vec<RawLog>> {
        let mut out = Vec::new();
        let mut start = from;
        while start <= to {
            let end = (start.saturating_add(chunk.saturating_sub(1))).min(to);
            let params = json!([{
                "address": address,
                "topics": [format!("0x{}", hex::encode(topic0))],
                "fromBlock": format!("0x{start:x}"),
                "toBlock": format!("0x{end:x}"),
            }]);
            let r = self.call("eth_getLogs", params)?;
            for log in r.as_array().ok_or_else(|| anyhow!("eth_getLogs non-array"))? {
                out.push(RawLog::parse(log)?);
            }
            if end == to {
                break;
            }
            start = end + 1;
        }
        Ok(out)
    }

    pub fn receipt_logs(&self, tx: B256) -> Result<Vec<RawLog>> {
        let r =
            self.call("eth_getTransactionReceipt", json!([format!("0x{}", hex::encode(tx))]))?;
        let logs = r.get("logs").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        logs.iter().map(RawLog::parse).collect()
    }

    /// Exact input bytes retained by an archival JSON-RPC node. This is the last-resort recovery
    /// source for weighted manifests and must therefore fail closed when the provider prunes it.
    pub fn transaction_input(&self, tx: B256) -> Result<Vec<u8>> {
        let value =
            self.call("eth_getTransactionByHash", json!([format!("0x{}", hex::encode(tx))]))?;
        anyhow::ensure!(!value.is_null(), "transaction {tx:#x} is unavailable from this RPC");
        let input = value
            .get("input")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("transaction {tx:#x} has no input field"))?;
        Ok(hex::decode(input.trim_start_matches("0x"))?)
    }
}

pub struct RawLog {
    pub address: Address,
    pub topics: Vec<B256>,
    pub data: Vec<u8>,
    pub block_number: u64,
    pub transaction_hash: B256,
}

impl RawLog {
    fn parse(v: &Value) -> Result<Self> {
        let h = |s: &str| -> Result<B256> {
            let b = hex::decode(s.trim_start_matches("0x"))?;
            anyhow::ensure!(b.len() == 32, "expected a 32-byte value, got {} bytes", b.len());
            Ok(B256::from_slice(&b))
        };
        Ok(Self {
            address: v["address"].as_str().unwrap_or_default().parse()?,
            topics: v["topics"]
                .as_array()
                .map(|a| a.iter().filter_map(|t| t.as_str()).map(h).collect::<Result<Vec<_>>>())
                .transpose()?
                .unwrap_or_default(),
            data: hex::decode(v["data"].as_str().unwrap_or("0x").trim_start_matches("0x"))?,
            block_number: v["blockNumber"]
                .as_str()
                .map(|s| u64::from_str_radix(s.trim_start_matches("0x"), 16))
                .transpose()?
                .unwrap_or(0),
            transaction_hash: h(v["transactionHash"].as_str().unwrap_or_default())?,
        })
    }
}

/// The registry's `InstanceRegistered` history, scanned once and then kept up to date
/// incrementally.
///
/// Two things here were operational defects, and both were found by running the daemon against a
/// mainnet fork rather than a fresh anvil.
///
/// 1. **The scan started at block 0.** On a chain whose registry was deployed at block 21,000,000
///    that is ~2,100 `eth_getLogs` calls returning nothing, every tick — and most public providers
///    refuse the range outright ("archive requests require a personal token"), so the daemon did
///    not merely run slowly, it never got a catalog at all and every tick failed. `from_block` is
///    now the registry's deployment block, and it is configuration rather than a constant.
/// 2. **It rescanned per program, per tick.** Three supported programs meant three identical full
///    scans a minute. Registrations are append-only and a scanned block never changes its logs, so
///    the map is now built once and extended from `scanned_to + 1` on each subsequent pass.
///
/// The one thing this deliberately does NOT do is rewind on a reorg. A registration that gets
/// re-orged out leaves a stale map entry, which makes `created_params` read a receipt that no
/// longer exists — a per-instance `ReadFailed` skip, self-healing on the next restart. Dropping
/// entries newer than `head - confirmations` instead would delete real ones every time the chain
/// merely paused.
#[derive(Debug, Default)]
pub struct RegistryScan {
    /// instance id -> (block, registering transaction).
    pub registered_in: BTreeMap<B256, (u64, B256)>,
    /// Highest block already covered. `None` before the first scan.
    pub scanned_to: Option<u64>,
}

/// The block range a refresh should ask for, or `None` when there is nothing to ask.
///
/// Split out from [`RegistryScan::refresh`] so the bookkeeping is testable without a chain. Every
/// off-by-one here costs either a missed registration (an instance that never gets proven) or a
/// re-scan of the whole history (the defect this exists to fix), so it is worth its own tests.
fn scan_range(scanned_to: Option<u64>, from_block: u64, head: u64) -> Option<(u64, u64)> {
    match scanned_to {
        // Already covered. A head that went BACKWARDS lands here too, which is right: a reorg
        // shallower than the scan does not un-register anything.
        Some(to) if to >= head => None,
        Some(to) => Some((to + 1, head)),
        None if from_block > head => None,
        None => Some((from_block, head)),
    }
}

impl RegistryScan {
    /// Bring the map up to `head`, scanning only what is new.
    pub fn refresh(
        &mut self,
        rpc: &Rpc,
        registry: Address,
        from_block: u64,
        head: u64,
    ) -> Result<()> {
        let Some((start, end)) = scan_range(self.scanned_to, from_block, head) else {
            return Ok(());
        };
        let logs = rpc.logs(registry, InstanceRegistered::SIGNATURE_HASH, start, end, 10_000)?;
        for log in &logs {
            if let Some(id) = log.topics.get(1) {
                // First registration wins; `update()` emits a different event.
                self.registered_in.entry(*id).or_insert((log.block_number, log.transaction_hash));
            }
        }
        self.scanned_to = Some(end);
        Ok(())
    }
}

#[cfg(test)]
mod scan_range_tests {
    use super::scan_range;

    #[test]
    fn a_first_scan_starts_at_the_registry_deployment_not_at_genesis() {
        // The whole point of `registry_from_block`. Starting at 0 against a mainnet registry is
        // ~2,100 empty getLogs calls, and most providers reject the range outright.
        assert_eq!(scan_range(None, 21_000_000, 21_000_500), Some((21_000_000, 21_000_500)));
    }

    #[test]
    fn a_later_scan_covers_only_new_blocks() {
        assert_eq!(
            scan_range(Some(21_000_500), 21_000_000, 21_000_512),
            Some((21_000_501, 21_000_512))
        );
    }

    #[test]
    fn no_new_blocks_asks_for_nothing() {
        assert_eq!(scan_range(Some(21_000_500), 21_000_000, 21_000_500), None);
    }

    #[test]
    fn a_shallow_reorg_does_not_trigger_a_rescan() {
        // Head going backwards is not a reason to re-read history: nothing un-registers.
        assert_eq!(scan_range(Some(21_000_500), 21_000_000, 21_000_490), None);
    }

    #[test]
    fn a_registry_from_a_future_block_asks_for_nothing() {
        // Misconfiguration, or a node still syncing. Asking for an inverted range would error;
        // asking for nothing lets the next tick recover on its own.
        assert_eq!(scan_range(None, 21_000_000, 20_999_999), None);
    }

    #[test]
    fn consecutive_scans_leave_no_gap() {
        // The invariant that matters: every block from `from_block` to the final head is covered
        // exactly once across a sequence of refreshes.
        let mut covered: Vec<u64> = Vec::new();
        let mut scanned_to = None;
        for head in [105u64, 105, 110, 112] {
            if let Some((s, e)) = scan_range(scanned_to, 100, head) {
                covered.extend(s..=e);
                scanned_to = Some(e);
            }
        }
        assert_eq!(covered, (100..=112).collect::<Vec<_>>());
    }
}

/// `operator-core`'s catalog, over live RPC. Borrows a [`RegistryScan`] rather than owning one, so
/// the history survives the tick that built it.
pub struct RpcCatalog<'a> {
    pub rpc: &'a Rpc,
    pub registry: Address,
    pub registered_in: &'a BTreeMap<B256, (u64, B256)>,
}

impl<'a> RpcCatalog<'a> {
    pub fn new(rpc: &'a Rpc, registry: Address, scan: &'a RegistryScan) -> Self {
        Self { rpc, registry, registered_in: &scan.registered_in }
    }
}

impl ChainReader for RpcCatalog<'_> {
    type Error = anyhow::Error;

    fn chain_id(&self) -> Result<u64> {
        self.rpc.eth_chain_id()
    }

    fn instance_ids(&self) -> Result<Vec<B256>> {
        let ret = self.rpc.eth_call(self.registry, getInstanceIdsCall {}.abi_encode())?;
        Ok(getInstanceIdsCall::abi_decode_returns(&ret)?)
    }

    fn instance_record(&self, id: B256) -> Result<RegistryRecord> {
        let ret =
            self.rpc.eth_call(self.registry, getInstanceCall { instanceId: id }.abi_encode())?;
        let r = getInstanceCall::abi_decode_returns(&ret)?;
        Ok(RegistryRecord {
            program: r.program,
            snapshot: r.snapshot,
            verifier: r.verifier,
            registry_or_accumulator: r.registryOrAccumulator,
            params_hash: r.paramsHash,
        })
    }

    fn params_authority(&self, id: B256) -> Result<Address> {
        let ret = self
            .rpc
            .eth_call(self.registry, paramsAuthorityCall { instanceId: id }.abi_encode())?;
        Ok(paramsAuthorityCall::abi_decode_returns(&ret)?)
    }

    fn registration_block(&self, id: B256) -> Result<u64> {
        self.registered_in
            .get(&id)
            .map(|(block, _)| *block)
            .ok_or_else(|| anyhow!("no InstanceRegistered event for {id:#x}"))
    }

    fn created_params(&self, id: B256) -> Result<Option<CreatedParams>> {
        let Some((created_block, tx)) = self.registered_in.get(&id).copied() else {
            return Ok(None);
        };
        let logs = self.rpc.receipt_logs(tx)?;
        let Some(log) = logs.iter().find(|l| {
            l.topics.first() == Some(&InstanceCreated::SIGNATURE_HASH)
                && l.topics.get(1) == Some(&id)
        }) else {
            return Ok(None);
        };
        let ev = InstanceCreated::decode_raw_log(log.topics.iter().copied(), &log.data)?;
        let signer_logs = logs
            .iter()
            .filter(|candidate| {
                candidate.topics.first() == Some(&SignerSyncModuleConfigured::SIGNATURE_HASH)
                    && candidate.topics.get(1) == Some(&id)
            })
            .collect::<Vec<_>>();
        anyhow::ensure!(
            signer_logs.len() <= 1,
            "creation receipt for {id:#x} has {} signer configuration events",
            signer_logs.len()
        );
        let signer_sync = signer_logs
            .first()
            .map(|signer_log| {
                let configured = SignerSyncModuleConfigured::decode_raw_log(
                    signer_log.topics.iter().copied(),
                    &signer_log.data,
                )?;
                Ok::<_, anyhow::Error>(SignerSyncDescriptor {
                    operator_instance_id: configured.operatorInstanceId,
                    module: configured.signerSyncModule,
                    safe: configured.safe,
                    score_snapshot: configured.scoreSnapshot,
                    activity_source: configured.activitySource,
                    accumulator: configured.accumulator,
                    verifier: configured.verifier,
                    program_vkey: configured.programVKey,
                    selection_params_hash: configured.selectionParamsHash,
                    selection: SelectionParams {
                        top_n: configured.topN,
                        min_threshold: configured.minThreshold,
                        target_threshold_bps: configured.targetThresholdBps,
                        max_inactive_blocks: configured.maxInactiveBlocks,
                        min_activity_witnesses: configured.minActivityWitnesses,
                    },
                })
            })
            .transpose()?;
        Ok(Some(CreatedParams {
            factory: log.address,
            name: ev.name.clone(),
            snapshot: ev.snapshot,
            resolver: ev.resolver,
            created_block,
            params: to_core_params(&ev.params),
            signer_sync,
        }))
    }

    fn controller_params(&self, controller: Address) -> Result<ControllerParams> {
        let call = |data: Vec<u8>| self.rpc.eth_call(controller, data);
        let instance_id =
            instanceIdCall::abi_decode_returns(&call(instanceIdCall {}.abi_encode())?)?;
        let snapshot = snapshotCall::abi_decode_returns(&call(snapshotCall {}.abi_encode())?)?;
        let version = versionCall::abi_decode_returns(&call(versionCall {}.abi_encode())?)?;
        let current_params_hash = currentParamsHashCall::abi_decode_returns(&call(
            currentParamsHashCall {}.abi_encode(),
        )?)?;
        let params =
            getCurrentParamsCall::abi_decode_returns(&call(getCurrentParamsCall {}.abi_encode())?)?;
        Ok(ControllerParams {
            instance_id,
            snapshot,
            version,
            current_params_hash,
            params: to_core_params(&params),
        })
    }

    fn contributions_controller_params(
        &self,
        controller: Address,
    ) -> Result<ContributionsControllerParams> {
        let call = |data: Vec<u8>| self.rpc.eth_call(controller, data);
        let instance_id =
            instanceIdCall::abi_decode_returns(&call(instanceIdCall {}.abi_encode())?)?;
        let snapshot = snapshotCall::abi_decode_returns(&call(snapshotCall {}.abi_encode())?)?;
        let eas = easCall::abi_decode_returns(&call(easCall {}.abi_encode())?)?;
        let version = versionCall::abi_decode_returns(&call(versionCall {}.abi_encode())?)?;
        let current_params_hash = currentParamsHashCall::abi_decode_returns(&call(
            currentParamsHashCall {}.abi_encode(),
        )?)?;
        let params = getContributionsParamsCall::abi_decode_returns(&call(
            getContributionsParamsCall {}.abi_encode(),
        )?)?;
        Ok(ContributionsControllerParams {
            instance_id,
            snapshot,
            eas,
            version,
            current_params_hash,
            params: to_contributions_params(&params),
        })
    }

    fn weighted_controller_params(&self, controller: Address) -> Result<WeightedControllerParams> {
        let call = |data: Vec<u8>| self.rpc.eth_call(controller, data);
        let instance_id =
            instanceIdCall::abi_decode_returns(&call(instanceIdCall {}.abi_encode())?)?;
        let snapshot = snapshotCall::abi_decode_returns(&call(snapshotCall {}.abi_encode())?)?;
        let version = versionCall::abi_decode_returns(&call(versionCall {}.abi_encode())?)?;
        let current_params_hash = currentParamsHashCall::abi_decode_returns(&call(
            currentParamsHashCall {}.abi_encode(),
        )?)?;
        // `getCurrentParams()` has the same selector as the binary controller method. The call
        // encoding is reusable; its return is decoded against the isolated 13-field tuple.
        let raw = call(getCurrentParamsCall {}.abi_encode())?;
        let params = SolWeightedParams::abi_decode(&raw)?;
        Ok(WeightedControllerParams {
            instance_id,
            snapshot,
            version,
            current_params_hash,
            params: to_weighted_params(&params),
        })
    }

    fn composition_controller_params(
        &self,
        controller: Address,
    ) -> Result<CompositionControllerParams> {
        let call = |data: Vec<u8>| self.rpc.eth_call(controller, data);
        let instance_id =
            instanceIdCall::abi_decode_returns(&call(instanceIdCall {}.abi_encode())?)?;
        let snapshot = snapshotCall::abi_decode_returns(&call(snapshotCall {}.abi_encode())?)?;
        let version = versionCall::abi_decode_returns(&call(versionCall {}.abi_encode())?)?;
        let current_params_hash = currentParamsHashCall::abi_decode_returns(&call(
            currentParamsHashCall {}.abi_encode(),
        )?)?;
        let raw = call(getCurrentParamsCall {}.abi_encode())?;
        let params = SolCompositionParams::abi_decode(&raw)?;
        Ok(CompositionControllerParams {
            instance_id,
            snapshot,
            version,
            current_params_hash,
            params: to_composition_params(&params)?,
        })
    }

    fn weighted_created_params(&self, id: B256) -> Result<Option<WeightedCreatedParams>> {
        let Some((created_block, tx)) = self.registered_in.get(&id).copied() else {
            return Ok(None);
        };
        let logs = self.rpc.receipt_logs(tx)?;
        let Some(log) = logs.iter().find(|candidate| {
            candidate.topics.first() == Some(&WeightedInstanceCreated::SIGNATURE_HASH)
                && candidate.topics.get(1) == Some(&id)
        }) else {
            return Ok(None);
        };
        let event = WeightedInstanceCreated::decode_raw_log(log.topics.iter().copied(), &log.data)?;
        Ok(Some(WeightedCreatedParams {
            factory: log.address,
            name: event.name,
            snapshot: event.snapshot,
            resolver: event.resolver,
            created_block,
        }))
    }

    fn snapshot_params_hash(&self, snapshot: Address) -> Result<B256> {
        let ret = self.rpc.eth_call(snapshot, paramsHashCall {}.abi_encode())?;
        Ok(paramsHashCall::abi_decode_returns(&ret)?)
    }

    fn factory_eas(&self, factory: Address) -> Result<Address> {
        if let Some(a) = self.rpc.eas_cache.borrow().get(&factory) {
            return Ok(*a);
        }
        let ret = self.rpc.eth_call(factory, EASCall {}.abi_encode())?;
        let a = EASCall::abi_decode_returns(&ret)?;
        self.rpc.eas_cache.borrow_mut().insert(factory, a);
        Ok(a)
    }
}

fn to_core_params(p: &SolParams) -> Params {
    Params {
        damping_fp: p.dampingFp,
        tolerance_fp: p.toleranceFp,
        max_iterations: p.maxIterations,
        min_weight_fp: p.minWeightFp,
        max_weight_fp: p.maxWeightFp,
        trust_share_fp: p.trustShareFp,
        trust_decay_fp: p.trustDecayFp,
        trusted_seeds: p.trustedSeeds.clone(),
        total_pool: p.totalPool,
        precision_scale: p.precisionScale,
        schema_uid: p.schemaUid,
        weight_field_index: p.weightFieldIndex,
        envelope0_domain_separators: p.envelope0DomainSeparators.clone(),
        lane2_max_head_age: p.lane2MaxHeadAge,
        accumulator: p.accumulator,
        chain_id: p.chainId,
    }
}

fn to_contributions_params(p: &SolContributionsParams) -> contributions_core::Params {
    contributions_core::Params {
        damping_fp: p.dampingFp,
        tolerance_fp: p.toleranceFp,
        max_iterations: p.maxIterations,
        min_weight_fp: p.minWeightFp,
        max_weight_fp: p.maxWeightFp,
        trust_share_fp: p.trustShareFp,
        trust_decay_fp: p.trustDecayFp,
        trusted_seeds: p.trustedSeeds.clone(),
        precision_scale: p.precisionScale,
        weight_field_index: p.weightFieldIndex,
        round_start: p.roundStart,
        round_end: p.roundEnd,
        unaccepted_mult_fp: p.unacceptedMultFp,
        collaborator_mult_fp: p.collaboratorMultFp,
        min_rater_rep_fp: p.minRaterRepFp,
        evaluator_carveout_bps: p.evaluatorCarveoutBps,
        total_pool: p.totalPool,
        claim_schema_uid: p.claimSchemaUid,
        response_schema_uid: p.responseSchemaUid,
        valuation_schema_uid: p.valuationSchemaUid,
    }
}

fn to_weighted_params(p: &SolWeightedParams) -> weighted_prior_core::Params {
    weighted_prior_core::Params {
        version: p.version,
        damping_fp: p.dampingFp,
        tolerance_fp: p.toleranceFp,
        max_iterations: p.maxIterations,
        min_weight: p.minWeight,
        max_weight: p.maxWeight,
        prior_root: p.priorRoot,
        prior_count: p.priorCount,
        manifest_sha256: p.manifestSha256,
        schema_uid: p.schemaUid,
        weight_field_index: p.weightFieldIndex,
        accumulator: p.accumulator,
        chain_id: p.chainId,
    }
}

/// Both trust-compose generations share this 20-word ABI shape; word 0 selects the semantic
/// decoder. Under V1 the sixth word is the singular admitted program; under V2 it is the closed
/// source compatibility class and must never surface under the V1 field name. An unknown version
/// fails before any witness work or proof spend — there is no "latest composition" fallback.
fn to_composition_params(p: &SolCompositionParams) -> Result<VersionedCompositionParams> {
    match p.version {
        1 => Ok(VersionedCompositionParams::V1(composition_core::Params {
            version: p.version,
            program_id: p.programId,
            scope_hash: p.scopeHash,
            identity_domain: p.identityDomain,
            output_kind: p.outputKind,
            output_domain: p.outputDomain,
            admitted_program_id: p.admittedProgramId,
            weight_scale: p.weightScale,
            output_pool: p.outputPool,
            source_policy_root: p.sourcePolicyRoot,
            source_count: p.sourceCount,
            policy_manifest_sha256: p.policyManifestSha256,
            max_sources: p.maxSources,
            max_entries_per_source: p.maxEntriesPerSource,
            max_aggregate_entries: p.maxAggregateEntries,
            max_union_accounts: p.maxUnionAccounts,
            max_aggregate_blob_bytes: p.maxAggregateBlobBytes,
            max_source_age_blocks: p.maxSourceAgeBlocks,
            accumulator: p.accumulator,
            chain_id: p.chainId,
        })),
        2 => Ok(VersionedCompositionParams::V2(composition_core_v2::Params {
            version: p.version,
            program_id: p.programId,
            scope_hash: p.scopeHash,
            identity_domain: p.identityDomain,
            output_kind: p.outputKind,
            output_domain: p.outputDomain,
            source_compatibility_class: p.admittedProgramId,
            weight_scale: p.weightScale,
            output_pool: p.outputPool,
            source_policy_root: p.sourcePolicyRoot,
            source_count: p.sourceCount,
            policy_manifest_sha256: p.policyManifestSha256,
            max_sources: p.maxSources,
            max_entries_per_source: p.maxEntriesPerSource,
            max_aggregate_entries: p.maxAggregateEntries,
            max_union_accounts: p.maxUnionAccounts,
            max_aggregate_blob_bytes: p.maxAggregateBlobBytes,
            max_source_age_blocks: p.maxSourceAgeBlocks,
            accumulator: p.accumulator,
            chain_id: p.chainId,
        })),
        other => bail!("unsupported composition params version {other}"),
    }
}

/// Everything an `InstanceState` needs from one snapshot, read in one place.
pub struct SnapshotView {
    pub params_hash: B256,
    pub zk_verifier: Address,
    /// Read off the snapshot rather than the registry row: `setAccumulator` is constitutional and
    /// the directory copy may lag it, and proving against the wrong lane is unrecoverable.
    pub accumulator: Address,
    pub anchor_registry: Address,
    pub epoch_length: u64,
    pub last_trigger_block: u64,
    pub last_applied: Option<u64>,
    pub instance_domain: B256,
    pub checkpoints: Vec<CheckpointRef>,
    pub live: Commitments,
    /// Current authenticated lane-2 work, raw anchor count for legacy registries.
    pub live_anchor_work: u64,
    /// Present on capacity-bounded AnchorRegistry deployments. A legacy lane-2 implementation may
    /// expose only `anchorAcc`/`anchorCount`, in which case the operator uses its global ceiling.
    pub input_capacity: Option<u64>,
}

/// The chain facts that bind one landed checkpoint to the bytes a repair command reconstructs.
pub struct LandedPublication {
    pub submitted_block: u64,
    pub output_root: B256,
    pub ipfs_hash: B256,
    pub cid: String,
    pub total_value: U256,
    pub recipient: Address,
}

/// How many trailing checkpoints to read. Only the newest unproven one is ever proved, so a full
/// history walk would be pure RPC cost — but reading a few gives the coalescing branch something
/// to coalesce and makes a stale `lastApplied` visible.
const CHECKPOINT_WINDOW: u64 = 8;

/// First 32-byte word of an `eth_call` return, or an error. A short or empty `0x` return from a
/// lagging/flaky provider is a TRANSIENT read failure (M-10, 2026-08-13 audit) — it must surface
/// as an `Err` the tick loop already tolerates (`instance_unreadable`, next tick re-reads),
/// never as a slice panic that kills the whole daemon.
fn word32(ret: &[u8], what: &str) -> Result<B256> {
    anyhow::ensure!(
        ret.len() >= 32,
        "{what}: short eth_call return ({} bytes) — transient provider error, not decoded",
        ret.len()
    );
    Ok(B256::from_slice(&ret[..32]))
}

fn word_addr(ret: &[u8], what: &str) -> Result<Address> {
    Ok(Address::from_slice(&word32(ret, what)?.as_slice()[12..32]))
}

fn word_u64(ret: &[u8], what: &str) -> Result<u64> {
    Ok(U256::from_be_slice(word32(ret, what)?.as_slice()).to::<u64>())
}

pub fn read_snapshot(rpc: &Rpc, snapshot: Address) -> Result<SnapshotView> {
    let b32 = |data: Vec<u8>, what: &str| -> Result<B256> {
        word32(&rpc.eth_call(snapshot, data)?, what)
    };
    let addr = |data: Vec<u8>, what: &str| -> Result<Address> {
        word_addr(&rpc.eth_call(snapshot, data)?, what)
    };
    let u64v = |data: Vec<u8>, what: &str| -> Result<u64> {
        word_u64(&rpc.eth_call(snapshot, data)?, what)
    };

    let params_hash = b32(paramsHashCall {}.abi_encode(), "paramsHash")?;
    let zk_verifier = addr(zkVerifierCall {}.abi_encode(), "zkVerifier")?;
    let accumulator = addr(accumulatorCall {}.abi_encode(), "accumulator")?;
    let anchor_registry = addr(anchorRegistryCall {}.abi_encode(), "anchorRegistry")?;
    let epoch_length = u64v(epochLengthCall {}.abi_encode(), "epochLength")?;
    let last_trigger_block = u64v(lastTriggerBlockCall {}.abi_encode(), "lastTriggerBlock")?;
    let instance_domain = b32(instanceDomainCall {}.abi_encode(), "instanceDomain")?;

    let has_applied = {
        let ret = rpc.eth_call(snapshot, hasAppliedCheckpointCall {}.abi_encode())?;
        ret.last().is_some_and(|b| *b == 1)
    };
    let last_applied = if has_applied {
        Some(u64v(lastAppliedCheckpointCall {}.abi_encode(), "lastAppliedCheckpoint")?)
    } else {
        None
    };

    // Checkpoints, newest-window only.
    let count = {
        let ret = rpc.eth_call(accumulator, checkpointCountCall {}.abi_encode())?;
        word_u64(&ret, "checkpointCount")?
    };
    let mut checkpoints = Vec::new();
    let start = count.saturating_sub(CHECKPOINT_WINDOW);
    for id in start..count {
        let ret = rpc
            .eth_call(accumulator, getCheckpointCall { id: U256::from(id) }.abi_encode())
            .with_context(|| format!("getCheckpoint({id})"))?;
        let c = getCheckpointCall::abi_decode_returns(&ret)?;
        let ac = {
            let r = rpc.eth_call(
                snapshot,
                anchorCheckpointsCall { checkpointId: U256::from(id) }.abi_encode(),
            )?;
            anchorCheckpointsCall::abi_decode_returns(&r)?
        };
        let pinned = {
            let r = rpc.eth_call(
                snapshot,
                checkpointParamsHashCall { checkpointId: U256::from(id) }.abi_encode(),
            )?;
            let h = word32(&r, "checkpointParamsHash")?;
            // Zero is the "not pinned" sentinel: this checkpoint was minted outside `trigger()`
            // and `submitProof` would revert `UnpinnedCheckpoint`.
            (h != B256::ZERO).then_some(h)
        };
        let work_count = rpc
            .eth_call(
                snapshot,
                checkpointWorkCountCall { checkpointId: U256::from(id) }.abi_encode(),
            )
            .ok()
            .and_then(|returned| word_u64(&returned, "checkpointWorkCount").ok())
            .filter(|work| *work >= ac.anchorCount)
            .unwrap_or(ac.anchorCount);
        checkpoints.push(CheckpointRef {
            id,
            block_number: c.blockNumber,
            commitments: Commitments {
                acc: c.acc,
                leaf_count: c.leafCount,
                anchor_acc: ac.anchorAcc,
                anchor_count: ac.anchorCount,
            },
            work_count,
            pinned_params_hash: pinned,
        });
    }

    // Live commitments, for the quiet check.
    let live_acc = {
        let r = rpc.eth_call(accumulator, accCall {}.abi_encode())?;
        word32(&r, "acc")?
    };
    let live_leaves = {
        let r = rpc.eth_call(accumulator, leafCountCall {}.abi_encode())?;
        word_u64(&r, "leafCount")?
    };
    let (live_anchor_acc, live_anchor_count) = if anchor_registry == Address::ZERO {
        (B256::ZERO, 0u64)
    } else {
        let a = rpc.eth_call(anchor_registry, anchorAccCall {}.abi_encode())?;
        let n = rpc.eth_call(anchor_registry, anchorCountCall {}.abi_encode())?;
        (word32(&a, "anchorAcc")?, word_u64(&n, "anchorCount")?)
    };
    let live_anchor_work = if anchor_registry == Address::ZERO {
        0
    } else {
        rpc.eth_call(anchor_registry, workCountCall {}.abi_encode())
            .ok()
            .and_then(|returned| word_u64(&returned, "workCount").ok())
            .filter(|work| *work >= live_anchor_count)
            .unwrap_or(live_anchor_count)
    };
    let input_capacity = if anchor_registry == Address::ZERO {
        None
    } else {
        // Legacy registries and ContributionResolver expose the checkpoint words but not the new
        // immutable ingress ceiling. Keep them operable at the global limit; a malformed response
        // likewise cannot kill every scheduler tick.
        rpc.eth_call(anchor_registry, maxTotalInputsCall {}.abi_encode())
            .ok()
            .and_then(|ret| word_u64(&ret, "maxTotalInputs").ok())
            .filter(|capacity| *capacity > 0)
    };

    Ok(SnapshotView {
        params_hash,
        zk_verifier,
        accumulator,
        anchor_registry,
        epoch_length,
        last_trigger_block,
        last_applied,
        instance_domain,
        checkpoints,
        live: Commitments {
            acc: live_acc,
            leaf_count: live_leaves,
            anchor_acc: live_anchor_acc,
            anchor_count: live_anchor_count,
        },
        live_anchor_work,
        input_capacity,
    })
}

/// Read a derived signer program from its module and its registered score source. Signer work is
/// intentionally downstream: only score checkpoints that have actually landed are exposed to the
/// planner, and this derived program never calls `trigger()` itself.
pub fn read_signer_view(
    rpc: &Rpc,
    entry: &CatalogEntry,
    chain_id: u64,
) -> Result<(SnapshotView, bool)> {
    anyhow::ensure!(
        entry.program == operator_core::types::Program::Signer,
        "read_signer_view called for {}",
        entry.program.name()
    );
    let module = entry.submit_to;
    let source = match rpc.eth_call(module, scoreSnapshotCall {}.abi_encode()) {
        Ok(returned) => word_addr(&returned, "signer.scoreSnapshot")?,
        // Pre-factory modules did not expose scoreSnapshot(); their manifest's snapshot field is
        // the explicit trust instance they follow. New event-derived modules must always expose
        // the getter, so the same failure remains fatal for the zero-config path.
        Err(_) if entry.manifest.is_some() => entry.snapshot,
        Err(error) => return Err(error).context("read signer.scoreSnapshot"),
    };
    anyhow::ensure!(
        source == entry.snapshot,
        "signer module {module:#x} follows {source:#x}, catalog event names {:#x}",
        entry.snapshot
    );

    let mut view = read_snapshot(rpc, source)?;
    let module_accumulator =
        word_addr(&rpc.eth_call(module, accumulatorCall {}.abi_encode())?, "signer.accumulator")?;
    anyhow::ensure!(
        module_accumulator == view.accumulator && module_accumulator == entry.accumulator,
        "signer accumulator {module_accumulator:#x} disagrees with score source {:#x} or catalog {:#x}",
        view.accumulator,
        entry.accumulator
    );
    let selection_hash = word32(
        &rpc.eth_call(module, selectionParamsHashCall {}.abi_encode())?,
        "signer.selectionParamsHash",
    )?;
    if let Some(selection) = entry.selection.as_ref() {
        let expected_selection = pagerank_core::encode::selection_params_hash(selection);
        anyhow::ensure!(
            selection_hash == expected_selection,
            "signer selection hash {selection_hash:#x} differs from event tuple {expected_selection:#x}"
        );
    }
    let module_verifier =
        word_addr(&rpc.eth_call(module, zkVerifierCall {}.abi_encode())?, "signer.zkVerifier")?;
    if let Some(event_vkey) = entry.program_vkey {
        let live_vkey = verifier_vkey(rpc, module_verifier)?;
        anyhow::ensure!(
            live_vkey == event_vkey,
            "signer verifier now reports vkey {live_vkey:#x}, creation event pinned {event_vkey:#x}"
        );
    }
    let paused = match rpc.eth_call(module, pausedCall {}.abi_encode()) {
        Ok(returned) => pausedCall::abi_decode_returns(&returned)?,
        // The deliberate pause gate was added with governed-factory discovery. A legacy module
        // can still be stopped by disabling it on the Safe, but has no separate pause view.
        Err(_) if entry.manifest.is_some() => false,
        Err(error) => return Err(error).context("read signer.paused"),
    };
    let has_applied = hasAppliedCheckpointCall::abi_decode_returns(
        &rpc.eth_call(module, hasAppliedCheckpointCall {}.abi_encode())?,
    )?;
    let signer_last = if has_applied {
        Some(word_u64(
            &rpc.eth_call(module, lastAppliedCheckpointCall {}.abi_encode())?,
            "signer.lastAppliedCheckpoint",
        )?)
    } else {
        None
    };

    // A signer rotation follows a score receipt; it cannot lead one. Once both are caught up,
    // matching live/applied commitments makes the planner report Quiet. Before the first score,
    // the saturated epoch gate keeps the derived instance from minting a checkpoint itself.
    let score_last = view.last_applied;
    if let Some(last) = score_last {
        if let Some(checkpoint) = view.checkpoints.iter().find(|checkpoint| checkpoint.id == last) {
            // Inputs admitted after the latest landed score root are not signer work yet. Keep
            // both the quiet check and the loss estimate scoped to the exact score receipt this
            // derived program is allowed to follow.
            view.live = checkpoint.commitments;
            view.live_anchor_work = checkpoint.work_count;
        }
    }
    view.checkpoints.retain(|checkpoint| score_last.is_some_and(|last| checkpoint.id <= last));
    view.last_applied = signer_last;
    view.zk_verifier = module_verifier;
    view.instance_domain = expected_instance_domain(module, chain_id);
    view.epoch_length = u64::MAX;
    view.live.anchor_acc = B256::ZERO;
    view.live.anchor_count = 0;
    view.live_anchor_work = 0;
    view.input_capacity = None;
    Ok((view, paused))
}

/// Read one checkpoint directly, including ids older than the daemon's trailing scheduling
/// window. The repair command is explicitly historical and cannot silently inherit that window.
pub fn read_checkpoint(rpc: &Rpc, snapshot: Address, checkpoint_id: u64) -> Result<CheckpointRef> {
    let accumulator =
        word_addr(&rpc.eth_call(snapshot, accumulatorCall {}.abi_encode())?, "accumulator")?;
    let ret = rpc
        .eth_call(accumulator, getCheckpointCall { id: U256::from(checkpoint_id) }.abi_encode())
        .with_context(|| format!("getCheckpoint({checkpoint_id})"))?;
    let checkpoint = getCheckpointCall::abi_decode_returns(&ret)?;
    let anchors = anchorCheckpointsCall::abi_decode_returns(&rpc.eth_call(
        snapshot,
        anchorCheckpointsCall { checkpointId: U256::from(checkpoint_id) }.abi_encode(),
    )?)?;
    let pinned = word32(
        &rpc.eth_call(
            snapshot,
            checkpointParamsHashCall { checkpointId: U256::from(checkpoint_id) }.abi_encode(),
        )?,
        "checkpointParamsHash",
    )?;
    let work_count = rpc
        .eth_call(
            snapshot,
            checkpointWorkCountCall { checkpointId: U256::from(checkpoint_id) }.abi_encode(),
        )
        .ok()
        .and_then(|returned| word_u64(&returned, "checkpointWorkCount").ok())
        .filter(|work| *work >= anchors.anchorCount)
        .unwrap_or(anchors.anchorCount);
    Ok(CheckpointRef {
        id: checkpoint_id,
        block_number: checkpoint.blockNumber,
        commitments: Commitments {
            acc: checkpoint.acc,
            leaf_count: checkpoint.leafCount,
            anchor_acc: anchors.anchorAcc,
            anchor_count: anchors.anchorCount,
        },
        work_count,
        pinned_params_hash: (pinned != B256::ZERO).then_some(pinned),
    })
}

/// Recover the exact canonical TGCM preimage stored by the composition accumulator. A caller may
/// request the current preflight view (`None`) or a durable historical checkpoint (`Some`).
pub fn read_composition_manifest(
    rpc: &Rpc,
    accumulator: Address,
    checkpoint_id: Option<u64>,
) -> Result<Vec<u8>> {
    let returned = match checkpoint_id {
        Some(id) => rpc.eth_call(
            accumulator,
            getCaptureManifestCall { checkpointId: U256::from(id) }.abi_encode(),
        )?,
        None => rpc.eth_call(accumulator, currentCaptureManifestCall {}.abi_encode())?,
    };
    let manifest = match checkpoint_id {
        Some(_) => getCaptureManifestCall::abi_decode_returns(&returned)?,
        None => currentCaptureManifestCall::abi_decode_returns(&returned)?,
    };
    anyhow::ensure!(!manifest.is_empty(), "composition capture manifest is empty");
    Ok(manifest.to_vec())
}

/// Find the proof-submission event for a checkpoint and read the exact state filed at that
/// checkpoint's input-freeze block. `getStateAtBlock` is an at-or-before lookup, so equality is
/// checked explicitly; otherwise an unknown checkpoint could be mistaken for an older root.
pub fn read_landed_publication(
    rpc: &Rpc,
    snapshot: Address,
    checkpoint_id: u64,
    checkpoint_block: u64,
    from_block: u64,
    head: u64,
) -> Result<LandedPublication> {
    let logs =
        rpc.logs(snapshot, MerkleProofSubmitted::SIGNATURE_HASH, from_block, head, 10_000)?;
    let mut matches = Vec::new();
    for log in logs {
        let event = MerkleProofSubmitted::decode_raw_log(log.topics.iter().copied(), &log.data)?;
        if event.checkpointId.to::<u64>() == checkpoint_id {
            matches.push((log.block_number, event));
        }
    }
    anyhow::ensure!(
        matches.len() == 1,
        "checkpoint {checkpoint_id} has {} MerkleProofSubmitted events; expected exactly one landed root",
        matches.len()
    );
    let (submitted_block, event) = matches.pop().expect("length checked");
    let state = getStateAtBlockCall::abi_decode_returns(&rpc.eth_call(
        snapshot,
        getStateAtBlockCall { blockNumber: U256::from(checkpoint_block) }.abi_encode(),
    )?)?;
    anyhow::ensure!(
        state.blockNumber.to::<u64>() == checkpoint_block,
        "state lookup for checkpoint {checkpoint_id} returned input block {}, expected its checkpoint block {checkpoint_block}",
        state.blockNumber
    );
    anyhow::ensure!(
        state.root == event.root,
        "MerkleProofSubmitted root {:#x} disagrees with state root {:#x}",
        event.root,
        state.root
    );
    let mapped_recipient = word_addr(
        &rpc.eth_call(
            snapshot,
            checkpointRecipientCall { checkpointId: U256::from(checkpoint_id) }.abi_encode(),
        )?,
        "checkpointRecipient",
    )?;
    anyhow::ensure!(
        mapped_recipient == event.recipient,
        "checkpoint recipient {mapped_recipient:#x} disagrees with submission event {:#x}",
        event.recipient
    );
    Ok(LandedPublication {
        submitted_block,
        output_root: state.root,
        ipfs_hash: state.ipfsHash,
        cid: state.ipfsHashCid,
        total_value: state.totalValue,
        recipient: event.recipient,
    })
}

/// Select the complete parameter tuple pinned to a historical checkpoint. Typed controller
/// events carry every field, so rotation does not make old roots irreconstructible.
pub fn entry_at_params_hash(
    rpc: &Rpc,
    entry: &CatalogEntry,
    params_hash: B256,
    head: u64,
) -> Result<CatalogEntry> {
    if entry.reconstructed_params_hash == params_hash {
        return Ok(entry.clone());
    }
    let controller = entry.params_controller.ok_or_else(|| {
        anyhow!(
            "checkpoint pins historical params {params_hash:#x}, but {} has no typed params controller history",
            entry.name
        )
    })?;
    if entry.program == operator_core::types::Program::Composition {
        for log in rpc.logs(
            controller,
            PolicyActivated::SIGNATURE_HASH,
            entry.created_block,
            head,
            10_000,
        )? {
            let event = PolicyActivated::decode_raw_log(log.topics.iter().copied(), &log.data)?;
            if event.instanceId != entry.instance_id || event.paramsHash != params_hash {
                continue;
            }
            let params = to_composition_params(&event.params)?;
            params
                .validate()
                .map_err(|error| anyhow!("invalid historical composition params: {error}"))?;
            let reconstructed = params.params_hash();
            anyhow::ensure!(
                reconstructed == params_hash,
                "composition activation tuple encodes {reconstructed:#x}, but names {params_hash:#x}"
            );
            let mut historical = entry.clone();
            historical.params = None;
            historical.contributions_params = None;
            historical.weighted_params = None;
            historical.composition_params = Some(params);
            historical.reconstructed_params_hash = reconstructed;
            historical.params_version = Some(event.version);
            return Ok(historical);
        }
        for log in rpc.logs(
            controller,
            InitialPolicyPublished::SIGNATURE_HASH,
            entry.created_block,
            head,
            10_000,
        )? {
            let event =
                InitialPolicyPublished::decode_raw_log(log.topics.iter().copied(), &log.data)?;
            if event.instanceId != entry.instance_id || event.paramsHash != params_hash {
                continue;
            }
            let params = to_composition_params(&event.params)?;
            params
                .validate()
                .map_err(|error| anyhow!("invalid initial composition params: {error}"))?;
            let reconstructed = params.params_hash();
            anyhow::ensure!(
                reconstructed == params_hash,
                "initial composition event tuple hash mismatch"
            );
            let mut historical = entry.clone();
            historical.params = None;
            historical.contributions_params = None;
            historical.weighted_params = None;
            historical.composition_params = Some(params);
            historical.reconstructed_params_hash = reconstructed;
            historical.params_version = Some(event.version);
            return Ok(historical);
        }
        bail!(
            "no composition policy publication/activation event for instance {:#x} and pinned hash {params_hash:#x}",
            entry.instance_id
        );
    }
    if entry.program == operator_core::types::Program::Weighted {
        for log in
            rpc.logs(controller, PriorActivated::SIGNATURE_HASH, entry.created_block, head, 10_000)?
        {
            let event = PriorActivated::decode_raw_log(log.topics.iter().copied(), &log.data)?;
            if event.instanceId != entry.instance_id || event.paramsHash != params_hash {
                continue;
            }
            let params = to_weighted_params(&event.params);
            let reconstructed = weighted_prior_core::encode::params_hash(&params);
            anyhow::ensure!(
                reconstructed == params_hash,
                "weighted activation tuple encodes {reconstructed:#x}, but names {params_hash:#x}"
            );
            let mut historical = entry.clone();
            historical.params = None;
            historical.contributions_params = None;
            historical.weighted_params = Some(params);
            historical.composition_params = None;
            historical.reconstructed_params_hash = reconstructed;
            historical.params_version = Some(event.version);
            return Ok(historical);
        }
        // V1 is published rather than activated, and can be historical after the first rotation.
        for log in rpc.logs(
            controller,
            InitialPriorPublished::SIGNATURE_HASH,
            entry.created_block,
            head,
            10_000,
        )? {
            let event =
                InitialPriorPublished::decode_raw_log(log.topics.iter().copied(), &log.data)?;
            if event.instanceId != entry.instance_id || event.paramsHash != params_hash {
                continue;
            }
            let params = to_weighted_params(&event.params);
            let reconstructed = weighted_prior_core::encode::params_hash(&params);
            anyhow::ensure!(reconstructed == params_hash, "weighted V1 event tuple hash mismatch");
            let mut historical = entry.clone();
            historical.params = None;
            historical.contributions_params = None;
            historical.weighted_params = Some(params);
            historical.composition_params = None;
            historical.reconstructed_params_hash = reconstructed;
            historical.params_version = Some(event.version);
            return Ok(historical);
        }
        bail!(
            "no weighted prior publication/activation event for instance {:#x} and pinned hash {params_hash:#x}",
            entry.instance_id
        );
    }

    let event_signature = match entry.program {
        operator_core::types::Program::Contributions => ContributionsParamsUpdated::SIGNATURE_HASH,
        _ => ParamsUpdated::SIGNATURE_HASH,
    };
    let logs = rpc.logs(controller, event_signature, entry.created_block, head, 10_000)?;
    let controller_instance_id = entry.parent_instance_id.unwrap_or(entry.instance_id);
    for log in logs {
        if entry.program == operator_core::types::Program::Contributions {
            let event =
                ContributionsParamsUpdated::decode_raw_log(log.topics.iter().copied(), &log.data)?;
            if event.instanceId != controller_instance_id || event.paramsHash != params_hash {
                continue;
            }
            let params = to_contributions_params(&event.params);
            let reconstructed = contributions_core::params::params_hash(&params);
            anyhow::ensure!(
                reconstructed == params_hash,
                "contributions controller event tuple encodes {reconstructed:#x}, but names {params_hash:#x}"
            );
            let mut historical = entry.clone();
            historical.params = None;
            historical.contributions_params = Some(params);
            historical.weighted_params = None;
            historical.composition_params = None;
            historical.reconstructed_params_hash = reconstructed;
            historical.params_version = Some(event.version);
            return Ok(historical);
        } else {
            let event = ParamsUpdated::decode_raw_log(log.topics.iter().copied(), &log.data)?;
            if event.instanceId != controller_instance_id || event.paramsHash != params_hash {
                continue;
            }
            let params = to_core_params(&event.params);
            let reconstructed = pagerank_core::encode::params_hash(&params);
            anyhow::ensure!(
                reconstructed == params_hash,
                "controller event tuple encodes {reconstructed:#x}, but names {params_hash:#x}"
            );
            let mut historical = entry.clone();
            historical.params = Some(params);
            historical.contributions_params = None;
            historical.weighted_params = None;
            historical.composition_params = None;
            historical.reconstructed_params_hash = reconstructed;
            historical.params_version = Some(event.version);
            return Ok(historical);
        }
    }
    bail!(
        "no ParamsUpdated event for instance {:#x} and pinned hash {params_hash:#x}",
        entry.instance_id
    )
}

/// Find the transaction whose calldata carries the exact TGWP bytes for one params version.
/// Activation calldata carries only a version number, so version > 1 resolves through the earlier
/// `PriorProposed` event, never through the activation transaction.
pub fn weighted_manifest_source_tx(rpc: &Rpc, entry: &CatalogEntry, head: u64) -> Result<B256> {
    anyhow::ensure!(
        entry.program == operator_core::types::Program::Weighted,
        "manifest source requested for non-weighted program {}",
        entry.program.name()
    );
    let controller =
        entry.params_controller.ok_or_else(|| anyhow!("weighted entry has no controller"))?;
    let version =
        entry.params_version.ok_or_else(|| anyhow!("weighted entry has no params version"))?;
    let expected_hash = entry.reconstructed_params_hash;
    if version == 1 {
        for log in rpc.logs(
            controller,
            InitialPriorPublished::SIGNATURE_HASH,
            entry.created_block,
            head,
            10_000,
        )? {
            let event =
                InitialPriorPublished::decode_raw_log(log.topics.iter().copied(), &log.data)?;
            if event.instanceId == entry.instance_id
                && event.version == version
                && event.paramsHash == expected_hash
            {
                return Ok(log.transaction_hash);
            }
        }
    } else {
        for log in
            rpc.logs(controller, PriorProposed::SIGNATURE_HASH, entry.created_block, head, 10_000)?
        {
            let event = PriorProposed::decode_raw_log(log.topics.iter().copied(), &log.data)?;
            if event.instanceId == entry.instance_id
                && event.version == version
                && event.paramsHash == expected_hash
            {
                return Ok(log.transaction_hash);
            }
        }
    }
    bail!(
        "no manifest-bearing transaction for weighted instance {:#x} version {version} params {expected_hash:#x}",
        entry.instance_id
    )
}

/// Materialize the pending version's complete tuple from the live immutable envelope plus the
/// controller's committed prior fields. This is used only to prefetch/pin bytes; checkpoints can
/// never select it until activation atomically moves the snapshot hash.
pub fn weighted_pending_entry(rpc: &Rpc, entry: &CatalogEntry) -> Result<Option<CatalogEntry>> {
    anyhow::ensure!(
        entry.program == operator_core::types::Program::Weighted,
        "pending prior requested for non-weighted program"
    );
    let controller =
        entry.params_controller.ok_or_else(|| anyhow!("weighted entry has no controller"))?;
    let pending = getPendingPriorCall::abi_decode_returns(
        &rpc.eth_call(controller, getPendingPriorCall {}.abi_encode())?,
    )?;
    if pending.version == 0 {
        return Ok(None);
    }
    let mut params = entry
        .weighted_params
        .clone()
        .ok_or_else(|| anyhow!("weighted entry has no params tuple"))?;
    params.prior_root = pending.priorRoot;
    params.prior_count = pending.priorCount;
    params.manifest_sha256 = pending.manifestSha256;
    let reconstructed = weighted_prior_core::encode::params_hash(&params);
    anyhow::ensure!(
        reconstructed == pending.paramsHash,
        "pending weighted tuple encodes {reconstructed:#x}, controller names {:#x}",
        pending.paramsHash
    );
    anyhow::ensure!(
        pending.version == entry.params_version.unwrap_or_default() + 1,
        "pending weighted version {} is stale relative to active {:?}",
        pending.version,
        entry.params_version
    );
    let mut pending_entry = entry.clone();
    pending_entry.weighted_params = Some(params);
    pending_entry.reconstructed_params_hash = reconstructed;
    pending_entry.params_version = Some(pending.version);
    Ok(Some(pending_entry))
}

/// Decode only the authorized transaction-input shapes that can carry canonical TGWP bytes.
/// Governed creation is a top-level wrapper call: its transaction emits the base factory's
/// `InitialPriorPublished` event through an internal Safe execution, but its outer selector and
/// tuple shape are not `createInstance`.
pub fn weighted_manifest_from_calldata(input: &[u8]) -> Result<Vec<u8>> {
    if input.starts_with(&createInstanceCall::SELECTOR) {
        return Ok(createInstanceCall::abi_decode(input)?.args.manifest.to_vec());
    }
    if input.starts_with(&createGovernedInstanceCall::SELECTOR) {
        return Ok(createGovernedInstanceCall::abi_decode(input)?.requested.manifest.to_vec());
    }
    if input.starts_with(&proposePriorCall::SELECTOR) {
        return Ok(proposePriorCall::abi_decode(input)?.manifest.to_vec());
    }
    bail!(
        "manifest source transaction selector 0x{} is not weighted createInstance, createGovernedInstance, or proposePrior",
        hex::encode(input.get(..4).unwrap_or(input))
    )
}

#[cfg(test)]
mod weighted_calldata_tests {
    use super::*;

    fn params() -> SolWeightedParams {
        SolWeightedParams {
            version: 1,
            dampingFp: 850_000_000_000_000_000,
            toleranceFp: 0,
            maxIterations: 40,
            minWeight: 0,
            maxWeight: 100,
            priorRoot: B256::from([0x11; 32]),
            priorCount: 1,
            manifestSha256: B256::from([0x22; 32]),
            schemaUid: B256::from([0x33; 32]),
            weightFieldIndex: 1,
            accumulator: Address::from([0x44; 20]),
            chainId: 10,
        }
    }

    #[test]
    fn extracts_exact_bytes_from_direct_creation_and_proposal_calldata() {
        let manifest = b"TGWP exact bytes".to_vec();
        let creation = createInstanceCall {
            args: WeightedCreateArgs {
                name: "weighted".into(),
                metadataURI: String::new(),
                params: params(),
                manifest: manifest.clone().into(),
                metadataDigest: B256::ZERO,
                admin: Address::from([0x55; 20]),
                epochLength: 10,
                withDistributor: false,
                distributorToken: Address::ZERO,
                salt: B256::ZERO,
            },
        }
        .abi_encode();
        assert_eq!(weighted_manifest_from_calldata(&creation).unwrap(), manifest);

        let proposal = proposePriorCall {
            manifest: manifest.clone().into(),
            metadataDigest: B256::from([0x66; 32]),
        }
        .abi_encode();
        assert_eq!(weighted_manifest_from_calldata(&proposal).unwrap(), manifest);
    }

    #[test]
    fn extracts_exact_bytes_from_governed_creation_calldata() {
        let manifest = b"TGWP governed exact bytes".to_vec();
        let creation = createGovernedInstanceCall {
            requested: WeightedCreateArgs {
                name: "governed weighted".into(),
                metadataURI: String::new(),
                params: params(),
                manifest: manifest.clone().into(),
                metadataDigest: B256::ZERO,
                admin: Address::ZERO,
                epochLength: 10,
                withDistributor: false,
                distributorToken: Address::ZERO,
                salt: B256::ZERO,
            },
            policy: WeightedInitialPolicy {
                minPaidIntervalBlocks: 10,
                maxPerRootUsd: Default::default(),
            },
            signerSync: WeightedSignerSyncConfig {
                enabled: false,
                topN: 0,
                minThreshold: 0,
                targetThresholdBps: 0,
            },
        }
        .abi_encode();

        assert_eq!(&creation[..4], &[0x19, 0x00, 0x0a, 0xfc]);
        assert_eq!(weighted_manifest_from_calldata(&creation).unwrap(), manifest);
    }

    #[test]
    fn refuses_unrelated_transaction_input() {
        let error =
            weighted_manifest_from_calldata(&[0xde, 0xad, 0xbe, 0xef]).unwrap_err().to_string();
        assert!(
            error.contains("not weighted createInstance, createGovernedInstance, or proposePrior")
        );
    }
}

/// The vkey a deployed verifier is pinned to. Checked at startup against the guest this binary was
/// built from, so a mismatch is a refusal to start rather than a failed submit later.
pub fn verifier_vkey(rpc: &Rpc, verifier: Address) -> Result<B256> {
    let ret = rpc.eth_call(verifier, programVKeyCall {}.abi_encode())?;
    word32(&ret, "programVKey")
}

/// Calldata for `trigger()`.
pub fn trigger_calldata() -> Vec<u8> {
    triggerCall {}.abi_encode()
}

/// Calldata for journal-v3 `submitProof`.
#[allow(clippy::too_many_arguments)]
pub fn submit_calldata(
    checkpoint_id: u64,
    output_root: B256,
    ipfs_hash: B256,
    cid: String,
    total_value: U256,
    skipped_digest: B256,
    recipient: Address,
    proof: Vec<u8>,
) -> Vec<u8> {
    submitProofCall {
        checkpointId: U256::from(checkpoint_id),
        outputRoot: output_root,
        ipfsHash: ipfs_hash,
        ipfsHashCid: cid,
        totalValue: total_value,
        skippedDigest: skipped_digest,
        recipient,
        proof: proof.into(),
    }
    .abi_encode()
}

/// Calldata for the derived signer program. Unlike a score root, the receipt carries the complete
/// owner set and needs no IPFS publication step.
pub fn submit_signer_calldata(
    checkpoint_id: u64,
    activity_checkpoint_id: u64,
    signers: Vec<Address>,
    target_threshold: U256,
    proof: Vec<u8>,
) -> Vec<u8> {
    submitSignerProofCall {
        checkpointId: U256::from(checkpoint_id),
        activityCheckpointId: U256::from(activity_checkpoint_id),
        signers,
        targetThreshold: target_threshold,
        proof: proof.into(),
    }
    .abi_encode()
}

/// Calldata for the funded path: `ProvingVault.submitAndClaim`.
///
/// `minPayoutUsd` is the prover's own guard and the reason this is not just `submitProof` with a
/// wrapper. Below it the whole call reverts, so a community that zeroes its policy in the same
/// block gets a reverted transaction rather than a free root — and the checkpoint stays claimable.
#[allow(clippy::too_many_arguments)]
pub fn submit_and_claim_calldata(
    instance_id: B256,
    checkpoint_id: u64,
    output_root: B256,
    ipfs_hash: B256,
    cid: String,
    total_value: U256,
    skipped_digest: B256,
    recipient: Address,
    proof: Vec<u8>,
    min_payout_usd: U256,
) -> Vec<u8> {
    submitAndClaimCall {
        instanceId: instance_id,
        args: SubmitArgs {
            checkpointId: U256::from(checkpoint_id),
            outputRoot: output_root,
            ipfsHash: ipfs_hash,
            ipfsHashCid: cid,
            totalValue: total_value,
            skippedDigest: skipped_digest,
            recipient,
            proof: proof.into(),
            minPayoutUsd: min_payout_usd,
        },
    }
    .abi_encode()
}

/// The domain the journal must commit for this instance, derived exactly as `submitProof` rebuilds
/// it. Read from the contract when possible; this is the local check that the two agree.
pub fn expected_instance_domain(snapshot: Address, chain_id: u64) -> B256 {
    keccak256((snapshot, U256::from(chain_id)).abi_encode())
}
